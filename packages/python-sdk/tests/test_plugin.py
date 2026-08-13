"""Tests for PluginManifest, load_manifest, and register_plugin."""

import json
from pathlib import Path

import pytest
from biffo_plugin_sdk import (
    AdminIngress,
    BiffoAPIClient,
    BiffoEvent,
    BiffoPluginBase,
    ColumnDefinition,
    EventSubscription,
    IndexDefinition,
    PermissionRule,
    PluginManifest,
    RouteDef,
    SeedDeclaration,
    TableDefinition,
    TablePermissions,
    ToolDeclaration,
    UIComponent,
    UserFrontend,
    UserIngress,
    load_manifest,
    register_plugin,
)
from pydantic import ValidationError

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
        assert manifest.tools == []

    def test_tools_declaration_is_parsed_and_preserved(self):
        # A runtime plugin declares the tools it exposes to agentic workers
        # (ADR-0014 §7): name/description/parameters, no executor. The model must
        # accept and retain them so Core can surface them in the workflow catalog.
        manifest = PluginManifest(
            name="agent-runtime",
            version="0.1.0",
            tools=[
                ToolDeclaration(
                    name="web_search",
                    description="Search the public web.",
                    parameters={
                        "type": "object",
                        "properties": {"query": {"type": "string", "maxLength": 256}},
                        "required": ["query"],
                    },
                )
            ],
        )
        assert [t.name for t in manifest.tools] == ["web_search"]
        assert manifest.tools[0].parameters["required"] == ["query"]
        # And it round-trips through the serialisable dump Core reads.
        dumped = manifest.model_dump_serializable()
        assert dumped["tools"][0]["name"] == "web_search"

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
                RouteDef(method="GET", path="/roles", table="rbac_roles", operation="list"),
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

    def test_seed_defaults_to_none(self):
        manifest = PluginManifest(name="minimal", version="0.1.0")
        assert manifest.seed is None

    def test_seed_is_parsed_and_preserved(self):
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            tables=[TableDefinition(name="roles")],
            seed=SeedDeclaration(dir="db/seed", baseline_tables=["roles"]),
        )
        assert manifest.seed is not None
        assert manifest.seed.dir == "db/seed"
        assert manifest.seed.baseline_tables == ["roles"]
        # And it round-trips through the serialisable dump Core reads
        # (services/api/src/api/plugin_baseline_check.py's
        # collect_baseline_declarations reads exactly this shape).
        dumped = manifest.model_dump_serializable()
        assert dumped["seed"] == {"dir": "db/seed", "baseline_tables": ["roles"]}

    def test_seed_baseline_tables_defaults_to_empty(self):
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            tables=[TableDefinition(name="roles")],
            seed=SeedDeclaration(dir="db/seed"),
        )
        assert manifest.seed is not None
        assert manifest.seed.baseline_tables == []

    def test_seed_baseline_table_not_in_declared_tables_rejected(self):
        """Mirrors the api_routes cross-check just above: a plugin's baseline
        seed can only promise rows for its OWN tables (biffo-template#1554)."""
        with pytest.raises(ValidationError):
            PluginManifest(
                name="rbac",
                version="1.0.0",
                tables=[TableDefinition(name="roles")],
                seed=SeedDeclaration(dir="db/seed", baseline_tables=["not_a_declared_table"]),
            )

    def test_seed_declaration_rejects_unknown_key(self):
        with pytest.raises(ValidationError):
            SeedDeclaration(dir="db/seed", baseline_tables=[], extra_field=True)  # type: ignore[call-arg]

    def test_seed_declaration_requires_dir(self):
        with pytest.raises(ValidationError):
            SeedDeclaration(baseline_tables=["roles"])  # type: ignore[call-arg]  # missing dir


class TestPluginManifestStrictness:
    """``extra="forbid"`` and the fields the shared host actually reads
    (biffo-template#1517). Before this, PluginManifest had no ``model_config``
    at all, so an unknown top-level key — a typo, or a field this version of
    the SDK predates — validated with no error and was silently dropped.
    """

    def test_typo_d_admin_ingress_key_fails_the_gate(self):
        """The exact typo the issue's second comment reproduced against the
        real marketing manifest: ``admin_ingres`` (one 's'). Before this
        change it PASSED validation, silently — that is how this whole issue
        survived undetected. It must now fail.
        """
        with pytest.raises(ValidationError):
            PluginManifest.model_validate(
                {
                    "name": "marketing",
                    "version": "1.0.0",
                    "admin_ingres": {"app": "marketing.admin_app:app", "required_group": "admin"},
                }
            )

    def test_unknown_top_level_key_fails_the_gate(self):
        with pytest.raises(ValidationError):
            PluginManifest.model_validate(
                {"name": "x", "version": "1.0.0", "this_field_does_not_exist": True}
            )

    def test_user_ingress_and_admin_ingress_are_parsed_and_typed(self):
        """PluginManifest previously did not know these fields existed at
        all — they validated as unknown keys and were silently dropped
        (extra="ignore" is Pydantic's default with no model_config). The
        shared host is the one reader that actually acts on them
        (services/_plugin-host/src/plugin_host/discover.py); this proves the
        model it now validates through actually carries them.
        """
        manifest = PluginManifest.model_validate(
            {
                "name": "marketing",
                "version": "1.0.0",
                "user_ingress": {"app": "marketing.user_app:app", "required_group": "founder"},
                "admin_ingress": {"app": "marketing.admin_app:app", "required_group": "admin"},
                "user_frontend": {"dir": "web/dist", "required_group": "founder"},
            }
        )
        assert isinstance(manifest.user_ingress, UserIngress)
        assert manifest.user_ingress.app == "marketing.user_app:app"
        assert isinstance(manifest.admin_ingress, AdminIngress)
        assert manifest.admin_ingress.required_group == "admin"
        assert isinstance(manifest.user_frontend, UserFrontend)
        assert manifest.user_frontend.dir == "web/dist"

    def test_user_ingress_and_admin_ingress_default_to_none(self):
        manifest = PluginManifest(name="data-only", version="1.0.0")
        assert manifest.user_ingress is None
        assert manifest.admin_ingress is None
        assert manifest.user_frontend is None

    def test_malformed_admin_ingress_app_ref_rejected(self):
        with pytest.raises(ValidationError):
            PluginManifest.model_validate(
                {
                    "name": "x",
                    "version": "1.0.0",
                    "admin_ingress": {"app": "not-a-valid-ref", "required_group": "admin"},
                }
            )

    def test_the_three_live_plugins_shapes_validate(self):
        """A reconstruction of the fields biffo-plugin-marketing,
        biffo-plugin-idea-scout and biffo-plugin-ideation actually declare at
        the top level of their real biffo.plugin.json (checked 2026-08-13).
        Every one of them must still validate now that the model is strict —
        the point of Phase 0 is to catch a typo, not to break every live
        plugin the moment it ships.
        """
        PluginManifest.model_validate(
            {
                "name": "marketing",
                "version": "0.1.0",
                "required_core_version": ">=0.272.0",
                "user_ingress": {"app": "marketing.user_app:app", "required_group": "founder"},
                "admin_ingress": {"app": "marketing.admin_app:app", "required_group": "admin"},
                "core_capabilities": {
                    "agent-run-request": "^1",
                    "owner-scoped-tables": "^1",
                    "object-storage": "^1",
                },
                "dependencies": {"biffo-plugin-sdk": "^1.0"},
                "ui_components": [
                    {"type": "nav-link", "label": "Marketing", "path": "/admin/marketing"}
                ],
                "event_subscriptions": [{"source": "biffo.core", "detail_type": "UserCreated"}],
            }
        )
        PluginManifest.model_validate(
            {
                "name": "idea-scout",
                "version": "0.1.0",
                "user_ingress": {"app": "idea_scout.app:app", "required_group": "founder"},
                "admin_ingress": {"app": "idea_scout.admin_app:app", "required_group": "admin"},
                "user_frontend": {"dir": "web/dist", "required_group": "founder"},
                "core_capabilities": {"agent-run-request": "^1", "user-profile-read": "^1"},
                "dependencies": {"biffo-plugin-sdk": "^1.1"},
                "ui_components": [],
                "event_subscriptions": [],
            }
        )
        PluginManifest.model_validate(
            {
                "name": "ideation",
                "version": "0.1.0",
                "user_ingress": {"app": "ideation.app:app", "required_group": "founder"},
                "admin_ingress": {"app": "ideation.admin_app:app", "required_group": "admin"},
                "user_frontend": {"dir": "web/dist", "required_group": "founder"},
                "chat_agents_dynamic": True,
                "core_capabilities": {"chat-turn": "^1", "agent-run-request": "^1"},
                "dependencies": {"biffo-plugin-sdk": "^1.1"},
                "ui_components": [],
            }
        )

    def test_event_subscriptions_parsed_but_deliberately_loose(self):
        """Mirrors cli/src/lib/plugin-manifest.ts's event_subscriptions
        handling: the authoritative shape is the registry's, so this only
        needs detail_type (source defaults) and tolerates extra keys like a
        human-readable description or the legacy `handler` some manifests
        still carry — unlike UserIngress/AdminIngress, this isn't a security
        surface, so a typo'd extra key here has nothing to silently weaken.
        """
        manifest = PluginManifest.model_validate(
            {
                "name": "x",
                "version": "1.0.0",
                "event_subscriptions": [
                    {"source": "biffo.core", "detail_type": "UserCreated", "description": "..."},
                    {"detail_type": "widget.updated"},
                ],
            }
        )
        assert len(manifest.event_subscriptions) == 2
        assert isinstance(manifest.event_subscriptions[0], EventSubscription)
        assert manifest.event_subscriptions[1].source == "biffo.core"  # default

    def test_ui_components_rejects_unknown_type(self):
        with pytest.raises(ValidationError):
            PluginManifest.model_validate(
                {
                    "name": "x",
                    "version": "1.0.0",
                    "ui_components": [{"type": "not-a-real-type", "label": "L", "path": "/p"}],
                }
            )

    def test_ui_components_parsed(self):
        manifest = PluginManifest.model_validate(
            {
                "name": "x",
                "version": "1.0.0",
                "ui_components": [{"type": "nav-link", "label": "Widgets", "path": "/admin/x"}],
            }
        )
        assert isinstance(manifest.ui_components[0], UIComponent)
        assert manifest.ui_components[0].label == "Widgets"

    def test_chat_agents_dynamic_defaults_false(self):
        assert PluginManifest(name="x", version="1.0.0").chat_agents_dynamic is False

    def test_core_capabilities_and_dependencies_are_free_form_string_maps(self):
        manifest = PluginManifest.model_validate(
            {
                "name": "x",
                "version": "1.0.0",
                "core_capabilities": {"owner-scoped-tables": "^1"},
                "dependencies": {"biffo-plugin-sdk": "^1.1"},
            }
        )
        assert manifest.core_capabilities == {"owner-scoped-tables": "^1"}
        assert manifest.dependencies == {"biffo-plugin-sdk": "^1.1"}


# --- RouteDef tests ---


class TestRouteDef:
    def test_minimal_route(self):
        route = RouteDef(method="GET", path="/widgets", table="widgets", operation="list")
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
        RouteDef(method="PUT", path="/widgets/{id}", table="widgets", operation="update")
        RouteDef(method="PATCH", path="/widgets/{id}", table="widgets", operation="update")

    def test_single_row_operation_requires_id_path_param(self):
        with pytest.raises(ValidationError):
            RouteDef(method="GET", path="/widgets", table="widgets", operation="read")

    def test_collection_operation_rejects_id_path_param(self):
        with pytest.raises(ValidationError):
            RouteDef(method="GET", path="/widgets/{id}", table="widgets", operation="list")

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
                columns=[ColumnDefinition(name="tenant_id", type="String(64)", nullable=True)],
            )

    def test_cannot_redeclare_id_column(self):
        with pytest.raises(ValidationError):
            TableDefinition(
                name="bad_table",
                columns=[ColumnDefinition(name="id", type="String(36)", primary_key=True)],
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


# --- TablePermissions / PermissionRule tests (ADR-0004, parity with the ---
# --- Core API's TablePermissions/PermissionRule) ---


class TestTablePermissions:
    def test_absent_permissions_block_defaults_to_fully_denied(self):
        """A table with no permissions block is invisible to the generic CRUD
        layer: every operation is {allowed: false, required_role: []}."""
        table = TableDefinition(name="roles")
        for op in ("list", "read", "create", "update", "delete"):
            rule = getattr(table.permissions, op)
            assert rule.allowed is False
            assert rule.required_role == []

    def test_partial_block_leaves_other_operations_default_denied(self):
        """Declaring only `read` leaves list/create/update/delete denied."""
        table = TableDefinition.model_validate(
            {"name": "roles", "permissions": {"read": {"allowed": True}}}
        )
        assert table.permissions.read.allowed is True
        assert table.permissions.read.required_role == []
        for op in ("list", "create", "update", "delete"):
            rule = getattr(table.permissions, op)
            assert rule.allowed is False
            assert rule.required_role == []

    def test_allowed_with_empty_required_role_means_any_authenticated_caller(self):
        rule = PermissionRule(allowed=True)
        assert rule.allowed is True
        assert rule.required_role == []

    def test_required_role_is_an_any_of_allow_list(self):
        table = TableDefinition.model_validate(
            {
                "name": "roles",
                "permissions": {"delete": {"allowed": True, "required_role": ["admin", "ops"]}},
            }
        )
        assert table.permissions.delete.allowed is True
        assert table.permissions.delete.required_role == ["admin", "ops"]

    def test_unknown_operation_key_rejected(self):
        """A typo'd operation (e.g. 'delet') is a hard error rather than a
        silently-ignored, permanently-denied operation (extra='forbid')."""
        with pytest.raises(ValidationError):
            TablePermissions(delet={"allowed": True})  # type: ignore[call-arg]

    def test_unknown_key_inside_rule_rejected(self):
        """A typo'd rule key (e.g. 'role' for 'required_role') fails loudly on
        this security surface rather than being silently ignored."""
        with pytest.raises(ValidationError):
            PermissionRule(role=["admin"])  # type: ignore[call-arg]

    def test_permissions_survive_register_round_trip(self):
        """register_plugin serialises tables via model_dump(mode='json') — the
        permissions block must ride along so the registry sees it."""
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            tables=[
                TableDefinition.model_validate(
                    {
                        "name": "roles",
                        "permissions": {
                            "list": {"allowed": True},
                            "delete": {"allowed": True, "required_role": ["admin"]},
                        },
                    }
                )
            ],
        )

        registration = register_plugin(manifest)

        json.dumps(registration)  # must not raise
        perms = registration["tables"][0]["permissions"]
        assert perms["list"] == {"allowed": True, "required_role": []}
        assert perms["delete"] == {"allowed": True, "required_role": ["admin"]}
        assert perms["read"] == {"allowed": False, "required_role": []}


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
        manifest_json.write_text(json.dumps({"description": "missing name and version"}))

        with pytest.raises(ValueError):
            load_manifest(manifest_json)


# --- register_plugin tests ---


class TestRegisterPlugin:
    def test_returns_serialisable_dict(self):
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            tables=[TableDefinition(name="roles")],
            api_routes=[RouteDef(method="GET", path="/roles", table="roles", operation="list")],
        )

        registration = register_plugin(manifest)

        json.dumps(registration)  # must not raise
        assert registration["name"] == "rbac"
        assert registration["tables"][0]["name"] == "roles"
        assert registration["api_routes"][0]["method"] == "GET"
        assert registration["seed"] is None

    def test_includes_seed_when_declared(self):
        manifest = PluginManifest(
            name="rbac",
            version="1.0.0",
            tables=[TableDefinition(name="roles")],
            seed=SeedDeclaration(dir="db/seed", baseline_tables=["roles"]),
        )

        registration = register_plugin(manifest)

        json.dumps(registration)  # must not raise
        assert registration["seed"] == {"dir": "db/seed", "baseline_tables": ["roles"]}


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
    """The ABC's shape only — these hooks are **not invoked** by the platform.

    Nothing in the CLI, Core or the plugin host reaches them
    (biffo-template#709, guarded by ``test_lifecycle_hooks_not_invoked.py``).
    What follows proves a subclass can define and override them, not that they
    ever run on their own.
    """

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
        assert plugin_one.events.get_handlers("user.created") != plugin_two.events.get_handlers(
            "user.created"
        )


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
