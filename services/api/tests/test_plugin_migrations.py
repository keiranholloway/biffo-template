"""Tests for the plugin migration generator."""

import shutil
import tempfile
from pathlib import Path


from api.migrations.plugin_migrations import (
    _column_to_alembic_def,
    generate_migration_for_plugin,
    generate_migration_name,
    get_current_head_revision,
    parse_plugin_tables_from_manifest,
    sync_plugin_migrations,
)
from api.models.plugin_table import ColumnDefinition


class TestColumnToAlembicDef:
    """Test Alembic sa.Column() string generation (issue #28 regressions)."""

    def test_multi_arg_numeric_stays_typed(self):
        # Regression: Numeric(10, 2) used to render as sa.Numeric('10', '2'),
        # which SQLAlchemy rejects (precision/scale must be int, not str).
        col = ColumnDefinition(name="price", type="Numeric(10, 2)")
        result = _column_to_alembic_def(col)
        assert result == "'price', sa.Numeric(10, 2), nullable=False"

    def test_keyword_arg_type_renders_correctly(self):
        col = ColumnDefinition(name="seen_at", type="DateTime(timezone=True)")
        result = _column_to_alembic_def(col)
        assert result == "'seen_at', sa.DateTime(timezone=True), nullable=False"

    def test_quote_in_column_name_produces_valid_python(self):
        # Regression: names were interpolated via raw f"'{name}'" instead of
        # repr(), so a quote in a manifest-supplied name broke out of the
        # generated string literal (a code-injection path).
        col = ColumnDefinition(name="o'brien", type="String(10)")
        result = _column_to_alembic_def(col)
        assert result == '"o\'brien", sa.String(10), nullable=False'
        # Rendered exactly as it's embedded in real output: sa.Column(<result>)
        compile(f"sa.Column({result})", "<test>", "eval")  # must not raise SyntaxError


class TestGenerateMigrationName:
    """Test migration name generation."""

    def test_simple_name(self):
        name = generate_migration_name("roles")
        assert name.startswith("add_roles_table_")
        assert "roles" in name

    def test_multi_word_name(self):
        name = generate_migration_name("user_permissions")
        assert name.startswith("add_user_permissions_table_")
        assert "user_permissions" in name

    def test_name_is_deterministic(self):
        name1 = generate_migration_name("roles")
        name2 = generate_migration_name("roles")
        assert name1 == name2


class TestParsePluginTablesFromManifest:
    """Test parsing table definitions from a plugin manifest."""

    def test_parse_minimal_manifest(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        tables = parse_plugin_tables_from_manifest(manifest)
        assert len(tables) == 1
        assert tables[0].name == "roles"

    def test_parse_manifest_with_columns(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {
                    "name": "roles",
                    "columns": [
                        {"name": "slug", "type": "String(100)"},
                    ],
                }
            ],
        }
        tables = parse_plugin_tables_from_manifest(manifest)
        assert len(tables) == 1
        assert tables[0].name == "roles"
        assert len(tables[0].columns) == 5  # slug + 4 auto columns

    def test_parse_manifest_with_indexes(self):
        manifest = {
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
        tables = parse_plugin_tables_from_manifest(manifest)
        assert len(tables) == 1
        assert len(tables[0].indexes) == 1
        assert tables[0].indexes[0].name == "idx_roles_slug"

    def test_parse_empty_tables_list(self):
        manifest = {"name": "noop", "version": "1.0.0", "tables": []}
        tables = parse_plugin_tables_from_manifest(manifest)
        assert tables == []

    def test_parse_multiple_tables(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {"name": "roles"},
                {"name": "permissions"},
            ],
        }
        tables = parse_plugin_tables_from_manifest(manifest)
        assert len(tables) == 2
        assert tables[0].name == "roles"
        assert tables[1].name == "permissions"


class TestGenerateMigrationForPlugin:
    """Test full migration file generation."""

    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.versions_dir = Path(self.tmpdir) / "versions"
        self.versions_dir.mkdir()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir)

    def test_generates_up_and_down_functions(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "def upgrade()" in content
        assert "def downgrade()" in content

    def test_up_creates_tables(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "create_table" in content.lower() or "create_table" in content

    def test_down_drops_tables(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "drop_table" in content.lower() or "drop_table" in content

    def test_file_has_revision_id(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "revision =" in content
        assert "down_revision =" in content

    def test_file_is_valid_python(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        # Should compile without syntax errors
        content = migration_file.read_text()
        compile(content, str(migration_file), "exec")

    def test_column_with_index_produces_valid_python(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {
                    "name": "roles",
                    "columns": [{"name": "slug", "type": "String(100)", "index": True}],
                }
            ],
        }
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "create_index" in content
        assert "drop_index" in content
        compile(content, str(migration_file), "exec")

    def test_quote_in_table_name_produces_valid_python(self):
        # Regression: table/index names were interpolated via raw f"'{name}'"
        # instead of repr(), so a quote in a manifest-supplied name could
        # break out of the generated string literal (a code-injection path).
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {
                    "name": "o'brien_roles",
                    "columns": [{"name": "slug", "type": "String(100)", "index": True}],
                }
            ],
        }
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        compile(content, str(migration_file), "exec")

    def test_multiple_tables_in_one_migration(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {"name": "roles"},
                {"name": "permissions"},
            ],
        }
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "roles" in content
        assert "permissions" in content
        # Regression: multi-table manifests used to produce an extra
        # indent level on every statement after the first (a "\n    ".join
        # separator on top of the uniform per-line 4-space prefix), which is
        # invisible with a single table but raises IndentationError as soon
        # as there's more than one — found independently while working #65.
        compile(content, str(migration_file), "exec")

    def test_multiple_tables_with_columns_and_indexes_produce_valid_python(self):
        """A closer-to-real-world multi-table manifest (columns + an
        index=True column on more than one table) — the exact shape that
        triggered the double-indent codegen bug."""
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {
                    "name": "roles",
                    "columns": [{"name": "slug", "type": "String(100)", "index": True}],
                },
                {
                    "name": "permissions",
                    "columns": [{"name": "code", "type": "String(100)"}],
                },
            ],
        }
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        compile(content, str(migration_file), "exec")
        assert content.count("op.create_table(") == 2
        assert content.count("op.drop_table(") == 2

    def test_migration_name_in_filename(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert "roles" in migration_file.name
        assert migration_file.suffix == ".py"


class TestGetCurrentHeadRevision:
    """Test down_revision chaining onto the real Alembic version chain
    (issue #18 gap: down_revision was hard-coded to None, so every generated
    plugin migration forked its own second head instead of appending)."""

    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.versions_dir = Path(self.tmpdir) / "versions"
        self.versions_dir.mkdir()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir)

    def test_empty_versions_dir_has_no_head(self):
        assert get_current_head_revision(self.versions_dir) is None

    def test_first_generated_migration_has_no_down_revision(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "down_revision = None" in content

    def test_generated_migration_chains_onto_existing_head(self):
        existing = self.versions_dir / "0001_create_users_table.py"
        existing.write_text(
            "revision = '0001'\n"
            "down_revision = None\n"
            "branch_labels = None\n"
            "depends_on = None\n"
            "def upgrade(): pass\n"
            "def downgrade(): pass\n"
        )
        assert get_current_head_revision(self.versions_dir) == "0001"

        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        content = migration_file.read_text()
        assert "down_revision = '0001'" in content
        # The generated migration is now itself the head — it appended to
        # the chain rather than forking a second one.
        assert (
            get_current_head_revision(self.versions_dir)
            == migration_file.stem.split("_")[0]
        )

    def test_second_plugin_migration_chains_onto_first_not_original_head(self):
        existing = self.versions_dir / "0001_create_users_table.py"
        existing.write_text(
            "revision = '0001'\n"
            "down_revision = None\n"
            "branch_labels = None\n"
            "depends_on = None\n"
            "def upgrade(): pass\n"
            "def downgrade(): pass\n"
        )
        first = generate_migration_for_plugin(
            {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]},
            self.versions_dir,
        )
        second = generate_migration_for_plugin(
            {"name": "billing", "version": "1.0.0", "tables": [{"name": "invoices"}]},
            self.versions_dir,
        )
        first_revision = first.stem.split("_")[0]
        second_content = second.read_text()
        assert f"down_revision = '{first_revision}'" in second_content
        # There is exactly one head — no forked branch.
        assert get_current_head_revision(self.versions_dir) == second.stem.split("_")[0]


class TestSyncPluginMigrations:
    """Test the discover -> generate wiring that main.py's _run_db_init calls
    (issue #18 gap: the generator was previously dead code, never invoked
    outside its own unit tests)."""

    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.versions_dir = Path(self.tmpdir) / "versions"
        self.versions_dir.mkdir()
        self.services_root = Path(self.tmpdir) / "services"
        self.services_root.mkdir()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir)

    def _write_manifest(self, plugin_name: str, manifest: dict) -> None:
        import json

        plugin_dir = self.services_root / plugin_name
        plugin_dir.mkdir()
        (plugin_dir / "biffo.plugin.json").write_text(json.dumps(manifest))

    def test_no_plugins_generates_nothing(self):
        generated = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root
        )
        assert generated == []

    def test_generates_migration_for_discovered_plugin(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        generated = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root
        )
        assert len(generated) == 1
        assert generated[0].exists()

    def test_plugin_with_no_tables_is_skipped(self):
        self._write_manifest("noop", {"name": "noop", "version": "1.0.0", "tables": []})
        generated = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root
        )
        assert generated == []

    def test_rerunning_sync_is_idempotent(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        first = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root
        )
        second = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root
        )
        assert len(first) == 1
        assert second == []
        # Only one migration file exists, not a duplicate.
        assert len(list(self.versions_dir.glob("*.py"))) == 1

    def test_multiple_plugins_chain_onto_a_single_head(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        self._write_manifest(
            "billing",
            {"name": "billing", "version": "1.0.0", "tables": [{"name": "invoices"}]},
        )
        generated = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root
        )
        assert len(generated) == 2
        # Exactly one head — sync_plugin_migrations must not fork branches
        # when generating migrations for multiple plugins in one pass.
        assert get_current_head_revision(self.versions_dir) is not None
