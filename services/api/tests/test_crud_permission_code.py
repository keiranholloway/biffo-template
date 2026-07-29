"""ADR-0004's second authorization axis: DB-held permission codes (#889).

The template already resolves permission codes per request in every subsystem
except ADR-0004's own — ``AuthenticatedUser.permissions``,
``IdentityProvider.resolve_permissions`` (ADR-0012), ``WriteBackTarget`` and
orchestration all honour them, and ADR-0025 attributes the permission set to
ADR-0004 by name. The generic CRUD layer could not see them, so an instance
whose authorization is DB-held had to fork ``dependencies.py`` and
``plugin_table.py`` — the fork ADR-0004 exists to prevent.

Two properties are load-bearing here and neither is obvious:

- **The axes are AND.** #889 proposed short-circuiting on ``permission_code``
  and returning, which would leave a declared ``required_role`` *silently
  ignored*. On a security surface that is the failure ``extra="forbid"`` exists
  to prevent. AND still serves the DB-held case because an empty
  ``required_role`` already authorises any authenticated caller.
- **Both transports.** #621 established that the Cognito guard and the principal
  guard must authorise on the same axis. A second axis honoured by only one of
  them would reopen exactly that gap.
"""

import pytest
from api.dependencies import require_crud_permission, require_principal_crud_permission
from api.middleware.auth import AuthenticatedUser
from api.middleware.principal import Principal
from api.models.plugin_table import TablePermissions
from fastapi import HTTPException

CODE = "crm.lead.read"


def _registry(*, permission_code: str = "", required_role: list[str] | None = None):
    return {
        "widgets": TablePermissions.model_validate(
            {
                "list": {
                    "allowed": True,
                    "permission_code": permission_code,
                    "required_role": required_role or [],
                }
            }
        )
    }


def _user(*, permissions: frozenset[str] = frozenset(), roles: list[str] | None = None):
    return AuthenticatedUser(
        sub="sub-1",
        email="a@example.com",
        username="u",
        tenant_id="default",
        roles=roles or [],
        permissions=permissions,
    )


async def _run(guard, caller):
    """Invoke a guard with its dependency already resolved."""
    await guard(caller)


@pytest.mark.asyncio
async def test_caller_without_the_code_is_denied() -> None:
    """The branch that does not exist before this change.

    Without the guard the call simply returns None: `required_role` is empty, so
    today's only check authorises any authenticated caller.
    """
    guard = require_crud_permission("widgets", "list", _registry(permission_code=CODE))
    with pytest.raises(HTTPException) as exc:
        await _run(guard, _user(permissions=frozenset()))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_caller_holding_the_code_is_allowed() -> None:
    guard = require_crud_permission("widgets", "list", _registry(permission_code=CODE))
    await _run(guard, _user(permissions=frozenset({CODE})))


@pytest.mark.asyncio
async def test_a_rule_without_a_code_is_unaffected() -> None:
    """The non-breaking claim, exercised rather than asserted."""
    guard = require_crud_permission("widgets", "list", _registry())
    await _run(guard, _user(permissions=frozenset()))


@pytest.mark.asyncio
async def test_both_axes_must_hold_rather_than_the_code_winning() -> None:
    """AND, not either/or.

    Holding the permission code must NOT excuse a caller from a declared
    ``required_role``. Under the short-circuit shape #889 proposed, this caller
    would be authorised and the role silently ignored.
    """
    guard = require_crud_permission(
        "widgets", "list", _registry(permission_code=CODE, required_role=["admin"])
    )
    with pytest.raises(HTTPException) as exc:
        await _run(guard, _user(permissions=frozenset({CODE}), roles=["viewer"]))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_the_principal_transport_honours_the_same_axis() -> None:
    """#621: a second axis honoured by only one transport reopens that gap."""
    guard = require_principal_crud_permission("widgets", "list", _registry(permission_code=CODE))
    with pytest.raises(HTTPException) as exc:
        await guard(Principal(user=_user(permissions=frozenset()), service=None))
    assert exc.value.status_code == 403
    await guard(Principal(user=_user(permissions=frozenset({CODE})), service=None))
