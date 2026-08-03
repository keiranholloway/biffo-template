"""Thin wrapper over the Cognito user-pool admin API.

User identity and group membership are sourced from Cognito (the `cognito:groups`
JWT claim drives authorization — ADR-0004), so user management (add users, assign
to groups, suspend/remove) operates on Cognito directly rather than on DB tables.

This module is the single place the Core API calls `cognito-idp` admin operations.
The IAM permissions for these calls are granted narrowly to the Core API Lambda's
execution role, scoped to one pool ARN (see modules/cloud/aws/compute); runtime
reachability in NAT-less environments is provided by the cognito-idp interface VPC
endpoint (see modules/cloud/aws/networking).

Unlike EventPublisher (best-effort, swallows errors), these operations must surface
failures to the caller — a failed "create user" is a real error, not something to
log-and-continue. Botocore `ClientError`s are re-raised as `CognitoAdminError` with
the Cognito error code preserved so routers can map it to an HTTP status without
importing botocore.
"""

from __future__ import annotations

import secrets
import string
from typing import Any

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

from .config import settings

logger = Logger()

REDACTED = "***"

# Redacting a 3-character string would punch holes through unrelated text in
# whatever it's embedded in and destroy the diagnostic value redaction exists
# to preserve — so, like `MIN_REDACTABLE` in `cli/src/adapters/git/index.ts`
# (#1171), anything shorter than this is left alone rather than blanked. Real
# Cognito temporary passwords satisfy the pool's own minimum length (8), which
# is itself above this floor.
_MIN_REDACTABLE = 8


def redact_secret(text: str, secret: str | None) -> str:
    """Replace every occurrence of `secret` in `text` with `REDACTED`.

    Mirrors `redactSecrets` in `cli/src/adapters/git/index.ts` (#1171): plain
    substring replacement, never a `re` pattern built from the secret — a
    password containing `.` or `+` would otherwise become a regex matching far
    more than itself. There is no percent-encoded form to additionally strip
    the way a URL-embedded token needs (#1169) — a Cognito TemporaryPassword
    never passes through URL encoding on its way into a boto3 call or a
    Cognito error message, so the raw form is the only one that can appear.

    `secret` of `None`, empty, or shorter than `_MIN_REDACTABLE` is left
    alone rather than blanking unrelated text — see `_MIN_REDACTABLE`.
    """
    if not secret or len(secret) < _MIN_REDACTABLE:
        return text
    return text.replace(secret, REDACTED)


_UPPER = string.ascii_uppercase
_LOWER = string.ascii_lowercase
_DIGITS = string.digits

# A conservative subset of what Cognito accepts (it allows a much wider set,
# including `^ $ * . [ ] { } ( ) ? " ! @ # % & / \ , > < ' : ; | _ ~ ``).
#
# `$` and `&` are deliberately EXCLUDED, and this is not fussiness. The only
# reason a caller generates a temporary password at all is to put it somewhere
# Cognito will not — `admin_create_user` never returns the password it set, so
# an invite flow that sends a branded email has to generate one and pass it as
# `TemporaryPassword`. That destination is an HTML email body, where `&` starts
# an entity reference and `$` is a replacement token in several templating
# engines. A password containing either can arrive mangled, or silently
# truncated, and the user simply cannot sign in.
#
# Folded upstream from tabsii-platform, which hit this in tabsii-crm#52 and
# narrowed its own copy. The template's set still carried `$` and `&`, so the
# next `biffo core upgrade` would have overwritten the instance's fix with the
# bug it was written to cure — the `_extract_detail` shape AGENTS.md §9
# describes, caught this time before the one-way merge ran rather than after.
#
# Quotes, angle brackets and backslashes are excluded for the same reason.
_SYMBOLS = "!@#%^*()-_=+"


def generate_temporary_password(length: int = 20) -> str:
    """Generate a random password for `CognitoAdmin.create_user`'s
    `temporary_password` parameter.

    `admin_create_user` never returns whatever password Cognito itself would
    have generated, so a caller that wants to build its own invite email
    (carrying the password itself, e.g. via an event-driven "Send email"
    automation, rather than relying on Cognito's own bare-bones invite
    template which only supports `{username}`/`{####}`) has no way to learn
    it unless it supplies one — this is that generator. Core's own policy:
    20 characters drawn from upper/lower/digit/symbol, with at least one of
    each guaranteed, comfortably clearing the pool's default minimum (8) and
    complexity requirements without the caller needing to know them.

    Uses `secrets`, not `random` — this value is a live login credential from
    the moment it's generated, not just after Cognito accepts it.
    """
    if length < 8:
        raise ValueError("temporary passwords must be at least 8 characters")
    required = [
        secrets.choice(_UPPER),
        secrets.choice(_LOWER),
        secrets.choice(_DIGITS),
        secrets.choice(_SYMBOLS),
    ]
    alphabet = _UPPER + _LOWER + _DIGITS + _SYMBOLS
    password = required + [secrets.choice(alphabet) for _ in range(length - len(required))]
    secrets.SystemRandom().shuffle(password)
    return "".join(password)


class CognitoAdminError(Exception):
    """A Cognito admin operation failed.

    `code` is the Cognito error code (e.g. "UserNotFoundException",
    "UsernameExistsException", "GroupExistsException") so callers can translate
    it to an HTTP status. `code` is "Unknown" for non-ClientError failures.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _attributes_to_dict(attributes: list[dict[str, str]]) -> dict[str, str]:
    """Flatten Cognito's [{Name, Value}, ...] attribute list into a dict."""
    return {a["Name"]: a["Value"] for a in attributes or []}


def _normalize_user(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize an AdminGetUser / ListUsers user record into a stable shape.

    AdminGetUser returns attributes under `UserAttributes`; ListUsers under
    `Attributes` — handle both.
    """
    attrs = _attributes_to_dict(raw.get("UserAttributes") or raw.get("Attributes") or [])
    return {
        "username": raw.get("Username", ""),
        "sub": attrs.get("sub", ""),
        "email": attrs.get("email", ""),
        "status": raw.get("UserStatus", ""),
        "enabled": raw.get("Enabled", True),
        "created_at": raw.get("UserCreateDate"),
        "given_name": attrs.get("given_name") or None,
        "family_name": attrs.get("family_name") or None,
        "phone_number": attrs.get("phone_number") or None,
    }


class CognitoAdmin:
    """Admin operations against a single Cognito user pool.

    The `username` parameter throughout accepts a Cognito username or the user's
    immutable `sub` — Cognito's Admin* APIs treat the sub as a valid identifier.
    """

    def __init__(
        self,
        *,
        client: Any = None,
        user_pool_id: str | None = None,
        region: str | None = None,
    ) -> None:
        self._pool_id = user_pool_id if user_pool_id is not None else settings.cognito_user_pool_id
        self._client = client or boto3.client(
            "cognito-idp", region_name=region or settings.cognito_region
        )

    def _call(
        self, op: str, *, redact: list[str | None] | None = None, **kwargs: Any
    ) -> dict[str, Any]:
        """Invoke a `cognito-idp` admin operation, translating a `ClientError`
        into a `CognitoAdminError`.

        `redact` lists any secret-shaped argument the caller passed in this
        `kwargs` (e.g. a `TemporaryPassword`) so it can be stripped out of the
        raised error's message — defense-in-depth against Cognito ever
        echoing a rejected value back in an error string (it doesn't today
        for `InvalidPasswordException`, but nothing about the API contract
        promises that stays true). The log line below never included `kwargs`
        in the first place, only `op`/`code`, so no separate redaction is
        needed there.
        """
        kwargs["UserPoolId"] = self._pool_id
        try:
            return getattr(self._client, op)(**kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "Unknown")
            message = exc.response.get("Error", {}).get("Message", str(exc))
            for secret in redact or []:
                message = redact_secret(message, secret)
            logger.warning("Cognito admin call failed", extra={"op": op, "code": code})
            raise CognitoAdminError(code, message) from exc

    # --- user lifecycle -------------------------------------------------------

    def create_user(
        self,
        *,
        email: str,
        given_name: str,
        family_name: str,
        phone_number: str | None = None,
        groups: list[str] | None = None,
        suppress_invite_email: bool = False,
        temporary_password: str | None = None,
    ) -> dict[str, Any]:
        """Create a user; Cognito emails a temporary password unless suppressed.

        Returns the normalized user (including the generated `sub`). Any `groups`
        are assigned after creation. given_name/family_name are required so a
        user always has a real name in the ID token — an absent name is what
        made the dashboard fall back to showing the raw `sub` UUID.

        `temporary_password`, when given, is forwarded to Cognito as
        `TemporaryPassword` instead of letting it silently generate one — the
        same `FORCE_CHANGE_PASSWORD` state either way. `admin_create_user`
        never returns whatever password it picked, so this is the only way a
        caller can know the value, e.g. to build its own branded invite email
        (carrying the password itself) rather than relying on Cognito's own
        template. Use `generate_temporary_password()` to produce one, or
        `suppress_invite_email=True` alongside it if Cognito's own email
        should stay silent while a different flow sends the real one.

        This value is a live login credential end to end: it is never logged
        (see `_call`'s docstring — the log line there never carried `kwargs`),
        never appears in the normalized user this method returns, and is
        stripped from any `CognitoAdminError` this call raises even though
        Cognito is not known to ever echo a rejected password back in one.
        """
        attributes = [
            {"Name": "email", "Value": email},
            {"Name": "email_verified", "Value": "true"},
            {"Name": "given_name", "Value": given_name},
            {"Name": "family_name", "Value": family_name},
        ]
        if phone_number:
            attributes.append({"Name": "phone_number", "Value": phone_number})
        kwargs: dict[str, Any] = {
            # The pool sets username_attributes = ["email"], so Cognito IGNORES
            # this value and generates its own username (a UUID equal to `sub`).
            # It is still a required parameter, and passing the address is what
            # makes the intent readable — the created user's `Username` in the
            # response is the generated id, not this.
            "Username": email,
            "UserAttributes": attributes,
            "DesiredDeliveryMediums": ["EMAIL"],
        }
        if suppress_invite_email:
            kwargs["MessageAction"] = "SUPPRESS"
        if temporary_password:
            kwargs["TemporaryPassword"] = temporary_password
        created = self._call("admin_create_user", redact=[temporary_password], **kwargs)["User"]
        for group in groups or []:
            self.add_to_group(username=created["Username"], group=group)
        return _normalize_user(created)

    def get_user(self, username: str) -> dict[str, Any]:
        return _normalize_user(self._call("admin_get_user", Username=username))

    def update_attributes(
        self,
        username: str,
        *,
        given_name: str | None = None,
        family_name: str | None = None,
        phone_number: str | None = None,
    ) -> None:
        """Update one or more Cognito attributes on an existing user.

        Only the provided (non-None) fields are sent, so an admin editing just
        job_role (a DB-only field — see routers/admin/users.py) never touches
        Cognito at all, and editing just given_name never touches phone_number.
        """
        attributes = []
        if given_name is not None:
            attributes.append({"Name": "given_name", "Value": given_name})
        if family_name is not None:
            attributes.append({"Name": "family_name", "Value": family_name})
        if phone_number is not None:
            attributes.append({"Name": "phone_number", "Value": phone_number})
        if not attributes:
            return
        self._call("admin_update_user_attributes", Username=username, UserAttributes=attributes)

    def reset_password(self, username: str) -> None:
        """Force the user onto Cognito's own Forgot Password flow.

        This invalidates their current password and moves their status to
        RESET_REQUIRED immediately — it does NOT itself send anything. Cognito
        emails a verification code only when the user next attempts "Forgot
        password" (or is redirected there by a blocked sign-in attempt). There
        is no Cognito Admin API that both resets a CONFIRMED user's password
        and emails a new one in a single call; that combination only exists
        for a user still in FORCE_CHANGE_PASSWORD (see create_user's
        MessageAction/DesiredDeliveryMediums, which is a different state).
        """
        self._call("admin_reset_user_password", Username=username)

    def list_users(self, *, limit: int = 60, pagination_token: str | None = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"Limit": limit}
        if pagination_token:
            kwargs["PaginationToken"] = pagination_token
        resp = self._call("list_users", **kwargs)
        return {
            "users": [_normalize_user(u) for u in resp.get("Users", [])],
            "next_token": resp.get("PaginationToken"),
        }

    def disable_user(self, username: str) -> None:
        self._call("admin_disable_user", Username=username)

    def enable_user(self, username: str) -> None:
        self._call("admin_enable_user", Username=username)

    def delete_user(self, username: str) -> None:
        self._call("admin_delete_user", Username=username)

    def global_sign_out(self, username: str) -> None:
        """Revoke the user's refresh tokens immediately (issued access tokens
        remain valid until they expire — up to the pool's access-token TTL)."""
        self._call("admin_user_global_sign_out", Username=username)

    # --- group membership -----------------------------------------------------

    def add_to_group(self, *, username: str, group: str) -> None:
        self._call("admin_add_user_to_group", Username=username, GroupName=group)

    def remove_from_group(self, *, username: str, group: str) -> None:
        self._call("admin_remove_user_from_group", Username=username, GroupName=group)

    def list_groups_for_user(self, username: str) -> list[str]:
        resp = self._call("admin_list_groups_for_user", Username=username)
        return [g["GroupName"] for g in resp.get("Groups", [])]

    def list_groups(self) -> list[str]:
        resp = self._call("list_groups")
        return [g["GroupName"] for g in resp.get("Groups", [])]
