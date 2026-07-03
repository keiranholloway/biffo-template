from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from .base import BiffoBaseSchema


class UserResponse(BiffoBaseSchema):
    email: EmailStr
    username: str
    is_active: bool
    last_login_at: datetime | None = None


class UserUpdateRequest(BiffoBaseSchema):
    username: str | None = None
    is_active: bool | None = None


# --- Admin user-management (Cognito-backed) ---------------------------------
# These mirror Cognito, the source of truth for identity and group membership
# (the `cognito:groups` JWT claim drives authorization — ADR-0004). They are not
# DB rows, so they do not extend BiffoBaseSchema (no id/tenant_id/timestamps).


class AdminUserResponse(BaseModel):
    """A Cognito user as surfaced by the admin user-management endpoints."""

    username: str
    sub: str
    email: str
    status: str
    enabled: bool
    groups: list[str] = Field(default_factory=list)
    created_at: datetime | None = None


class CreateUserRequest(BaseModel):
    email: EmailStr
    # Cognito username; defaults to the email when omitted.
    username: str | None = None
    groups: list[str] = Field(default_factory=list)
    # Suppress Cognito's invitation email (e.g. when provisioning in bulk).
    suppress_invite_email: bool = False


class GroupAssignmentRequest(BaseModel):
    group: str


class AdminUserListResponse(BaseModel):
    users: list[AdminUserResponse]
    # Opaque Cognito pagination token; pass back as `pagination_token` for the
    # next page. Null when there are no further pages.
    next_token: str | None = None
