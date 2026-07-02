"""Tests for ExamplePlugin: manifest loading, lifecycle hooks, and the
UserCreated event subscription.

Modelled on the RBAC reference plugin's
`services/rbac/tests/test_rbac_plugin.py` (PR #76) in the biffo-template
monorepo.
"""

from __future__ import annotations

from biffo_plugin_sdk import BiffoEvent
from fakes import FakeCoreApi

from example_plugin.plugin import _DEFAULT_WIDGET, ExamplePlugin


def _make_plugin() -> tuple[ExamplePlugin, FakeCoreApi]:
    fake = FakeCoreApi()
    plugin = ExamplePlugin(api=fake.client())
    return plugin, fake


class TestManifestLoading:
    def test_manifest_name_and_version(self) -> None:
        plugin, _ = _make_plugin()
        assert plugin.manifest.name == "example-plugin"
        assert plugin.manifest.version == "0.1.0"

    def test_manifest_declares_the_widgets_table(self) -> None:
        plugin, _ = _make_plugin()
        table_names = {t.name for t in plugin.manifest.tables}
        assert table_names == {"example_widgets"}

    def test_register_returns_manifest_registration(self) -> None:
        plugin, _ = _make_plugin()
        registration = plugin.register()
        assert registration["name"] == "example-plugin"
        assert {t["name"] for t in registration["tables"]} == {"example_widgets"}
        assert {r["path"] for r in registration["api_routes"]} == {
            "/widgets",
            "/widgets/{id}",
        }


class TestSubscription:
    def test_subscribes_to_user_created(self) -> None:
        plugin, _ = _make_plugin()
        assert plugin.events.has_subscription("UserCreated")


class TestOnInstall:
    async def test_seeds_default_widget(self) -> None:
        plugin, fake = _make_plugin()

        await plugin.seed_default_widget()

        names = {r["name"] for r in fake.tables["widgets"]}
        assert names == {_DEFAULT_WIDGET["name"]}

    async def test_is_idempotent(self) -> None:
        plugin, fake = _make_plugin()

        await plugin.seed_default_widget()
        await plugin.seed_default_widget()

        assert len(fake.tables["widgets"]) == 1

    async def test_default_widget_marked_active(self) -> None:
        plugin, fake = _make_plugin()

        await plugin.seed_default_widget()

        widget = fake.tables["widgets"][0]
        assert widget["is_active"] is True

    def test_on_uninstall_is_a_noop(self) -> None:
        plugin, _ = _make_plugin()
        assert plugin.on_uninstall() is None

    def test_on_install_sync_bridge_seeds_widget(self) -> None:
        """The public, ABC-compliant on_install() entrypoint (a plain sync
        function calling asyncio.run(seed_default_widget()) internally) —
        exercised from a genuinely synchronous test function, the same kind
        of context the CLI would call it from, since asyncio.run() cannot be
        nested inside pytest-asyncio's already-running loop."""
        plugin, fake = _make_plugin()

        plugin.on_install()

        names = {r["name"] for r in fake.tables["widgets"]}
        assert names == {_DEFAULT_WIDGET["name"]}


class TestUserCreatedLogsEvent:
    async def test_dispatch_does_not_raise(self) -> None:
        """The example handler only logs — this proves the subscription is
        wired end to end (event -> EventSubscriber -> handler) without
        raising, the same shape a real handler with side effects would be
        tested in (see RBAC's test_rbac_plugin.py for a handler that
        actually mutates state via self.api)."""
        plugin, _ = _make_plugin()

        event = BiffoEvent(
            detail_type="UserCreated",
            tenant_id="default",
            payload={"cognito_sub": "user-123", "email": "new@example.com"},
        )
        await plugin.events.dispatch(event)
