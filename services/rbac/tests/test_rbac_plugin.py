"""Tests for RbacPlugin: lifecycle hooks, manifest loading, and the
user.created -> default-role-assignment event subscription.
"""

from __future__ import annotations

from biffo_plugin_sdk import BiffoEvent
from fakes import FakeCoreApi
from rbac.plugin import DEFAULT_ROLE_NAME, RbacPlugin


def _make_plugin() -> tuple[RbacPlugin, FakeCoreApi]:
    fake = FakeCoreApi()
    plugin = RbacPlugin(api=fake.client())
    return plugin, fake


class TestManifestLoading:
    def test_manifest_name_and_version(self) -> None:
        plugin, _ = _make_plugin()
        assert plugin.manifest.name == "rbac"
        assert plugin.manifest.version == "0.1.0"

    def test_manifest_declares_all_four_tables(self) -> None:
        plugin, _ = _make_plugin()
        table_names = {t.name for t in plugin.manifest.tables}
        assert table_names == {
            "rbac_roles",
            "rbac_permissions",
            "rbac_role_permissions",
            "rbac_user_roles",
        }

    def test_register_returns_manifest_registration(self) -> None:
        plugin, _ = _make_plugin()
        registration = plugin.register()
        assert registration["name"] == "rbac"
        assert {t["name"] for t in registration["tables"]} == {
            "rbac_roles",
            "rbac_permissions",
            "rbac_role_permissions",
            "rbac_user_roles",
        }


class TestSubscription:
    def test_subscribes_to_user_created(self) -> None:
        plugin, _ = _make_plugin()
        assert plugin.events.has_subscription("user.created")


class TestOnInstall:
    async def test_seeds_baseline_roles(self) -> None:
        plugin, fake = _make_plugin()

        await plugin.seed_baseline_roles()

        names = {r["name"] for r in fake.tables["roles"]}
        assert names == {"system.admin", "editor", DEFAULT_ROLE_NAME}

    async def test_is_idempotent(self) -> None:
        plugin, fake = _make_plugin()

        await plugin.seed_baseline_roles()
        await plugin.seed_baseline_roles()

        assert len(fake.tables["roles"]) == 3

    async def test_system_admin_role_marked_is_system(self) -> None:
        plugin, fake = _make_plugin()

        await plugin.seed_baseline_roles()

        admin_role = next(
            r for r in fake.tables["roles"] if r["name"] == "system.admin"
        )
        assert admin_role["is_system"] is True

    def test_on_uninstall_is_a_noop(self) -> None:
        plugin, _ = _make_plugin()
        assert plugin.on_uninstall() is None

    def test_on_install_sync_bridge_seeds_roles(self) -> None:
        """The public, ABC-compliant on_install() entrypoint (a plain sync
        function calling asyncio.run(seed_baseline_roles()) internally) —
        exercised from a genuinely synchronous test function, the same kind
        of context the CLI would call it from, since asyncio.run() cannot
        be nested inside pytest-asyncio's already-running loop."""
        plugin, fake = _make_plugin()

        plugin.on_install()

        names = {r["name"] for r in fake.tables["roles"]}
        assert names == {"system.admin", "editor", DEFAULT_ROLE_NAME}


class TestUserCreatedAutoAssignsDefaultRole:
    async def test_assigns_viewer_role_to_new_user(self) -> None:
        plugin, fake = _make_plugin()
        await plugin.seed_baseline_roles()

        event = BiffoEvent(
            detail_type="user.created",
            tenant_id="default",
            payload={"cognito_sub": "user-123", "email": "new@example.com"},
        )
        await plugin.events.dispatch(event)

        assignments = fake.tables["assignments"]
        assert len(assignments) == 1
        viewer_role = next(
            r for r in fake.tables["roles"] if r["name"] == DEFAULT_ROLE_NAME
        )
        assert assignments[0]["user_id"] == "user-123"
        assert assignments[0]["role_id"] == viewer_role["id"]
        assert assignments[0]["assigned_by"] is None

    async def test_falls_back_to_user_id_payload_key(self) -> None:
        plugin, fake = _make_plugin()
        await plugin.seed_baseline_roles()

        event = BiffoEvent(detail_type="user.created", payload={"user_id": "user-456"})
        await plugin.events.dispatch(event)

        assert fake.tables["assignments"][0]["user_id"] == "user-456"

    async def test_missing_user_id_skips_without_raising(self) -> None:
        plugin, fake = _make_plugin()
        await plugin.seed_baseline_roles()

        event = BiffoEvent(
            detail_type="user.created", payload={"email": "no-id@example.com"}
        )
        await plugin.events.dispatch(event)

        assert fake.tables["assignments"] == []

    async def test_missing_default_role_skips_without_raising(self) -> None:
        """If on_install() hasn't run yet (no seeded roles), the handler must
        not crash the event dispatch — it logs and no-ops."""
        plugin, fake = _make_plugin()

        event = BiffoEvent(
            detail_type="user.created", payload={"cognito_sub": "user-789"}
        )
        await plugin.events.dispatch(event)

        assert fake.tables["assignments"] == []

    async def test_invalidates_permission_cache(self) -> None:
        """After auto-assigning a role, a repeated identical check() must
        hit the API again rather than serve a stale cached answer — proven
        black-box via the request log, not by reaching into cache internals.
        """
        plugin, fake = _make_plugin()
        await plugin.seed_baseline_roles()
        await plugin.permissions.check("someone-else", "docs", "read")
        calls_before = len(fake.request_log)
        await plugin.permissions.check("someone-else", "docs", "read")
        assert len(fake.request_log) == calls_before  # served from cache

        event = BiffoEvent(
            detail_type="user.created", payload={"cognito_sub": "user-999"}
        )
        await plugin.events.dispatch(event)

        calls_after_invalidate = len(fake.request_log)
        await plugin.permissions.check("someone-else", "docs", "read")
        assert len(fake.request_log) > calls_after_invalidate  # cache was cleared
