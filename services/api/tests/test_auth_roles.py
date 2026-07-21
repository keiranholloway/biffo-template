"""ADR-0004: require_auth sources caller.roles from the JWT `cognito:groups`
claim, so the generic CRUD permission layer can authorise without a DB lookup."""

import api.middleware.auth as auth_module
from api.middleware.auth import AuthenticatedUser, identity_from_token
from fastapi.security import HTTPAuthorizationCredentials


def _credentials() -> HTTPAuthorizationCredentials:
    # The token value is irrelevant: _verify_token is monkeypatched to bypass
    # signature verification and return a canned claims dict.
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")


async def test_roles_populated_from_cognito_groups(monkeypatch):
    monkeypatch.setattr(
        auth_module,
        "_verify_token",
        lambda _token: {
            "sub": "sub-1",
            "email": "a@example.com",
            "cognito:username": "alice",
            "cognito:groups": ["admin", "editor"],
        },
    )

    caller = identity_from_token(_credentials())

    assert caller.roles == ["admin", "editor"]
    assert caller.sub == "sub-1"


async def test_roles_default_empty_when_claim_absent(monkeypatch):
    monkeypatch.setattr(
        auth_module,
        "_verify_token",
        lambda _token: {"sub": "sub-2", "email": "b@example.com"},
    )

    caller = identity_from_token(_credentials())

    assert caller.roles == []


async def test_roles_default_empty_when_claim_null(monkeypatch):
    # Cognito omits the claim for a caller in no groups; guard the explicit-null
    # shape too so a null never becomes list(None) -> TypeError.
    monkeypatch.setattr(
        auth_module,
        "_verify_token",
        lambda _token: {
            "sub": "sub-3",
            "email": "c@example.com",
            "cognito:groups": None,
        },
    )

    caller = identity_from_token(_credentials())

    assert caller.roles == []


def test_authenticated_user_defaults_to_no_roles():
    # Fail-closed default: a construction site that doesn't set roles (tests,
    # dependency overrides) gets an empty list, not an error.
    caller = AuthenticatedUser(sub="s", email="e@example.com", username="u", tenant_id="default")
    assert caller.roles == []
