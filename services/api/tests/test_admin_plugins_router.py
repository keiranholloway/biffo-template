"""Tests for GET /admin/plugins/available (issue #18 gap 1).

Calls the route function directly with a fake AuthenticatedUser, the same
way test_auth.py exercises routers/auth.py's get_current_user — consistent
with this repo's existing pattern of testing route handlers as plain async
functions rather than spinning up a TestClient.
"""

import json

from api.middleware.auth import AuthenticatedUser
from api.routers.admin.plugins import list_available_plugins

_CALLER = AuthenticatedUser(
    sub="test-sub", email="admin@example.com", username="admin", tenant_id="default"
)


class TestListAvailablePlugins:
    async def test_no_plugins_installed_returns_empty_list(self, tmp_path, monkeypatch):
        monkeypatch.setattr("api.routers.admin.plugins.discover_plugin_manifests", lambda: [])
        result = await list_available_plugins(_caller=_CALLER)
        assert result == []

    async def test_returns_installed_plugin_with_table_schema(self, tmp_path, monkeypatch):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "description": "Role-based access control",
            "tables": [
                {
                    "name": "roles",
                    "columns": [{"name": "slug", "type": "String(100)"}],
                }
            ],
        }
        monkeypatch.setattr(
            "api.routers.admin.plugins.discover_plugin_manifests",
            lambda: [manifest],
        )

        result = await list_available_plugins(_caller=_CALLER)

        assert len(result) == 1
        plugin = result[0]
        assert plugin.name == "rbac"
        assert plugin.version == "1.0.0"
        assert plugin.description == "Role-based access control"
        assert len(plugin.tables) == 1
        assert plugin.tables[0].name == "roles"
        # Auto-columns (id/tenant_id/created_at/updated_at) plus the
        # manifest's own "slug" column, per ADR-0001.
        col_names = {c.name for c in plugin.tables[0].columns}
        assert {"id", "tenant_id", "created_at", "updated_at", "slug"} <= col_names

    async def test_multiple_installed_plugins_are_all_returned(self, monkeypatch):
        manifests = [
            {"name": "rbac", "version": "1.0.0", "tables": []},
            {"name": "billing", "version": "2.1.0", "tables": []},
        ]
        monkeypatch.setattr(
            "api.routers.admin.plugins.discover_plugin_manifests",
            lambda: manifests,
        )

        result = await list_available_plugins(_caller=_CALLER)

        assert {p.name for p in result} == {"rbac", "billing"}

    async def test_response_is_json_serialisable(self, monkeypatch):
        """The response_model round-trips through model_dump(mode="json") the
        same way FastAPI serialises it for the real HTTP response."""
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        monkeypatch.setattr(
            "api.routers.admin.plugins.discover_plugin_manifests",
            lambda: [manifest],
        )

        result = await list_available_plugins(_caller=_CALLER)
        payload = json.dumps([p.model_dump(mode="json") for p in result])
        assert "roles" in payload

    async def test_has_admin_ingress_true_when_admin_ingress_declared(self, monkeypatch):
        manifest = {
            "name": "ideation",
            "version": "1.0.0",
            "user_ingress": {"app": "ideation.app:app", "required_group": "founder"},
            "admin_ingress": {"app": "ideation.admin:app", "required_group": "admin"},
            "tables": [],
        }
        monkeypatch.setattr(
            "api.routers.admin.plugins.discover_plugin_manifests",
            lambda: [manifest],
        )

        result = await list_available_plugins(_caller=_CALLER)

        assert len(result) == 1
        assert result[0].has_admin_ingress is True

    async def test_has_admin_ingress_false_when_admin_ingress_absent(self, monkeypatch):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [],
        }
        monkeypatch.setattr(
            "api.routers.admin.plugins.discover_plugin_manifests",
            lambda: [manifest],
        )

        result = await list_available_plugins(_caller=_CALLER)

        assert len(result) == 1
        assert result[0].has_admin_ingress is False
