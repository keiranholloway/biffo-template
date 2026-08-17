"""Router tests for the internal scope-authorization seam (ADR-0029, issue
#1607 steps 1-2) — ``GET /internal/scopes`` and ``POST /internal/scope-check``.

Executes the issue's fail-first cases over real HTTP through a FastAPI
``TestClient``, not by calling the registry functions directly, so these
prove the denial is enforced by the server, not merely by a library function
a client could choose not to call.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from api import scope_authz as authz
from api.database import get_db
from api.middleware.auth import AuthenticatedUser
from api.middleware.principal import Principal, require_principal
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.routers.internal_scopes import router
from fastapi import FastAPI
from fastapi.testclient import TestClient

_MARKETING_ARN = "arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-marketing-role/s"
_PERMISSION_CODE = "marketing.links.manage"


def _founder(sub: str, permissions: frozenset[str] = frozenset()) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub=sub,
        email=f"{sub}@x.com",
        username=sub,
        tenant_id="default",
        permissions=permissions,
    )


async def _override_get_db() -> AsyncGenerator:
    yield None  # the fake authorizers registered in these tests never touch the db


def _client(*, founder: AuthenticatedUser, principal_arn: str = _MARKETING_ARN) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_db] = _override_get_db
    # Both halves of require_signed_principal, exactly as test_owner_data.py
    # stands them in — the verified forwarded user, and the SigV4 service.
    app.dependency_overrides[require_principal] = lambda: Principal(user=founder)
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn=principal_arn
    )
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_registry():
    saved = (
        authz._authorizer,  # noqa: SLF001
        authz._ancestry_resolver,  # noqa: SLF001
        authz._describer,  # noqa: SLF001
        authz._registered,  # noqa: SLF001
    )
    yield
    (
        authz._authorizer,  # noqa: SLF001
        authz._ancestry_resolver,  # noqa: SLF001
        authz._describer,  # noqa: SLF001
        authz._registered,  # noqa: SLF001
    ) = saved


def _force_unregistered() -> None:
    authz._authorizer = authz._default_authorizer  # noqa: SLF001
    authz._ancestry_resolver = authz._default_ancestry  # noqa: SLF001
    authz._describer = authz._default_describer  # noqa: SLF001
    authz._registered = False  # noqa: SLF001


# ── fail-first case 1: a caller with the scope → allowed ────────────────────


def test_caller_with_the_scope_is_allowed():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    authz.register_scope_authorizer(authorizer)

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"allowed": True, "resolved": True, "reason": None}


# ── fail-first case 2: a caller without the scope → denied, server-side ─────


def test_caller_without_the_scope_is_denied_server_side():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-1"}))  # not unit-9

    authz.register_scope_authorizer(authorizer)

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    # A 200 carrying allowed=False — not a client-computed hint. The client
    # sent nothing this server trusted about the answer; the denial came back
    # from the server's own registry call.
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["allowed"] is False
    assert body["resolved"] is True


def test_no_service_principal_is_refused_before_any_scope_logic_runs():
    """A browser holding nothing but a bearer token cannot reach this route
    at all — require_signed_principal's service gate, exercised for real."""
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[require_principal] = lambda: Principal(
        user=_founder("alice", permissions=frozenset({_PERMISSION_CODE}))
    )
    # Deliberately NOT overriding require_service_principal: no SigV4 context
    # is present in this test process, so the real dependency runs and must
    # refuse (401/403) rather than the route silently proceeding.
    client = TestClient(app)
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    assert resp.status_code in (401, 403), resp.text


# ── fail-first case 3: bare core → denied, and distinguishable from allowed ─


def test_bare_core_scope_check_is_denied_and_marked_unresolved_over_http():
    _force_unregistered()

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["allowed"] is False
    assert body["resolved"] is False  # "could not resolve" — never confused with "checked, no"
    assert body["reason"] == "no scope authorizer registered"


def test_bare_core_scope_listing_is_denied_and_marked_unresolved_over_http():
    _force_unregistered()

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"scopes": [], "resolved": False, "checked": 0, "unresolved": 0}


def test_a_real_grant_is_never_confused_with_bare_core_over_http():
    """The converse of the above: a registered authorizer that legitimately
    grants nothing must report resolved=True, not the bare-core shape."""

    async def deny_everyone(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant()

    authz.register_scope_authorizer(deny_everyone)

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    body = resp.json()
    assert body["scopes"] == []
    assert body["resolved"] is True
    assert body["checked"] == 0
    assert body["unresolved"] == 0


# ── fail-first case 4: asking about another plugin's data → refused ─────────


def test_forwarded_caller_without_the_permission_code_is_refused():
    """A plugin forwards a genuine, re-verified token — but for a founder who
    holds no grant on this permission_code at all. Refused before the scope
    authorizer is even consulted, regardless of which plugin is asking: this
    is the caller's own grant being examined, never the calling service's
    identity, so there is no per-plugin ownership table to bypass."""

    calls: list[str] = []

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        calls.append(permission_code)
        return authz.ScopeGrant(unrestricted=True)  # would allow anything, if reached

    authz.register_scope_authorizer(authorizer)

    # alice holds no permissions at all — e.g. a founder idea-scout forwards a
    # token for, being asked about marketing's permission_code.
    client = _client(founder=_founder("alice", permissions=frozenset()))
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    assert resp.status_code == 403, resp.text
    assert calls == []  # the scope authorizer was never even called


def test_forwarded_caller_without_the_permission_code_is_refused_for_listing_too():
    client = _client(founder=_founder("alice", permissions=frozenset()))
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    assert resp.status_code == 403, resp.text


# ── opaque reference: no instance vocabulary crosses the seam ───────────────


def test_listing_response_shape_carries_only_opaque_fields():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        return ("brand-1", "region-3", "unit-9")

    async def describer(db, refs):  # noqa: ANN001, ARG001
        return {"unit-9": "Downtown Unit"}

    authz.register_scope_authorizer(authorizer, ancestry_resolver=ancestry, describer=describer)

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    body = resp.json()
    assert body["checked"] == 1
    assert body["unresolved"] == 0
    [option] = body["scopes"]
    assert option.keys() == {"ref", "label", "depth", "parent_ref"}
    assert option["ref"] == "unit-9"
    assert option["label"] == "Downtown Unit"
    assert option["depth"] == 2
    assert option["parent_ref"] == "region-3"
