"""Tests for the ADR-0014 §7 agent read-scope-ceiling guard,
``dependencies.require_service_crud_permission`` — the service-principal sibling
of ``require_crud_permission``.

Two layers are exercised:

- the guard **body** directly (allow vs 404), constructed with an explicit
  registry the same way ``require_crud_permission`` is, and awaited with a
  stand-in ``ServicePrincipal``; and
- the **dependency graph** through a throwaway FastAPI app + TestClient, which
  is where the structural separation lives: the guard depends on
  ``require_service_principal`` (not ``require_auth``), so a request with no
  SigV4 IAM principal — which is every Cognito-user request — is rejected with
  401 before the guard body can ever authorise.

The guard is deliberately NOT mounted on any real route yet (§7 piece 3 is out
of scope); these mount it on a throwaway route purely to prove the mechanics.
"""

import pytest
from api.config import settings
from api.dependencies import require_service_crud_permission
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.plugin_table import TablePermissions
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

AGENT_ARN = (
    "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-agent-runtime-role/agent-session"
)
ALLOWLIST = ["arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-*/*"]


def _registry(*, allowed: bool = True, allowed_principals: list[str]):
    """A one-table registry whose ``read`` rule carries the given ceiling."""
    return {
        "widgets": TablePermissions.model_validate(
            {"read": {"allowed": allowed, "allowed_principals": allowed_principals}}
        )
    }


def _principal(arn: str = AGENT_ARN) -> ServicePrincipal:
    return ServicePrincipal(principal_arn=arn)


# --------------------------------------------------------------------------- #
# Guard body — allow vs 404 (never 403).                                      #
# --------------------------------------------------------------------------- #


async def test_granted_principal_is_allowed():
    guard = require_service_crud_permission(
        "widgets", "read", _registry(allowed_principals=["system:agent-runtime"])
    )
    # No exception == authorised.
    assert await guard(principal=_principal()) is None


async def test_principal_not_in_allowed_principals_is_404():
    guard = require_service_crud_permission(
        "widgets", "read", _registry(allowed_principals=["system:some-other-agent"])
    )
    with pytest.raises(HTTPException) as exc:
        await guard(principal=_principal())
    # 404, NOT 403 — a service principal has no role to "lack", and an ungranted
    # table must stay indistinguishable from a nonexistent one (ADR-0004 §4).
    assert exc.value.status_code == 404


async def test_empty_allowed_principals_is_404():
    # Thin-by-default: a table that names nobody grants no agent anything.
    guard = require_service_crud_permission("widgets", "read", _registry(allowed_principals=[]))
    with pytest.raises(HTTPException) as exc:
        await guard(principal=_principal())
    assert exc.value.status_code == 404


async def test_undeclared_table_operation_is_404():
    guard = require_service_crud_permission(
        "widgets", "read", _registry(allowed_principals=["system:agent-runtime"])
    )
    # lookup_permission returns None for a table not in the registry.
    guard_missing = require_service_crud_permission(
        "does-not-exist", "read", _registry(allowed_principals=["system:agent-runtime"])
    )
    with pytest.raises(HTTPException) as exc:
        await guard_missing(principal=_principal())
    assert exc.value.status_code == 404
    # sanity: the same table/op with a matching grant does authorise.
    assert await guard(principal=_principal()) is None


async def test_operation_not_allowed_is_404():
    guard = require_service_crud_permission(
        "widgets",
        "read",
        _registry(allowed=False, allowed_principals=["system:agent-runtime"]),
    )
    with pytest.raises(HTTPException) as exc:
        await guard(principal=_principal())
    assert exc.value.status_code == 404


async def test_non_conforming_principal_arn_cannot_be_granted():
    # Even if the exact string were somehow named, a non-plugin ARN derives no
    # logical name (empty set) and so intersects nothing. Fail closed.
    guard = require_service_crud_permission(
        "widgets", "read", _registry(allowed_principals=["system:agent-runtime"])
    )
    non_plugin = _principal("arn:aws:sts::123456789012:assumed-role/acme-dev-core-api-role/s")
    with pytest.raises(HTTPException) as exc:
        await guard(principal=non_plugin)
    assert exc.value.status_code == 404


# --------------------------------------------------------------------------- #
# Dependency graph — structural separation from Cognito users.                #
# --------------------------------------------------------------------------- #


class _InjectAwsEvent:
    """Minimal ASGI middleware standing in for Mangum: puts a SigV4-verified IAM
    principal onto ``scope['aws.event']`` the way API Gateway + Mangum would."""

    def __init__(self, app, user_arn: str):
        self.app = app
        self.user_arn = user_arn

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope["aws.event"] = {
                "requestContext": {
                    "http": {"method": scope.get("method", "GET")},
                    "authorizer": {"iam": {"userArn": self.user_arn}},
                }
            }
        await self.app(scope, receive, send)


def _app(registry, *, inject_arn: str | None = None) -> FastAPI:
    app = FastAPI()
    guard = require_service_crud_permission("widgets", "read", registry)

    @app.get("/probe", dependencies=[Depends(guard)])
    async def probe():
        return {"ok": True}

    if inject_arn is not None:
        app.add_middleware(_InjectAwsEvent, user_arn=inject_arn)
    return app


def test_request_without_iam_principal_is_401(monkeypatch):
    """A request carrying no SigV4 IAM principal — which is exactly what a
    Cognito-user request is on these routes — is rejected at
    require_service_principal (401) before the guard body runs. A Cognito user
    can therefore never reach an allow through this guard, whatever groups they
    hold: the separation is enforced by the dependency graph."""
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", list(ALLOWLIST))
    app = _app(_registry(allowed_principals=["system:agent-runtime"]))
    client = TestClient(app)

    resp = client.get("/probe")

    assert resp.status_code == 401


def test_cognito_style_request_without_iam_block_is_401(monkeypatch):
    """Same property, made concrete: a request whose requestContext has an
    authorizer but no ``iam`` block (a Cognito authorizer, not AWS_IAM) is 401."""
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", list(ALLOWLIST))

    class _InjectCognitoEvent(_InjectAwsEvent):
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope["aws.event"] = {
                    "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "u"}}}}
                }
            await self.app(scope, receive, send)

    app = FastAPI()
    guard = require_service_crud_permission(
        "widgets", "read", _registry(allowed_principals=["system:agent-runtime"])
    )

    @app.get("/probe", dependencies=[Depends(guard)])
    async def probe():
        return {"ok": True}

    app.add_middleware(_InjectCognitoEvent, user_arn="unused")
    resp = TestClient(app).get("/probe")

    assert resp.status_code == 401


def test_granted_service_principal_passes_end_to_end(monkeypatch):
    """The full chain: an allowlisted, conforming plugin IAM principal whose
    derived name is granted flows through require_service_principal and the
    guard to the handler."""
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", list(ALLOWLIST))
    app = _app(_registry(allowed_principals=["system:agent-runtime"]), inject_arn=AGENT_ARN)

    resp = TestClient(app).get("/probe")

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_allowlisted_but_ungranted_principal_is_404_end_to_end(monkeypatch):
    """An allowlisted service principal (passes require_service_principal) whose
    derived name is not in allowed_principals gets 404 from the guard — not 403,
    and not 200."""
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", list(ALLOWLIST))
    app = _app(_registry(allowed_principals=["system:some-other-agent"]), inject_arn=AGENT_ARN)

    resp = TestClient(app).get("/probe")

    assert resp.status_code == 404


def test_guard_depends_on_service_principal_not_require_auth():
    """The guard's only dependency is require_service_principal (structural
    guarantee that require_auth / a Cognito user is never in the chain)."""
    guard = require_service_crud_permission(
        "widgets", "read", _registry(allowed_principals=["system:agent-runtime"])
    )
    # Introspect the closure's signature: its single parameter defaults to a
    # Depends(require_service_principal).
    import inspect

    params = list(inspect.signature(guard).parameters.values())
    assert len(params) == 1
    assert params[0].default.dependency is require_service_principal
