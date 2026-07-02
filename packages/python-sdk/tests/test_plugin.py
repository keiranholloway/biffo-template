"""Tests for PluginManifest, load_manifest, and register_plugin."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from biffo_plugin_sdk import (
    BiffoAPIClient,
    BiffoEvent,
    BiffoPluginBase,
    ColumnDefinition,
    IndexDefinition,
    PluginManifest,
    RouteDef,
    TableDefinition,
    load_manifest,
    register_plugin,
)

# Kept textually identical to services/api/tests/test_plugin_migrations.py's
# manifest fixture — if the two ever need to diverge, that's a sign the SDK's
# TableDefinition and the Core API's PluginTableDefinition have drifted apart.
RBAC_MANIFEST_DICT = {
    "name": "rbac",
    "version": "1.0.0",
    "tables": [
        {
            "name": "roles",
            "columns": [
                {"name": "slug", "type": "String(100)"},
            ],
            "indexes": [
                {"name": "idx_roles_slug", "columns": ["slug"]},
            ],
        }
    ],
}


# --- PluginManifest model tests ---


class TestPluginManifestModel:
    """Unit tests for the Pydantic model itself."""

    def test_required_fields_only(self):
        manifest = PluginManifest(name="test-plugin", version="1.0.0")
        assert manifest.name == "test-plugin"
        assert manifest.version == "1.0.0"

    def test_optional_defaults(self):
        manifest = PluginManifest(name="minimal", version="0.1.0")
        assert manifest.description == ""
        assert manifest.author == "Biffo Team"
        assert manifest.tags == []
        assert manifest.tables == []
        assert manifest.api_routes == []
        assert manifest.required_core_version == ">=0.0.0"

    def test_full_manifest_with_multiple_tables(self):
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            description="Role-based access control",
            author="Alice",
            tags=["auth", "security"],
            required_core_version=">=1.0.0",
            tables=[
                TableDefinition(
                    name="rbac_roles",
                    columns=[ColumnDefinition(name="slug", type="String(100)")],
                ),
                TableDefinition(
                    name="rbac_permissions",
                    columns=[ColumnDefinition(name="resource", type="String(100)")],
                ),
            ],
            api_routes=[
                RouteDef(
                    method="GET", path="/roles", table="rbac_roles", operation="list"
                ),
            ],
        )
        assert len(manifest.tables) == 2
        assert manifest.tables[0].name == "rbac_roles"
        assert manifest.tables[1].name == "rbac_permissions"
        # each table gets its own columns, not a flat shared list
        assert [c.name for c in manifest.tables[0].columns] == [
            "slug",
            "id",
            "tenant_id",
            "created_at",
            "updated_at",
        ]
        assert len(manifest.api_routes) == 1
        assert manifest.api_routes[0].method == "GET"

    def test_missing_required_raises_validation_error(self):
        with pytest.raises(ValidationError):
            PluginManifest(version="1.0.0")  # type: ignore[call-arg]  # missing name

    def test_missing_version_raises_validation_error(self):
        with pytest.raises(ValidationError):
            PluginManifest(name="foo")  # type: ignore[call-arg]  # missing version

    def test_route_referencing_undeclared_table_rejected(self):
        """A route can't expose a table the manifest doesn't itself declare —
        matches the Core API's parse_plugin_routes_from_manifest cross-check
        (services/api/src/api/models/plugin_route.py)."""
        with pytest.raises(ValidationError):
            PluginManifest(
                name="rbac",
                version="1.0.0",
                tables=[TableDefinition(name="roles")],
                api_routes=[
                    RouteDef(
                        method="GET",
                        path="/permissions",
                        table="permissions",
                        operation="list",
                    )
                ],
            )


# --- RouteDef tests ---


class TestRouteDef:
    def test_minimal_route(self):
        route = RouteDef(
            method="GET", path="/widgets", table="widgets", operation="list"
        )
        assert route.method == "GET"
        assert route.table == "widgets"
        assert route.operation == "list"
        assert route.description == ""

    def test_operation_method_mismatch_rejected(self):
        """'create' must use POST, not GET — a mismatched method/operation
        pair is rejected outright rather than silently accepted."""
        with pytest.raises(ValidationError):
            RouteDef(method="GET", path="/widgets", table="widgets", operation="create")

    def test_update_accepts_put_or_patch(self):
        RouteDef(
            method="PUT", path="/widgets/{id}", table="widgets", operation="update"
        )
        RouteDef(
            method="PATCH", path="/widgets/{id}", table="widgets", operation="update"
        )

    def test_single_row_operation_requires_id_path_param(self):
        with pytest.raises(ValidationError):
            RouteDef(method="GET", path="/widgets", table="widgets", operation="read")

    def test_collection_operation_rejects_id_path_param(self):
        with pytest.raises(ValidationError):
            RouteDef(
                method="GET", path="/widgets/{id}", table="widgets", operation="list"
            )

    def test_path_must_start_with_slash(self):
        with pytest.raises(ValidationError):
            RouteDef(method="GET", path="widgets", table="widgets", operation="list")


# --- TableDefinition tests (parity with the Core API's PluginTableDefinition) ---


class TestTableDefinition:
    def test_minimal_table_gets_auto_columns(self):
        table = TableDefinition(name="roles")
        assert len(table.columns) == 4
        assert {c.name for c in table.columns} == {
            "id",
            "tenant_id",
            "created_at",
            "updated_at",
        }

    def test_table_with_indexes(self):
        table = TableDefinition(
            name="roles",
            columns=[ColumnDefinition(name="slug", type="String(100)")],
            indexes=[IndexDefinition(name="idx_roles_slug", columns=["slug"])],
        )
        assert len(table.indexes) == 1
        assert table.indexes[0].name == "idx_roles_slug"

    def test_cannot_redeclare_reserved_tenant_id_column(self):
        """Silently accepting a redeclared tenant_id (e.g. as nullable) would
        let a plugin weaken the tenant-isolation guarantee ADR-0001 requires —
        matches test_plugin_table.py's equivalent test on the Core API side.
        """
        with pytest.raises(ValidationError):
            TableDefinition(
                name="bad_table",
                columns=[
                    ColumnDefinition(name="tenant_id", type="String(64)", nullable=True)
                ],
            )

    def test_cannot_redeclare_id_column(self):
        with pytest.raises(ValidationError):
            TableDefinition(
                name="bad_table",
                columns=[
                    ColumnDefinition(name="id", type="String(36)", primary_key=True)
                ],
            )

    def test_duplicate_column_names_rejected(self):
        with pytest.raises(ValidationError):
            TableDefinition(
                name="bad_table",
                columns=[
                    ColumnDefinition(name="slug", type="String(100)"),
                    ColumnDefinition(name="slug", type="Integer"),
                ],
            )

    def test_index_referencing_unknown_column_rejected(self):
        with pytest.raises(ValidationError):
            TableDefinition(
                name="bad_table",
                columns=[ColumnDefinition(name="slug", type="String(100)")],
                indexes=[IndexDefinition(name="idx_bad", columns=["nonexistent"])],
            )


# --- load_manifest tests ---


class TestLoadManifest:
    """Integration tests for loading manifests from disk."""

    def test_load_valid_manifest(self, tmp_path: Path) -> None:
        manifest_json = tmp_path / "biffo.plugin.json"
        manifest_json.write_text(json.dumps(RBAC_MANIFEST_DICT))

        manifest = load_manifest(manifest_json)

        assert manifest.name == "rbac"
        assert len(manifest.tables) == 1
        assert manifest.tables[0].name == "roles"
        assert len(manifest.tables[0].indexes) == 1

    def test_missing_file_raises_file_not_found(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_manifest(tmp_path / "does-not-exist.json")

    def test_invalid_json_raises_value_error(self, tmp_path: Path) -> None:
        manifest_json = tmp_path / "biffo.plugin.json"
        manifest_json.write_text("{not valid json")

        with pytest.raises(ValueError):
            load_manifest(manifest_json)

    def test_invalid_schema_raises_value_error(self, tmp_path: Path) -> None:
        manifest_json = tmp_path / "biffo.plugin.json"
        manifest_json.write_text(
            json.dumps({"description": "missing name and version"})
        )

        with pytest.raises(ValueError):
            load_manifest(manifest_json)


# --- register_plugin tests ---


class TestRegisterPlugin:
    def test_returns_serialisable_dict(self):
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            tables=[TableDefinition(name="roles")],
            api_routes=[
                RouteDef(method="GET", path="/roles", table="roles", operation="list")
            ],
        )

        registration = register_plugin(manifest)

        json.dumps(registration)  # must not raise
        assert registration["name"] == "rbac"
        assert registration["tables"][0]["name"] == "roles"
        assert registration["api_routes"][0]["method"] == "GET"


# --- BiffoPluginBase tests ---


class ExamplePlugin(BiffoPluginBase):
    """Concrete plugin used across BiffoPluginBase tests. Demonstrates the
    full lifecycle end to end: manifest → self.api → @self.subscribe wiring
    → lifecycle hooks, the shape every real plugin author's subclass follows.
    """

    def __init__(self, api: BiffoAPIClient | None = None) -> None:
        super().__init__(PluginManifest(name="example", version="1.0.0"), api=api)
        self.install_called = False
        self.uninstall_called = False
        self.upgraded_from: str | None = None
        self.received_events: list[BiffoEvent] = []

        @self.subscribe("user.created")
        def handle_user_created(event: BiffoEvent) -> None:
            self.received_events.append(event)

    def on_install(self) -> None:
        self.install_called = True

    def on_uninstall(self) -> None:
        self.uninstall_called = True

    def on_upgrade(self, from_version: str) -> None:
        self.upgraded_from = from_version


class IncompletePlugin(BiffoPluginBase):
    """Missing on_uninstall — used to prove ABC enforcement rejects it."""

    def on_install(self) -> None:
        pass


class TestBiffoPluginBaseAbstract:
    def test_cannot_instantiate_directly(self) -> None:
        with pytest.raises(TypeError):
            BiffoPluginBase(PluginManifest(name="x", version="1.0.0"))  # type: ignore[abstract]

    def test_cannot_instantiate_subclass_missing_abstract_method(self) -> None:
        with pytest.raises(TypeError):
            IncompletePlugin(PluginManifest(name="x", version="1.0.0"))  # type: ignore[abstract]


class TestBiffoPluginBaseLifecycleHooks:
    def test_on_install_and_on_uninstall_are_callable(self) -> None:
        plugin = ExamplePlugin()

        plugin.on_install()
        plugin.on_uninstall()

        assert plugin.install_called is True
        assert plugin.uninstall_called is True

    def test_on_upgrade_default_is_noop(self) -> None:
        class MinimalPlugin(BiffoPluginBase):
            def on_install(self) -> None:
                pass

            def on_uninstall(self) -> None:
                pass

        plugin = MinimalPlugin(PluginManifest(name="minimal", version="1.0.0"))

        assert plugin.on_upgrade("0.9.0") is None

    def test_on_upgrade_can_be_overridden(self) -> None:
        plugin = ExamplePlugin()

        plugin.on_upgrade("0.9.0")

        assert plugin.upgraded_from == "0.9.0"


class TestBiffoPluginBaseApi:
    def test_default_api_is_a_biffo_api_client(self) -> None:
        plugin = ExamplePlugin()

        assert isinstance(plugin.api, BiffoAPIClient)

    def test_api_can_be_injected(self) -> None:
        injected = BiffoAPIClient(base_url="https://api.example.com", token="t")

        plugin = ExamplePlugin(api=injected)

        assert plugin.api is injected


class TestBiffoPluginBaseSubscribe:
    def test_decorator_registers_handler_on_events(self) -> None:
        plugin = ExamplePlugin()

        assert plugin.events.has_subscription("user.created")

    def test_decorator_returns_the_original_handler(self) -> None:
        plugin = ExamplePlugin()
        recorded: list[str] = []

        @plugin.subscribe("thing.happened")
        def handler(event: BiffoEvent) -> None:
            recorded.append(event.detail_type)

        assert handler in plugin.events.get_handlers("thing.happened")

    def test_subscribe_accepts_a_source_argument(self) -> None:
        plugin = ExamplePlugin()

        @plugin.subscribe("thing.happened", source="some-other-plugin")
        def handler(event: BiffoEvent) -> None:
            pass

        assert plugin.events.has_subscription("thing.happened")

    async def test_registered_handler_is_dispatched_via_events(self) -> None:
        plugin = ExamplePlugin()
        event = BiffoEvent(detail_type="user.created", payload={"id": "1"})

        await plugin.events.dispatch(event)

        assert plugin.received_events == [event]

    def test_each_instance_has_its_own_event_registrations(self) -> None:
        plugin_one = ExamplePlugin()
        plugin_two = ExamplePlugin()

        assert plugin_one.events is not plugin_two.events
        assert plugin_one.events.get_handlers(
            "user.created"
        ) != plugin_two.events.get_handlers("user.created")


class TestBiffoPluginBaseRegister:
    def test_register_delegates_to_register_plugin(self) -> None:
        plugin = ExamplePlugin()

        registration = plugin.register()

        assert registration == register_plugin(plugin.manifest)
        assert registration["name"] == "example"
        assert registration["version"] == "1.0.0"


class TestBiffoPluginBaseEndToEnd:
    """A concrete subclass working end to end: manifest → register() →
    self.api → @subscribe → lifecycle hooks, all through the public API."""

    def test_full_lifecycle(self) -> None:
        plugin = ExamplePlugin()

        registration = plugin.register()
        plugin.on_install()
        plugin.on_upgrade("1.0.0")
        plugin.on_uninstall()

        assert registration["name"] == "example"
        assert plugin.install_called is True
        assert plugin.upgraded_from == "1.0.0"
        assert plugin.uninstall_called is True
        assert isinstance(plugin.api, BiffoAPIClient)
        assert plugin.events.has_subscription("user.created")
