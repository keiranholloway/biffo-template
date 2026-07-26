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

from typing import Any

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

from .config import settings

logger = Logger()


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

    def _call(self, op: str, **kwargs: Any) -> dict[str, Any]:
        kwargs["UserPoolId"] = self._pool_id
        try:
            return getattr(self._client, op)(**kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "Unknown")
            message = exc.response.get("Error", {}).get("Message", str(exc))
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
    ) -> dict[str, Any]:
        """Create a user; Cognito emails a temporary password unless suppressed.

        Returns the normalized user (including the generated `sub`). Any `groups`
        are assigned after creation. given_name/family_name are required so a
        user always has a real name in the ID token — an absent name is what
        made the dashboard fall back to showing the raw `sub` UUID.
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
        created = self._call("admin_create_user", **kwargs)["User"]
        for group in groups or []:
            self.add_to_group(username=created["Username"], group=group)
        return _normalize_user(created)

    def get_user(self, username: str) -> dict[str, Any]:
        return _normalize_user(self._call("admin_get_user", Username=username))

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
