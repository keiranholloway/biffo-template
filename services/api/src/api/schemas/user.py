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
    """A Cognito user as surfaced by the admin user-management endpoints.

    given_name/family_name/phone_number come from Cognito (the identity source
    of truth). organization_id/organization_name/job_role/address come from the
    best-effort DB mirror row (see routers/admin/users.py::_to_response) and are
    None for a user whose row does not exist yet.
    """

    username: str
    sub: str
    email: str
    status: str
    enabled: bool
    groups: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    given_name: str | None = None
    family_name: str | None = None
    phone_number: str | None = None
    organization_id: str | None = None
    organization_name: str | None = None
    job_role: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = None


class CreateUserRequest(BaseModel):
    # The email address IS the identity — there is no separate username to
    # supply. The pool uses username_attributes = ["email"], so Cognito derives
    # its own internal id (see cognito.create_user).
    email: EmailStr
    # Required: this is the exact gap that let "Welcome <uuid>" happen when a
    # Cognito user had no name attribute at all (see the sibling dashboard fix).
    given_name: str = Field(min_length=1, max_length=128)
    family_name: str = Field(min_length=1, max_length=128)
    phone_number: str | None = None
    groups: list[str] = Field(default_factory=list)
    # Non-identity profile fields, stored on the DB mirror row rather than
    # Cognito — see models/user.py.
    organization_id: str | None = None
    job_role: str | None = Field(default=None, max_length=128)
    address_line1: str | None = Field(default=None, max_length=255)
    address_line2: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=128)
    region: str | None = Field(default=None, max_length=128)
    postal_code: str | None = Field(default=None, max_length=32)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    # Suppress Cognito's invitation email (e.g. when provisioning in bulk).
    suppress_invite_email: bool = False


class AdminUserUpdateRequest(BaseModel):
    """Edit an existing user's name/phone (Cognito) and/or company/job role/
    address (DB mirror row) — #633. Every field is optional, and PATCH
    semantics apply: the router only touches fields the caller actually set
    (Pydantic's `model_fields_set`/`exclude_unset`), so omitting a field
    leaves it unchanged — including explicitly sending `null` to clear one,
    which IS "set" as far as `exclude_unset` is concerned. Unlike
    CreateUserRequest, given_name/family_name are optional here: this edits
    an existing user who already has a name, not a required part of onboarding
    a new one.
    """

    given_name: str | None = Field(default=None, min_length=1, max_length=128)
    family_name: str | None = Field(default=None, min_length=1, max_length=128)
    phone_number: str | None = None
    organization_id: str | None = None
    job_role: str | None = Field(default=None, max_length=128)
    address_line1: str | None = Field(default=None, max_length=255)
    address_line2: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=128)
    region: str | None = Field(default=None, max_length=128)
    postal_code: str | None = Field(default=None, max_length=32)
    country: str | None = Field(default=None, min_length=2, max_length=2)


class GroupAssignmentRequest(BaseModel):
    group: str


class AdminUserListResponse(BaseModel):
    users: list[AdminUserResponse]
    # Opaque Cognito pagination token; pass back as `pagination_token` for the
    # next page. Null when there are no further pages.
    next_token: str | None = None
