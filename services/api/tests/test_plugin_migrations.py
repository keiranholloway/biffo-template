"""Tests for the plugin migration generator."""

import json
import shutil
import tempfile
from pathlib import Path

import pytest

from api.migrations.plugin_migrations import (
    generate_migration_for_plugin,
    generate_migration_name,
    parse_plugin_tables_from_manifest,
)


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
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {"name": "roles"}
            ]
        }
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
            ]
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
            ]
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
            ]
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
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [{"name": "roles"}]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        content = migration_file.read_text()
        assert "def upgrade()" in content
        assert "def downgrade()" in content

    def test_up_creates_tables(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [{"name": "roles"}]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        content = migration_file.read_text()
        assert "create_table" in content.lower() or "create_table" in content

    def test_down_drops_tables(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [{"name": "roles"}]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        content = migration_file.read_text()
        assert "drop_table" in content.lower() or "drop_table" in content

    def test_file_has_revision_id(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [{"name": "roles"}]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        content = migration_file.read_text()
        assert "revision =" in content
        assert "down_revision =" in content

    def test_file_is_valid_python(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [{"name": "roles"}]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        # Should compile without syntax errors
        content = migration_file.read_text()
        compile(content, str(migration_file), "exec")

    def test_multiple_tables_in_one_migration(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [
                {"name": "roles"},
                {"name": "permissions"},
            ]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        content = migration_file.read_text()
        assert "roles" in content
        assert "permissions" in content

    def test_migration_name_in_filename(self):
        manifest = {
            "name": "rbac",
            "version": "1.0.0",
            "tables": [{"name": "roles"}]
        }
        migration_file = generate_migration_for_plugin(
            manifest, self.versions_dir
        )
        assert "roles" in migration_file.name
        assert migration_file.suffix == ".py"