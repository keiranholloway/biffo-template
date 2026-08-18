"""Router tests for the internal scope-authorization seam (ADR-0029, issue
#1607 steps 1-2; issue #1644's second, service-entitlement axis; issue
#1653's correction of where that entitlement comes from).

Executes the issue's fail-first cases over real HTTP through a FastAPI
``TestClient``, not by calling the registry functions directly, so these
prove the denial is enforced by the server, not merely by a library function
a client could choose not to call.

Since #1653 the entitlement axis is declared by the **instance**, as the
``entitlements`` argument to ``register_scope_authorizer`` — so these tests
register it the way a real instance's domain module would, and no plugin
manifest is read, mocked or consulted anywhere in this file. That absence is
the fix: see ``test_plugin_cannot_entitle_itself_by_declaring_a_foreign_code``.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

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
# A permission_code that belongs to an entirely different subsystem — the
# real example from issue #1644's prosecution: an hq-admin plausibly holds
# both, but this instance (below) entitles marketing to only its own.
_OTHER_DOMAIN_PERMISSION_CODE = "workflows.manage"

# What THIS instance entitles each installed plugin to ask about — the shape a
# real instance writes in its own domain module beside its authorizer, drawn
# from its own DDL-seeded permission vocabulary (ADR-0012). Marketing may ask
# about its own code and nothing else; nothing marketing authors can change
# this.
_ENTITLEMENTS: dict[str, frozenset[str]] = {
    "system:marketing": frozenset({_PERMISSION_CODE}),
}


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


def _register(authorizer: Any, **kwargs: Any) -> None:  # noqa: ANN401
    """Register as a real instance would, entitling marketing to its own code
    unless a test deliberately says otherwise. Entitlement is part of the
    registration now (#1653), so it is passed here rather than mocked onto a
    manifest scan."""
    kwargs.setdefault("entitlements", _ENTITLEMENTS)
    authz.register_scope_authorizer(authorizer, **kwargs)


@pytest.fixture(autouse=True)
def _reset_registry():
    saved = (
        authz._authorizer,  # noqa: SLF001
        authz._ancestry_resolver,  # noqa: SLF001
        authz._describer,  # noqa: SLF001
        authz._entitlements,  # noqa: SLF001
        authz._registered,  # noqa: SLF001
    )
    yield
    (
        authz._authorizer,  # noqa: SLF001
        authz._ancestry_resolver,  # noqa: SLF001
        authz._describer,  # noqa: SLF001
        authz._entitlements,  # noqa: SLF001
        authz._registered,  # noqa: SLF001
    ) = saved


def _force_unregistered() -> None:
    authz._authorizer = authz._default_authorizer  # noqa: SLF001
    authz._ancestry_resolver = authz._default_ancestry  # noqa: SLF001
    authz._describer = authz._default_describer  # noqa: SLF001
    authz._entitlements = {}  # noqa: SLF001
    authz._registered = False  # noqa: SLF001


# ── fail-first case 1: a caller with the scope → allowed ────────────────────


def test_caller_with_the_scope_is_allowed():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    _register(authorizer)

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

    _register(authorizer)

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


# ── fail-first case 3: bare core → refused outright (changed by #1653) ──────


def test_bare_core_refuses_the_ask_because_it_entitles_nobody():
    """An instance that registered no authorizer also declared no
    entitlements, so axis 2 refuses before either route body runs.

    This is a deliberate change from #1644's behaviour, where bare core
    answered 200 with resolved=false: an unentitled plugin now learns nothing
    at all, not even this instance's registration state. The
    resolved=False / "could not resolve" distinction (#1634) is untouched in
    the registry itself and is asserted in test_scope_authz.py — it is simply
    no longer reachable over HTTP, which the router docstring states rather
    than leaving a response field that looks exercised and is not.
    """
    _force_unregistered()

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    assert resp.status_code == 403, resp.text

    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    assert resp.status_code == 403, resp.text


def test_a_real_grant_is_never_confused_with_bare_core_over_http():
    """A registered authorizer that legitimately grants nothing must report
    resolved=True and an empty list — "checked, none", never conflated with
    the bare-core answer (#1634's rejected bug)."""

    async def deny_everyone(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant()

    _register(deny_everyone)

    client = _client(founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})))
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scopes"] == []
    assert body["resolved"] is True
    assert body["checked"] == 0
    assert body["unresolved"] == 0


# ── fail-first case 4: a caller with NO grant at all → refused ──────────────
# (Renamed from "asking about another plugin's data" — issue #1644 found that
# heading false: this exercises a caller holding zero permissions, which says
# nothing about cross-plugin disclosure. See case 5 below for the real thing.)


def test_forwarded_caller_with_no_permissions_at_all_is_refused():
    """A plugin forwards a genuine, re-verified token — but for a founder who
    holds no grant on this permission_code at all. Refused before the scope
    authorizer is even consulted: this is axis 1, the caller's own grant."""

    calls: list[str] = []

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        calls.append(permission_code)
        return authz.ScopeGrant(unrestricted=True)  # would allow anything, if reached

    _register(authorizer)

    # alice holds no permissions at all — e.g. a founder idea-scout forwards a
    # token for, being asked about marketing's permission_code.
    client = _client(founder=_founder("alice", permissions=frozenset()))
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "unit-9"},
    )
    assert resp.status_code == 403, resp.text
    assert calls == []  # the scope authorizer was never even called


def test_forwarded_caller_with_no_permissions_at_all_is_refused_for_listing_too():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(unrestricted=True)

    _register(authorizer)

    client = _client(founder=_founder("alice", permissions=frozenset()))
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    assert resp.status_code == 403, resp.text


# ── fail-first case 5: asking about ANOTHER plugin's data → refused ─────────
# The realistic, previously-untested case (issue #1644): the forwarded caller
# legitimately holds the permission_code being asked about — an hq-admin
# holding both marketing.links.manage and workflows.manage, exactly the
# population most likely to trigger this, per the prosecution's own repro.


def test_caller_holding_the_code_is_still_refused_when_instance_did_not_entitle_the_plugin():
    """Reproduces issue #1644 exactly: hq-admin holds BOTH marketing.links.manage
    and workflows.manage. The marketing plugin's own signed principal forwards
    that token and asks about workflows.manage — a permission_code this
    instance never entitled marketing to. Before #1644 this returned 200 with
    the caller's full workflows scope hierarchy; it must be refused, and the
    scope authorizer must never even be consulted."""

    calls: list[str] = []

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        calls.append(permission_code)
        return authz.ScopeGrant(unrestricted=True)  # would allow anything, if reached

    _register(authorizer)

    hq_admin = _founder(
        "hq-admin", permissions=frozenset({_PERMISSION_CODE, _OTHER_DOMAIN_PERMISSION_CODE})
    )
    client = _client(founder=hq_admin, principal_arn=_MARKETING_ARN)

    resp = client.get(f"/api/v1/internal/scopes?permission_code={_OTHER_DOMAIN_PERMISSION_CODE}")
    assert resp.status_code == 403, resp.text

    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _OTHER_DOMAIN_PERMISSION_CODE, "scope_ref": "brand-hq"},
    )
    assert resp.status_code == 403, resp.text
    assert calls == []  # the scope authorizer was never even called for either route


def test_caller_holding_the_code_is_allowed_when_the_instance_entitled_the_plugin():
    """The converse of the above, and the must-not-regress case: the marketing
    plugin asking about the code THIS INSTANCE entitled it to, for a caller
    who holds it — including a caller who ALSO holds an unrelated code — must
    still work. The fix is a second AND, not a tightening of axis 1."""

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"brand-hq"}))

    _register(authorizer)

    hq_admin = _founder(
        "hq-admin", permissions=frozenset({_PERMISSION_CODE, _OTHER_DOMAIN_PERMISSION_CODE})
    )
    client = _client(founder=hq_admin, principal_arn=_MARKETING_ARN)
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _PERMISSION_CODE, "scope_ref": "brand-hq"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["allowed"] is True


def test_plugin_the_instance_never_mentioned_is_refused_even_if_caller_holds_the_code():
    """A plugin the instance's entitlement map does not name at all — the
    common case, since a map starts empty — is entitled to ask about nothing.
    Even a caller who genuinely holds the code asked about must still be
    refused, because the INSTANCE never said this plugin may ask."""

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(unrestricted=True)

    _register(authorizer)

    agent_runtime_arn = (
        "arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-agent-runtime-role/s"
    )
    client = _client(
        founder=_founder("alice", permissions=frozenset({_PERMISSION_CODE})),
        principal_arn=agent_runtime_arn,
    )
    resp = client.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")
    assert resp.status_code == 403, resp.text


# ── issue #1653's Case C probe: a plugin cannot entitle itself ──────────────


def test_plugin_cannot_entitle_itself_by_declaring_a_foreign_code():
    """Case C from issue #1653, and the regression this change exists to make
    permanent.

    Under #1644 a plugin became entitled to a ``permission_code`` by naming it
    on one of its own tables in its own ``biffo.plugin.json`` — a document the
    plugin author writes. So marketing could declare ``workflows.manage`` on
    its own ``tracked_links`` table and thereby entitle itself to ask this
    seam about another domain's scope hierarchy.

    The assertion below is the same 403 the old test asserted; the mechanism
    is the opposite. The manifest below is a real-shaped copy of exactly that
    hostile declaration, and it is **never read** — nothing in this file mocks
    a manifest scan, because the router no longer performs one. It is the
    instance's map that decides, and this instance entitled marketing to
    ``marketing.links.manage`` only.
    """
    hostile_manifest = {
        "name": "marketing",
        "tables": [
            {
                "name": "tracked_links",
                "permissions": {
                    # A code belonging to an entirely different subsystem,
                    # declared by the plugin on its OWN table.
                    "list": {"allowed": True, "permission_code": _OTHER_DOMAIN_PERMISSION_CODE},
                    "read": {"allowed": True, "permission_code": _OTHER_DOMAIN_PERMISSION_CODE},
                },
            }
        ],
    }
    # Installed on disk it would say this; it buys nothing, because it is not
    # an input to the decision.
    assert hostile_manifest["name"] == "marketing"

    calls: list[str] = []

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        calls.append(permission_code)
        return authz.ScopeGrant(unrestricted=True)

    _register(authorizer)

    hq_admin = _founder(
        "hq-admin", permissions=frozenset({_PERMISSION_CODE, _OTHER_DOMAIN_PERMISSION_CODE})
    )
    client = _client(founder=hq_admin, principal_arn=_MARKETING_ARN)

    resp = client.get(f"/api/v1/internal/scopes?permission_code={_OTHER_DOMAIN_PERMISSION_CODE}")
    assert resp.status_code == 403, resp.text
    resp = client.post(
        "/api/v1/internal/scope-check",
        json={"permission_code": _OTHER_DOMAIN_PERMISSION_CODE, "scope_ref": "brand-hq"},
    )
    assert resp.status_code == 403, resp.text
    assert calls == []


def test_the_two_refusals_are_indistinguishable_from_the_response():
    """The generic-403 property (#1644, kept deliberately by #1653): "you do
    not hold this code" and "your plugin was not entitled to ask" must look
    identical on the wire, or the seam becomes a probe for which codes an
    instance has entitled to whom."""

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(unrestricted=True)

    _register(authorizer)

    # Axis 1 refusal: the caller holds nothing.
    no_grant = _client(founder=_founder("alice", permissions=frozenset()))
    axis1 = no_grant.get(f"/api/v1/internal/scopes?permission_code={_PERMISSION_CODE}")

    # Axis 2 refusal: the caller holds the code, the instance never entitled
    # marketing to it.
    hq_admin = _client(
        founder=_founder("hq-admin", permissions=frozenset({_OTHER_DOMAIN_PERMISSION_CODE}))
    )
    axis2 = hq_admin.get(f"/api/v1/internal/scopes?permission_code={_OTHER_DOMAIN_PERMISSION_CODE}")

    assert axis1.status_code == axis2.status_code == 403
    assert axis1.json() == axis2.json()


# ── opaque reference: no instance vocabulary crosses the seam ───────────────


def test_listing_response_shape_carries_only_opaque_fields():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        return ("brand-1", "region-3", "unit-9")

    async def describer(db, refs):  # noqa: ANN001, ARG001
        return {"unit-9": "Downtown Unit"}

    _register(authorizer, ancestry_resolver=ancestry, describer=describer)

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
