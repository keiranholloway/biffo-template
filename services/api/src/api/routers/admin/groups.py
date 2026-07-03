"""Admin endpoint: list the Cognito groups available for assignment (issue #148).

The portal's user-management group picker was hardcoded to
``['admin', 'editor', 'viewer']`` because the Core API exposed no way to list
groups, so a deployment that customised its Cognito group taxonomy had to also
edit the UI constant. This exposes the groups from Cognito — the authorization
source of truth (ADR-0004) — gated to the ``admin`` group like the rest of the
/admin surface, so the portal can populate the picker dynamically.
"""

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, status

from ...cognito import CognitoAdmin, CognitoAdminError
from ...dependencies import get_cognito_admin, require_admin
from ...middleware.auth import AuthenticatedUser
from ...schemas.group import GroupListResponse

logger = Logger()

router = APIRouter(prefix="/admin/groups", tags=["admin"])


@router.get("", response_model=GroupListResponse)
async def list_groups(
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
) -> GroupListResponse:
    """List the Cognito groups a user can be assigned to on this deployment."""
    try:
        groups = cog.list_groups()
    except CognitoAdminError as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=err.message
        ) from err
    return GroupListResponse(groups=groups)
