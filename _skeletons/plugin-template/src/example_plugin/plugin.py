"""ExamplePlugin — this plugin's BiffoPluginBase implementation.

Seeds a single default widget on install and reacts to
`biffo.core/UserCreated` by logging the new user. Replace both with real
logic for your own plugin — this exists to show a working, correctly-wired
skeleton: constructor -> manifest loading -> `self.api` -> `@self.subscribe`
-> `on_install`/`on_uninstall`, exercised end to end by the tests in
`tests/test_example_plugin.py`.

Modelled directly on the RBAC reference plugin's
`services/rbac/src/rbac/plugin.py` (PR #76) in the biffo-template monorepo —
see that file (and its README) for a more elaborate example with multiple
tables, an event-driven side effect, and an in-process (non-CRUD) helper.
"""

from __future__ import annotations

import asyncio
from typing import Any

from aws_lambda_powertools import Logger
from biffo_plugin_sdk import BiffoAPIClient, BiffoEvent, BiffoPluginBase, load_manifest

from .manifest import MANIFEST_PATH

logger = Logger()

_PLUGIN_BASE_PATH = "/api/v1/plugins/example-plugin"

# Seeded by on_install(). Real plugins would seed whatever baseline data
# their feature needs (RBAC's plugin.py seeds three roles, for example).
_DEFAULT_WIDGET: dict[str, Any] = {
    "name": "starter-widget",
    "description": "Created automatically by on_install(). Safe to delete.",
    "is_active": True,
}


class ExamplePlugin(BiffoPluginBase):
    """The example plugin shipped with the plugin repository template."""

    def __init__(self, api: BiffoAPIClient | None = None) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        super().__init__(manifest, api=api)

        @self.subscribe("UserCreated")
        async def _on_user_created(event: BiffoEvent) -> None:
            await self._log_user_created(event)

    def on_install(self) -> None:
        """Called by the CLI when the plugin is installed.

        `BiffoPluginBase.on_install` is declared synchronous but
        `BiffoAPIClient` is entirely async (same constraint the RBAC
        reference plugin documents) — bridge with `asyncio.run` here and
        keep the actual async logic in the public `seed_default_widget()`,
        which tests and any future async caller can `await` directly.
        """
        asyncio.run(self.seed_default_widget())

    async def seed_default_widget(self) -> None:
        """The async core of on_install().

        Generic CRUD (issue #19) has no upsert — every POST creates a new
        row — so this lists existing widgets first and only creates the
        default one if it's missing by name, making repeated installs a
        no-op instead of creating duplicate rows.
        """
        existing = await self.api.get(f"{_PLUGIN_BASE_PATH}/widgets")
        existing_names = {row.get("name") for row in existing}
        if _DEFAULT_WIDGET["name"] not in existing_names:
            await self.api.post(f"{_PLUGIN_BASE_PATH}/widgets", json=dict(_DEFAULT_WIDGET))

    def on_uninstall(self) -> None:
        """Called by the CLI when the plugin is uninstalled.

        No-op: dropping this plugin's tables is the CLI's job (ADR-0003
        section 9 — `biffo plugin uninstall` applies a generated migration
        that drops them). Override this if your plugin needs additional
        cleanup beyond that (e.g. deleting objects it created outside its
        own tables).
        """
        return None

    async def _log_user_created(self, event: BiffoEvent) -> None:
        """Example event handler. Replace with real logic, or remove the
        `@self.subscribe` registration in `__init__` if your plugin doesn't
        need to react to this event."""
        logger.info(
            "New user created",
            extra={"tenant_id": event.tenant_id, "payload": event.payload},
        )
