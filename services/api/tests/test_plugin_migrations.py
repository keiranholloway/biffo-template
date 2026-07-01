"""Tests for the plugin migration generator."""

import shutil
import tempfile
from pathlib import Path


from api.migrations.plugin_migrations import (
    _column_to_alembic_def,
    generate_migration_for_plugin,
    generate_migration_name,
    parse_plugin_tables_from_manifest,
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

    def test_migration_name_in_filename(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert "roles" in migration_file.name
        assert migration_file.suffix == ".py"
