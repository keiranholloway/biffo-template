"""The authenticated user-facing serving gate (ADR-0018 §1).

The security logic (``authorize``) is exercised purely with a fake verifier — no
real JWT — and ``require_group`` is exercised as a FastAPI dependency mounted on a
tiny app, asserting the 401/403/200 mapping and that the founder's raw token is
carried through for forwarding to Core.
"""

from __future__ import annotations

import pytest
from biffo_plugin_sdk.user_serving import (
    CognitoConfig,
    ForbiddenError,
    UnauthorizedError,
    UserAuthError,
    Verifier,
    authorize,
    require_group,
)
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

_CONFIG = CognitoConfig(user_pool_id="pool", region="eu-west-1", client_id="client")


def _verifier(claims: dict) -> Verifier:
    def verify(token, *, user_pool_id, region, client_id, jwks_json):
        assert token  # a token was passed through
        return claims

    return verify


def _raising_verifier() -> Verifier:
    from biffo_cognito_auth import TokenVerificationError

    def verify(token, **kwargs):
        raise TokenVerificationError("bad token")

    return verify


# ── authorize (pure) ─────────────────────────────────────────────────────────────


def test_authorize_returns_the_founder_with_its_raw_token():
    verify = _verifier({"sub": "alice", "cognito:groups": ["founder", "beta"]})
    user = authorize("tok-123", required_group="founder", config=_CONFIG, verify=verify)
    assert user.sub == "alice"
    assert user.groups == ["founder", "beta"]
    assert user.token == "tok-123"  # forwarded to Core verbatim


def test_authorize_rejects_a_user_not_in_the_group():
    verify = _verifier({"sub": "bob", "cognito:groups": ["beta"]})
    with pytest.raises(ForbiddenError):
        authorize("tok", required_group="founder", config=_CONFIG, verify=verify)


def test_authorize_missing_groups_claim_is_forbidden():
    verify = _verifier({"sub": "carol"})  # no cognito:groups
    with pytest.raises(ForbiddenError):
        authorize("tok", required_group="founder", config=_CONFIG, verify=verify)


def test_authorize_empty_token_is_unauthorized():
    with pytest.raises(UnauthorizedError):
        authorize("", required_group="founder", config=_CONFIG, verify=_verifier({}))


def test_authorize_verification_failure_is_unauthorized():
    with pytest.raises(UnauthorizedError):
        authorize("tok", required_group="founder", config=_CONFIG, verify=_raising_verifier())


# ── require_group (FastAPI dependency) ───────────────────────────────────────────


def _app(claims: dict) -> TestClient:
    dep = require_group("founder", config=_CONFIG, verify=_verifier(claims))
    app = FastAPI()

    @app.get("/whoami")
    def whoami(user=Depends(dep)) -> dict:
        return {"sub": user.sub, "token": user.token}

    return TestClient(app)


def test_dependency_allows_a_founder_and_carries_the_token():
    client = _app({"sub": "alice", "cognito:groups": ["founder"]})
    resp = client.get("/whoami", headers={"Authorization": "Bearer tok-xyz"})
    assert resp.status_code == 200
    assert resp.json() == {"sub": "alice", "token": "tok-xyz"}


def test_dependency_401_without_a_bearer_token():
    client = _app({"sub": "alice", "cognito:groups": ["founder"]})
    assert client.get("/whoami").status_code == 401
    assert client.get("/whoami", headers={"Authorization": "Basic x"}).status_code == 401


def test_dependency_403_for_the_wrong_group():
    client = _app({"sub": "bob", "cognito:groups": ["beta"]})
    resp = client.get("/whoami", headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 403


# ── config ───────────────────────────────────────────────────────────────────────


def test_from_env_reads_the_shared_cognito_config(monkeypatch):
    monkeypatch.setenv("BIFFO_COGNITO_USER_POOL_ID", "pool-1")
    monkeypatch.setenv("BIFFO_COGNITO_REGION", "eu-west-2")
    monkeypatch.setenv("BIFFO_COGNITO_CLIENT_ID", "client-1")
    cfg = CognitoConfig.from_env()
    assert (cfg.user_pool_id, cfg.region, cfg.client_id) == ("pool-1", "eu-west-2", "client-1")


def test_from_env_missing_config_raises(monkeypatch):
    monkeypatch.delenv("BIFFO_COGNITO_USER_POOL_ID", raising=False)
    with pytest.raises(UserAuthError):
        CognitoConfig.from_env()
