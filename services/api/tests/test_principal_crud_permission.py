"""Tests for ``dependencies.require_principal_crud_permission`` (#621/#652) —
``require_crud_permission`` reachable by either transport.

Two things need proving, and the second matters more than the first:

- **Parity.** It authorises on exactly the same axis as
  ``require_crud_permission``: the same registry lookup, the same 404-for-
  unexposed and 403-for-wrong-role outcomes, evaluated against the *user's*
  Cognito roles. Only the transport differs.
- **The boundary that must not move.** Accepting a service principal must not
  become a way for a service to authorise *itself*. The service is
  authenticated; the user is what authorises. A signed request carrying no user
  token is 401 no matter how well it is signed, and a service can never satisfy
  a role it does not hold via a user it is not carrying.

ADR-0014 §7's ``require_service_crud_permission`` is a separate axis
(``allowed_principals``) and is deliberately untouched — see
``test_service_crud_permission.py``.
"""

import api.middleware.principal as principal_module
import pytest
from api.dependencies import require_crud_permission, require_principal_crud_permission
from api.middleware.auth import AuthenticatedUser
from api.middleware.principal import Principal
from api.middleware.service_auth import ServicePrincipal
from api.models.plugin_table import TablePermissions
from fastapi import HTTPException

HOST_ARN = "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-host-role/host-session"


def _registry(*, allowed: bool = True, required_role: list[str] | None = None):
    return {
        "widgets": TablePermissions.model_validate(
            {"list": {"allowed": allowed, "required_role": required_role or []}}
        )
    }


def _user(*, roles: list[str]) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="sub-1", email="a@example.com", username="u", tenant_id="default", roles=roles
    )


def _principal(*, roles: list[str], service: bool = False) -> Principal:
    return Principal(
        user=_user(roles=roles),
        service=ServicePrincipal(principal_arn=HOST_ARN) if service else None,
    )


# --------------------------------------------------------------------------- #
# Parity with the Cognito guard — same axis, same outcomes.                    #
# --------------------------------------------------------------------------- #


async def test_a_direct_user_with_the_role_is_allowed():
    guard = require_principal_crud_permission("widgets", "list", _registry(required_role=["admin"]))
    assert await guard(principal=_principal(roles=["admin"])) is None


async def test_a_direct_user_without_the_role_is_403():
    guard = require_principal_crud_permission("widgets", "list", _registry(required_role=["admin"]))
    with pytest.raises(HTTPException) as exc:
        await guard(principal=_principal(roles=["founder"]))
    assert exc.value.status_code == 403


async def test_an_unexposed_operation_is_404_not_403():
    """ADR-0004 §4 indistinguishability, identical to the Cognito guard."""
    guard = require_principal_crud_permission("widgets", "list", _registry(allowed=False))
    with pytest.raises(HTTPException) as exc:
        await guard(principal=_principal(roles=["admin"]))
    assert exc.value.status_code == 404


async def test_an_empty_required_role_authorises_any_authenticated_caller():
    guard = require_principal_crud_permission("widgets", "list", _registry(required_role=[]))
    assert await guard(principal=_principal(roles=[])) is None


async def _status_of(coro) -> int | None:
    """The guard's verdict as a status code, or None when it authorises."""
    try:
        await coro
        return None
    except HTTPException as exc:
        return exc.status_code


@pytest.mark.parametrize(
    ("required_role", "roles", "expected"),
    [
        (["admin"], ["admin"], None),
        (["admin"], ["founder"], 403),
        ([], [], None),
    ],
)
async def test_outcomes_match_the_cognito_guard_case_for_case(required_role, roles, expected):
    """The two guards must not drift: same registry, same verdict.

    This is the parity assertion — if someone changes one guard's authorisation
    logic without the other, this fails.
    """
    reg = _registry(required_role=required_role)
    user = _user(roles=roles)

    cognito = await _status_of(require_crud_permission("widgets", "list", reg)(caller=user))
    unified = await _status_of(
        require_principal_crud_permission("widgets", "list", reg)(principal=Principal(user=user))
    )

    assert cognito == expected
    assert unified == expected
    assert cognito == unified


# --------------------------------------------------------------------------- #
# The boundary: the service is authenticated, the USER authorises.            #
# --------------------------------------------------------------------------- #


async def test_a_forwarded_user_is_authorised_exactly_as_that_user():
    """The point of the change: the host acting for a real admin gets the same
    answer that admin would get calling directly."""
    guard = require_principal_crud_permission("widgets", "list", _registry(required_role=["admin"]))
    assert await guard(principal=_principal(roles=["admin"], service=True)) is None


async def test_a_service_cannot_exceed_the_roles_of_the_user_it_carries():
    """A signed caller does not gain authority by being signed. Carrying a
    founder's token grants founder access — not admin."""
    guard = require_principal_crud_permission("widgets", "list", _registry(required_role=["admin"]))
    with pytest.raises(HTTPException) as exc:
        await guard(principal=_principal(roles=["founder"], service=True))
    assert exc.value.status_code == 403


async def test_a_signed_request_with_no_user_token_never_reaches_the_guard(monkeypatch):
    """Authentication, not this guard, is what refuses an unaccompanied service
    call — `require_principal` 401s before any rule is consulted, so there is no
    path where a service authorises on its own authority."""
    from starlette.requests import Request

    request = Request(
        {
            "type": "http",
            "headers": [],
            "aws.event": {
                "requestContext": {
                    "http": {"method": "GET"},
                    "authorizer": {"iam": {"userArn": HOST_ARN}},
                }
            },
        }
    )
    from api.config import settings

    monkeypatch.setattr(
        settings,
        "service_principal_arn_allowlist",
        ["arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-*/*"],
    )

    with pytest.raises(HTTPException) as exc:
        await principal_module.require_principal(
            request,
            credentials=None,
            forwarded_token=None,
            db=None,  # type: ignore[arg-type]
        )
    assert exc.value.status_code == 401
