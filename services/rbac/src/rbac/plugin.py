"""RbacPlugin — this plugin's BiffoPluginBase implementation.

Seeds a baseline role set on install and reacts to ``biffo.core/user.created``
by auto-assigning the default "viewer" role. Core publishes ``user.created`` when
a user record is first created on first login (``routers/auth.py``, ADR-0010), so
this subscription is live once the plugin is installed.
"""

from __future__ import annotations

import asyncio
from typing import Any

from aws_lambda_powertools import Logger
from biffo_plugin_sdk import BiffoAPIClient, BiffoEvent, BiffoPluginBase, load_manifest

from .manifest import MANIFEST_PATH
from .permissions import PermissionChecker

logger = Logger()

DEFAULT_ROLE_NAME = "viewer"
_PLUGIN_BASE_PATH = "/api/v1/plugins/rbac"

# Baseline roles created by on_install(). "system." prefix marks
# undeletable built-ins per the issue's notes (enforced at the application
# layer only — see README's generic-CRUD limitations).
_SEED_ROLES: tuple[dict[str, Any], ...] = (
    {
        "name": "system.admin",
        "description": "Full access to every resource.",
        "is_system": True,
    },
    {
        "name": "editor",
        "description": "Can create and modify content.",
        "is_system": False,
    },
    {
        "name": DEFAULT_ROLE_NAME,
        "description": "Read-only access. Assigned automatically to new users.",
        "is_system": False,
    },
)


class RbacPlugin(BiffoPluginBase):
    """The RBAC reference plugin (issue #27)."""

    def __init__(self, api: BiffoAPIClient | None = None) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        super().__init__(manifest, api=api)
        self.permissions = PermissionChecker(self.api)

        @self.subscribe("user.created")
        async def _on_user_created(event: BiffoEvent) -> None:
            await self._assign_default_role(event)

    def on_install(self) -> None:
        """Seed the baseline role set idempotently.

        ``BiffoPluginBase.on_install`` (SDK, issue #17) is declared
        synchronous — the CLI calls it as a plain function, not from an
        event loop — but ``BiffoAPIClient`` (issue #15) is entirely async.
        This bridges the two with ``asyncio.run`` rather than redeclaring
        ``on_install`` as ``async def`` (which would satisfy Python's ABC
        machinery at runtime but violate the base class's typed contract —
        pyright correctly flags a sync-returning-None override becoming
        one that returns a coroutine).

        Only safe to call from a genuinely synchronous context (e.g. the
        CLI's install flow) — ``asyncio.run`` raises if a loop is already
        running. Callers already inside an event loop (e.g. tests combining
        this with other async plugin calls) should ``await
        seed_baseline_roles()`` directly instead.
        """
        asyncio.run(self.seed_baseline_roles())

    async def seed_baseline_roles(self) -> None:
        """The async core of on_install(): generic CRUD (issue #19) has no
        upsert — every POST creates a new row — so this lists existing
        roles first and only creates the ones missing by name, rather than
        relying on the unique index to reject duplicates (which would
        surface as a raw 400 IntegrityError instead of a clean no-op on a
        repeated install)."""
        existing = await self.api.get(f"{_PLUGIN_BASE_PATH}/roles")
        existing_names = {row.get("name") for row in existing}
        for role in _SEED_ROLES:
            if role["name"] not in existing_names:
                await self.api.post(f"{_PLUGIN_BASE_PATH}/roles", json=dict(role))

    def on_uninstall(self) -> None:
        """No-op: dropping this plugin's tables is the CLI's job (ADR-0003
        section 9 — ``biffo plugin uninstall`` applies a generated migration
        that drops them). This hook exists for plugin-side cleanup beyond
        that, which RBAC doesn't need."""
        return None

    async def _resolve_role_id(self, name: str) -> str | None:
        """Find a role's id by name.

        The generic list route (issue #19) has no query-param filtering
        (that's a follow-up per ADR-0004), so this lists every role and
        filters client-side — fine at the expected cardinality of a roles
        table (tens of rows), not a design intended to scale to thousands.
        """
        roles = await self.api.get(f"{_PLUGIN_BASE_PATH}/roles")
        for role in roles:
            if role.get("name") == name:
                role_id = role.get("id")
                return str(role_id) if role_id is not None else None
        return None

    async def _assign_default_role(self, event: BiffoEvent) -> None:
        user_id = event.payload.get("cognito_sub") or event.payload.get("user_id")
        if not user_id:
            logger.warning(
                "user.created event missing cognito_sub/user_id in payload; "
                "skipping default role assignment",
                extra={"payload": event.payload},
            )
            return

        role_id = await self._resolve_role_id(DEFAULT_ROLE_NAME)
        if role_id is None:
            logger.warning(
                f"Default role {DEFAULT_ROLE_NAME!r} not found; on_install() "
                "must seed baseline roles before user.created events are "
                "dispatched."
            )
            return

        await self.api.post(
            f"{_PLUGIN_BASE_PATH}/assignments",
            json={"user_id": user_id, "role_id": role_id, "assigned_by": None},
        )
        self.permissions.invalidate()
