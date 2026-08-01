"""Guard agreement: ``require_crud_permission`` and
``require_principal_crud_permission`` must reach the SAME decision (#1019).

Issue #1019 originally claimed the two guards disagree — one "superseding" the
other on ``permission_code`` and one carrying a platform-admin bypass. Neither
claim survived reading the code: both guards evaluate the identical AND logic
(404 for an unexposed/absent rule, then 403 on ``permission_code``, then 403 on
``required_role``), and neither has any admin bypass. They differ only in
**transport** — ``require_crud_permission`` depends on ``require_auth``
(bearer-only); ``require_principal_crud_permission`` depends on
``require_principal`` (bearer *or* ``X-Biffo-User-Token`` on a SigV4 request,
#621/#652).

What was missing, and what this file adds, is a test that asserts the
agreement **by construction** rather than by two independently-written test
files happening to agree today. Each case below holds transport constant
(a bearer-authenticated user, wrapped as a bare ``AuthenticatedUser`` for the
Cognito guard and as a service-free ``Principal`` for the unified guard) and
varies only the authorization inputs — the registry rule and the caller's
permissions/roles — so a future edit that makes one guard's AND drift into an
OR, or adds a bypass to only one of them, fails here even though each guard's
own dedicated test file might still be green.
"""

from __future__ import annotations

import pytest
from api.dependencies import require_crud_permission, require_principal_crud_permission
from api.middleware.auth import AuthenticatedUser
from api.middleware.principal import Principal
from api.models.plugin_table import TablePermissions
from fastapi import HTTPException

CODE = "crm.lead.read"
TABLE = "widgets"
ABSENT_TABLE = "ghosts"


def _registry(
    *,
    allowed: bool = True,
    permission_code: str = "",
    required_role: list[str] | None = None,
):
    """A registry with a single ``(TABLE, "list")`` rule — mirrors the fixtures
    in test_crud_permission_code.py / test_principal_crud_permission.py."""
    return {
        TABLE: TablePermissions.model_validate(
            {
                "list": {
                    "allowed": allowed,
                    "permission_code": permission_code,
                    "required_role": required_role or [],
                }
            }
        )
    }


def _user(
    *, permissions: frozenset[str] = frozenset(), roles: list[str] | None = None
) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="sub-1",
        email="a@example.com",
        username="u",
        tenant_id="default",
        roles=roles or [],
        permissions=permissions,
    )


async def _status_of(coro) -> int | None:
    """The guard's verdict as a status code, or ``None`` when it authorises."""
    try:
        await coro
        return None
    except HTTPException as exc:
        return exc.status_code


async def _both_verdicts(
    *, table: str, registry, permissions: frozenset[str], roles: list[str]
) -> tuple[int | None, int | None]:
    """Run both guards against the same authorization inputs, bearer transport
    held constant, and return (cognito_status, unified_status)."""
    user = _user(permissions=permissions, roles=roles)

    cognito = await _status_of(require_crud_permission(table, "list", registry)(caller=user))
    unified = await _status_of(
        require_principal_crud_permission(table, "list", registry)(
            principal=Principal(user=user, service=None)
        )
    )
    return cognito, unified


async def test_rule_absent_from_registry_is_404_for_both() -> None:
    """ADR-0004 §4 indistinguishability: an unexposed table 404s, identically,
    on both transports."""
    registry = _registry()  # only TABLE is registered
    cognito, unified = await _both_verdicts(
        table=ABSENT_TABLE,
        registry=registry,
        permissions=frozenset(),
        roles=[],
    )
    assert cognito == 404
    assert unified == 404
    assert cognito == unified


@pytest.mark.parametrize(
    (
        "case_id",
        "allowed",
        "permission_code",
        "required_role",
        "caller_permissions",
        "caller_roles",
        "expected",
    ),
    [
        pytest.param(
            "rule_disallowed",
            False,
            "",
            None,
            frozenset(),
            [],
            404,
            id="rule_disallowed",
        ),
        pytest.param(
            "permission_code_only__missing",
            True,
            CODE,
            None,
            frozenset(),
            [],
            403,
            id="permission_code_only__caller_lacks_it",
        ),
        pytest.param(
            "permission_code_only__held",
            True,
            CODE,
            None,
            frozenset({CODE}),
            [],
            None,
            id="permission_code_only__caller_holds_it",
        ),
        pytest.param(
            "required_role_only__disjoint",
            True,
            "",
            ["admin"],
            frozenset(),
            ["viewer"],
            403,
            id="required_role_only__disjoint_roles",
        ),
        pytest.param(
            "required_role_only__intersecting",
            True,
            "",
            ["admin"],
            frozenset(),
            ["admin"],
            None,
            id="required_role_only__intersecting_role",
        ),
        pytest.param(
            "both__code_only_satisfied",
            True,
            CODE,
            ["admin"],
            frozenset({CODE}),
            ["viewer"],
            403,
            id="both_set__caller_satisfies_only_the_code",
        ),
        pytest.param(
            "both__role_only_satisfied",
            True,
            CODE,
            ["admin"],
            frozenset(),
            ["admin"],
            403,
            id="both_set__caller_satisfies_only_the_role",
        ),
        pytest.param(
            "both__satisfied",
            True,
            CODE,
            ["admin"],
            frozenset({CODE}),
            ["admin"],
            None,
            id="both_set__caller_satisfies_both",
        ),
    ],
)
async def test_guards_agree_case_for_case(
    case_id,
    allowed,
    permission_code,
    required_role,
    caller_permissions,
    caller_roles,
    expected,
) -> None:
    """The drift-prevention assertion #1019 actually wants.

    Each case fixes a registry rule and a caller, then asserts both guards
    reach ``expected`` *and* agree with each other. The two "only one axis
    satisfied" cases are the ones most likely to catch a future regression:
    they are exactly what a wrongly-reintroduced early-return on
    ``permission_code`` (the "supersedes" behaviour #1019 originally, and
    wrongly, believed already existed) would flip from 403 to an allow on
    only one of the two guards.
    """
    registry = _registry(
        allowed=allowed, permission_code=permission_code, required_role=required_role
    )
    cognito, unified = await _both_verdicts(
        table=TABLE,
        registry=registry,
        permissions=caller_permissions,
        roles=caller_roles,
    )
    assert cognito == expected, case_id
    assert unified == expected, case_id
    assert cognito == unified, case_id
