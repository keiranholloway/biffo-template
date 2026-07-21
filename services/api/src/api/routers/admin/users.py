"""Admin user-management endpoints (Cognito-backed).

Identity and group membership are sourced from Cognito (the `cognito:groups` JWT
claim drives authorization — ADR-0004), so these endpoints operate on Cognito via
the CognitoAdmin adapter rather than on DB tables. The DB `users.is_active` column
is kept as a best-effort mirror for suspend/remove; it is not itself an auth gate
(Cognito disable + global sign-out is the real control).

Every endpoint requires the caller to be in the `admin` Cognito group.
"""

from typing import NoReturn

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ...cognito import CognitoAdmin, CognitoAdminError
from ...database import get_db
from ...dependencies import get_cognito_admin, require_admin
from ...events import emit_event
from ...events.registry import (
    USER_DELETED,
    USER_REACTIVATED,
    USER_SUSPENDED,
    EventType,
)
from ...middleware.auth import AuthenticatedUser
from ...models.user import User
from ...schemas.user import (
    AdminUserListResponse,
    AdminUserResponse,
    CreateUserRequest,
    GroupAssignmentRequest,
)

logger = Logger()

router = APIRouter(prefix="/admin/users", tags=["admin"])

# Cognito error code -> HTTP status. Anything unmapped is treated as an upstream
# failure (502) rather than leaking a 500 with a botocore stack.
_ERROR_STATUS = {
    "UsernameExistsException": status.HTTP_409_CONFLICT,
    "AliasExistsException": status.HTTP_409_CONFLICT,
    "UserNotFoundException": status.HTTP_404_NOT_FOUND,
    "ResourceNotFoundException": status.HTTP_404_NOT_FOUND,
    "InvalidParameterException": status.HTTP_400_BAD_REQUEST,
    "InvalidPasswordException": status.HTTP_400_BAD_REQUEST,
}


def _raise_http(err: CognitoAdminError) -> NoReturn:
    raise HTTPException(
        status_code=_ERROR_STATUS.get(err.code, status.HTTP_502_BAD_GATEWAY),
        detail=err.message,
    ) from err


def _to_response(cog: CognitoAdmin, user: dict) -> AdminUserResponse:
    """Attach the user's group memberships (a separate Cognito call) and shape it."""
    groups = cog.list_groups_for_user(user["username"])
    return AdminUserResponse(groups=groups, **user)


async def _mirror_is_active(db: AsyncSession, cognito_sub: str, active: bool) -> None:
    """Best-effort mirror of Cognito enabled-state onto the DB user row, if one
    exists. A user provisioned but never logged in has no row yet — nothing to do."""
    await db.execute(update(User).where(User.cognito_sub == cognito_sub).values(is_active=active))


def _emit_user_lifecycle(db: AsyncSession, event: EventType, user: dict, *, tenant_id: str) -> None:
    """Buffer a user-lifecycle state-change for publish after commit (ADR-0002).

    These actions live in Cognito with a best-effort DB mirror, so there's no
    generic-CRUD emit — the event is raised here. It reflects the admin action
    (fired once Cognito succeeds) regardless of whether a DB mirror row exists."""
    emit_event(
        db,
        event,
        {
            "cognito_sub": user["sub"],
            "username": user["username"],
            "email": user["email"],
        },
        tenant_id=tenant_id,
    )


@router.post("", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: CreateUserRequest,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
) -> AdminUserResponse:
    """Create a Cognito user (Cognito emails a temporary password unless
    suppressed) and optionally assign initial groups. The DB user row appears on
    the user's first authenticated request."""
    try:
        user = cog.create_user(
            email=body.email,
            username=body.username,
            groups=body.groups,
            suppress_invite_email=body.suppress_invite_email,
        )
    except CognitoAdminError as err:
        _raise_http(err)
    return _to_response(cog, user)


@router.get("", response_model=AdminUserListResponse)
async def list_users(
    limit: int = Query(60, ge=1, le=60),
    pagination_token: str | None = None,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
) -> AdminUserListResponse:
    """List Cognito users (a page at a time), each with their group memberships.

    Group memberships require one Cognito call per user; acceptable for the small
    admin-console listings this serves."""
    try:
        result = cog.list_users(limit=limit, pagination_token=pagination_token)
    except CognitoAdminError as err:
        _raise_http(err)
    return AdminUserListResponse(
        users=[_to_response(cog, u) for u in result["users"]],
        next_token=result["next_token"],
    )


@router.get("/{username}", response_model=AdminUserResponse)
async def get_user(
    username: str,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
) -> AdminUserResponse:
    try:
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    return _to_response(cog, user)


@router.post("/{username}/groups", response_model=AdminUserResponse)
async def add_user_to_group(
    username: str,
    body: GroupAssignmentRequest,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
) -> AdminUserResponse:
    try:
        cog.add_to_group(username=username, group=body.group)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    return _to_response(cog, user)


@router.delete("/{username}/groups/{group}", response_model=AdminUserResponse)
async def remove_user_from_group(
    username: str,
    group: str,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
) -> AdminUserResponse:
    try:
        cog.remove_from_group(username=username, group=group)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    return _to_response(cog, user)


@router.post("/{username}/suspend", response_model=AdminUserResponse)
async def suspend_user(
    username: str,
    admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    """Disable the user in Cognito and revoke their refresh tokens. Existing
    access tokens remain valid until they expire (up to the pool's access-token
    TTL); refresh is cut immediately."""
    try:
        cog.disable_user(username)
        cog.global_sign_out(username)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    await _mirror_is_active(db, user["sub"], active=False)
    _emit_user_lifecycle(db, USER_SUSPENDED, user, tenant_id=admin.tenant_id)
    return _to_response(cog, user)


@router.post("/{username}/reactivate", response_model=AdminUserResponse)
async def reactivate_user(
    username: str,
    admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    try:
        cog.enable_user(username)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    await _mirror_is_active(db, user["sub"], active=True)
    _emit_user_lifecycle(db, USER_REACTIVATED, user, tenant_id=admin.tenant_id)
    return _to_response(cog, user)


@router.delete("/{username}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    username: str,
    admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete the user from Cognito and deactivate their DB row (kept, not
    hard-deleted, so historical references like rbac assignments stay resolvable)."""
    try:
        user = cog.get_user(username)  # resolve sub before deletion; 404 if missing
        cog.delete_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    await _mirror_is_active(db, user["sub"], active=False)
    _emit_user_lifecycle(db, USER_DELETED, user, tenant_id=admin.tenant_id)
