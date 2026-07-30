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
from ...identity import UserProfile, get_identity_provider
from ...middleware.auth import AuthenticatedUser
from ...schemas.user import (
    AdminUserListResponse,
    AdminUserResponse,
    AdminUserUpdateRequest,
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


def _reject_if_self(admin: AuthenticatedUser, target_sub: str, action: str) -> None:
    """Block an admin from locking themselves out (#630): a caller could
    otherwise suspend or delete their own account — or remove themselves from
    the `admin` group — with no way back in short of a Terraform re-apply to
    recreate the bootstrap admin user, as happened in production. Compares
    resolved `sub`, not the raw `username` path param, since Cognito's Admin*
    APIs accept either an email or a sub as `username` (see cognito.py)."""
    if target_sub == admin.sub:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"You cannot {action} your own account.",
        )


def _to_response(
    cog: CognitoAdmin, user: dict, profile: UserProfile | None = None
) -> AdminUserResponse:
    """Attach the user's group memberships (a separate Cognito call) and the
    store-only profile fields (organization/job role/address), if a mirror record
    exists yet, and shape it.

    `organization_name` arrives on the profile as a resolved string. It used to be
    reached through an ORM relationship, which a provider over its own schema has
    no foreign key to supply — so carrying it across the seam would have
    re-coupled exactly what ADR-0012 separates."""
    groups = cog.list_groups_for_user(user["username"])
    return AdminUserResponse(
        groups=groups,
        organization_id=profile.organization_id if profile else None,
        organization_name=profile.organization_name if profile else None,
        job_role=profile.job_role if profile else None,
        address_line1=profile.address_line1 if profile else None,
        address_line2=profile.address_line2 if profile else None,
        city=profile.city if profile else None,
        region=profile.region if profile else None,
        postal_code=profile.postal_code if profile else None,
        country=profile.country if profile else None,
        **user,
    )


# The three helpers below are this module's whole data-access surface, and they now
# go through the ADR-0012 provider instead of querying the Core user model. Kept as
# named helpers rather than inlined so the ten endpoints calling them read
# unchanged and the reasons recorded in their docstrings survive.


async def _load_profile(db: AsyncSession, cognito_sub: str) -> UserProfile | None:
    """Fetch the profile record for one user, or None if the store holds none."""
    return await get_identity_provider().get_profile(db, cognito_sub)


async def _load_profiles(db: AsyncSession, cognito_subs: list[str]) -> dict[str, UserProfile]:
    """Batch version of `_load_profile` for list endpoints — one query rather
    than one per user."""
    return await get_identity_provider().get_profiles(db, cognito_subs)


async def _mirror_is_active(db: AsyncSession, cognito_sub: str, active: bool) -> None:
    """Best-effort mirror of Cognito enabled-state onto the profile record, if one
    exists. A user provisioned but never logged in has none yet — nothing to do,
    and that is success rather than a 404."""
    await get_identity_provider().set_active(db, cognito_sub, active)


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
    admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    """Create a Cognito user (Cognito emails a temporary password unless
    suppressed) and optionally assign initial groups.

    Unlike the rest of this router, this also eagerly creates the DB mirror row
    (rather than waiting for the user's first login, as `routers/auth.py`
    otherwise does): organization/job role/address are DB-only fields with
    nowhere else to live, so without this they would have no way to be set at
    creation time. The row is looked up by `cognito_sub` on first login, so
    that flow just updates `last_login_at` on the row this creates.
    """
    try:
        user = cog.create_user(
            email=body.email,
            given_name=body.given_name,
            family_name=body.family_name,
            phone_number=body.phone_number,
            groups=body.groups,
            suppress_invite_email=body.suppress_invite_email,
        )
    except CognitoAdminError as err:
        _raise_http(err)
    profile, _ = await get_identity_provider().upsert_profile(
        db,
        subject=user["sub"],
        tenant_id=admin.tenant_id,
        email=user["email"],
        username=user["username"],
        fields={
            "organization_id": body.organization_id,
            "job_role": body.job_role,
            "address_line1": body.address_line1,
            "address_line2": body.address_line2,
            "city": body.city,
            "region": body.region,
            "postal_code": body.postal_code,
            "country": body.country,
        },
    )
    return _to_response(cog, user, profile)


@router.get("", response_model=AdminUserListResponse)
async def list_users(
    limit: int = Query(60, ge=1, le=60),
    pagination_token: str | None = None,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListResponse:
    """List Cognito users (a page at a time), each with their group memberships.

    Group memberships require one Cognito call per user; acceptable for the small
    admin-console listings this serves. Profile rows are fetched in one batched
    query rather than per-user."""
    try:
        result = cog.list_users(limit=limit, pagination_token=pagination_token)
    except CognitoAdminError as err:
        _raise_http(err)
    profiles = await _load_profiles(db, [u["sub"] for u in result["users"]])
    return AdminUserListResponse(
        users=[_to_response(cog, u, profiles.get(u["sub"])) for u in result["users"]],
        next_token=result["next_token"],
    )


@router.get("/{username}", response_model=AdminUserResponse)
async def get_user(
    username: str,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    try:
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    profile = await _load_profile(db, user["sub"])
    return _to_response(cog, user, profile)


@router.patch("/{username}", response_model=AdminUserResponse)
async def update_user(
    username: str,
    body: AdminUserUpdateRequest,
    admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    """Edit an existing user's name/phone (Cognito) and/or company/job role/
    address (DB mirror row) — #633.

    PATCH semantics: only fields the caller actually set are touched
    (`exclude_unset`), so omitting a field leaves it unchanged. Cognito is
    only called at all if given_name/family_name/phone_number were among the
    set fields — editing just job_role never touches Cognito.
    """
    updates = body.model_dump(exclude_unset=True)
    cognito_fields = {
        k: updates[k] for k in ("given_name", "family_name", "phone_number") if k in updates
    }
    profile_fields = {k: v for k, v in updates.items() if k not in cognito_fields}

    try:
        if cognito_fields:
            cog.update_attributes(username, **cognito_fields)
        target = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)

    if profile_fields:
        # One upsert instead of a load / branch / blind-setattr / flush. The
        # insert-or-update decision belongs to whoever owns the store, and
        # `profile_fields` is now validated against `WRITABLE_PROFILE_FIELDS`
        # rather than being "everything that was not a Cognito field" applied with
        # `setattr` — a key the request happened to carry can no longer be written
        # straight onto the record.
        profile, _ = await get_identity_provider().upsert_profile(
            db,
            subject=target["sub"],
            tenant_id=admin.tenant_id,
            email=target["email"],
            username=target["username"],
            fields=profile_fields,
        )
    else:
        profile = await _load_profile(db, target["sub"])

    return _to_response(cog, target, profile)


@router.post("/{username}/reset-password", response_model=AdminUserResponse)
async def reset_user_password(
    username: str,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    """Force the user onto Cognito's own Forgot Password flow (#633).

    This invalidates their current password immediately — it does NOT itself
    email anything. Cognito only sends a code once the user next attempts
    "Forgot password" (or is redirected there by a blocked sign-in). See
    CognitoAdmin.reset_password's docstring for why no single Admin API call
    both resets a CONFIRMED user's password and emails a new one.
    """
    try:
        cog.reset_password(username)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    profile = await _load_profile(db, user["sub"])
    return _to_response(cog, user, profile)


@router.post("/{username}/groups", response_model=AdminUserResponse)
async def add_user_to_group(
    username: str,
    body: GroupAssignmentRequest,
    _admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    try:
        cog.add_to_group(username=username, group=body.group)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    profile = await _load_profile(db, user["sub"])
    return _to_response(cog, user, profile)


@router.delete("/{username}/groups/{group}", response_model=AdminUserResponse)
async def remove_user_from_group(
    username: str,
    group: str,
    admin: AuthenticatedUser = Depends(require_admin),
    cog: CognitoAdmin = Depends(get_cognito_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserResponse:
    try:
        # Only the admin-group removal is a self-lockout risk (#630) — leaving
        # any other group is harmless, so this is scoped to that one case
        # rather than blocking all self group-edits.
        if group == "admin":
            target = cog.get_user(username)
            _reject_if_self(admin, target["sub"], "remove yourself from the admin group")
        cog.remove_from_group(username=username, group=group)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    profile = await _load_profile(db, user["sub"])
    return _to_response(cog, user, profile)


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
        target = cog.get_user(username)
        _reject_if_self(admin, target["sub"], "suspend")
        cog.disable_user(username)
        cog.global_sign_out(username)
        user = cog.get_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    await _mirror_is_active(db, user["sub"], active=False)
    _emit_user_lifecycle(db, USER_SUSPENDED, user, tenant_id=admin.tenant_id)
    profile = await _load_profile(db, user["sub"])
    return _to_response(cog, user, profile)


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
    profile = await _load_profile(db, user["sub"])
    return _to_response(cog, user, profile)


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
        _reject_if_self(admin, user["sub"], "delete")
        cog.delete_user(username)
    except CognitoAdminError as err:
        _raise_http(err)
    await _mirror_is_active(db, user["sub"], active=False)
    _emit_user_lifecycle(db, USER_DELETED, user, tenant_id=admin.tenant_id)
