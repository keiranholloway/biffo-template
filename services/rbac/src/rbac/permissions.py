"""In-process permission evaluation for the RBAC plugin.

Not declared in ``biffo.plugin.json``'s ``api_routes`` — see the design note
in ``services/api/src/api/models/plugin_route.py``: a manifest route can only
synthesize a single generic CRUD operation (list/read/create/update/delete)
against one of the manifest's own tables. ``check_permission`` joins three
tables (``rbac_user_roles`` -> ``rbac_role_permissions`` -> ``rbac_permissions``),
filters expired assignments, and applies allow/deny precedence — none of
which is expressible as a single-table CRUD operation, so the Core API's
route-synthesis mechanism (issue #19) cannot serve it. This plugin evaluates
it itself, over the same generic CRUD routes every other caller uses
(``BiffoAPIClient``, no direct DB access — ADR-0002).

DEPLOYMENT NOTE: there is currently no Terraform wiring (API Gateway route,
Lambda Function URL, etc.) exposing this over HTTP — that depends on chunk
12's conditional plugin Terraform inclusion (issue #25), which does not
exist yet. ``PermissionChecker`` is fully unit-tested and ready to be called
from whatever entrypoint that infra eventually adds (see README.md).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime

from biffo_plugin_sdk import BiffoAPIClient

_DEFAULT_TTL_SECONDS = 30.0
_PLUGIN_BASE_PATH = "/api/v1/plugins/rbac"


@dataclass(frozen=True)
class _CacheEntry:
    value: bool
    expires_at: float


def _is_assignment_active(expires_at: str | None, now: datetime) -> bool:
    """Whether a role assignment with the given ``expires_at`` is still active.

    ``None``/empty means "never expires". An unparseable value fails closed
    (treated as expired) rather than open — this guards a security decision,
    so an unexpected value should deny access rather than silently grant it.
    """
    if not expires_at:
        return True
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if expiry.tzinfo is None:
        # Naive timestamps aren't expected from the Core API (every
        # DateTime column here is `timezone=True`) — fail closed rather
        # than guess how to compare it to an aware `now`.
        return False
    return expiry > now


class PermissionChecker:
    """Evaluates ``check_permission(user_id, resource, action)`` with a small
    in-memory TTL cache, since role/permission lookups otherwise happen on
    every authenticated request (the issue's own caching note).

    In-memory only: correct within a single warm Lambda execution
    environment, not shared across concurrent Lambda instances. A shared
    cache (e.g. Redis) is a natural follow-up once the plugin has its own
    provisioned cache infra — not something this reference implementation
    invents unsupported infrastructure for ahead of chunk 12 (#25).
    """

    def __init__(
        self, api: BiffoAPIClient, ttl_seconds: float = _DEFAULT_TTL_SECONDS
    ) -> None:
        self._api = api
        self._ttl_seconds = ttl_seconds
        self._cache: dict[tuple[str, str, str], _CacheEntry] = {}

    def invalidate(self) -> None:
        """Clear the cache. Call after any role/permission/assignment mutation."""
        self._cache.clear()

    async def check(self, user_id: str, resource: str, action: str) -> bool:
        key = (user_id, resource, action)
        now_monotonic = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and cached.expires_at > now_monotonic:
            return cached.value

        result = await self._evaluate(user_id, resource, action)
        self._cache[key] = _CacheEntry(
            value=result, expires_at=now_monotonic + self._ttl_seconds
        )
        return result

    async def _evaluate(self, user_id: str, resource: str, action: str) -> bool:
        now = datetime.now().astimezone()

        assignments = await self._api.get(f"{_PLUGIN_BASE_PATH}/assignments")
        active_role_ids = {
            a["role_id"]
            for a in assignments
            if a.get("user_id") == user_id
            and _is_assignment_active(a.get("expires_at"), now)
        }
        if not active_role_ids:
            return False

        role_permissions = await self._api.get(f"{_PLUGIN_BASE_PATH}/role-permissions")
        permission_ids = {
            rp["permission_id"]
            for rp in role_permissions
            if rp.get("role_id") in active_role_ids
        }
        if not permission_ids:
            return False

        permissions = await self._api.get(f"{_PLUGIN_BASE_PATH}/permissions")
        matching = [
            p
            for p in permissions
            if p.get("id") in permission_ids
            and p.get("resource") == resource
            and p.get("action") == action
        ]
        if not matching:
            return False

        # Deny takes precedence over allow if a role somehow grants both.
        if any(p.get("effect") == "deny" for p in matching):
            return False
        return any((p.get("effect") or "allow") == "allow" for p in matching)
