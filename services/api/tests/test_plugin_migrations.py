"""Tests for the plugin migration generator."""

import shutil
import tempfile
from pathlib import Path

import pytest
from api.migrations.plugin_migrations import (
    MigrationScanError,
    _column_to_alembic_def,
    already_created_tables,
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
        assert migration_file is not None
        content = migration_file.read_text()
        assert "def upgrade()" in content
        assert "def downgrade()" in content

    def test_up_creates_tables(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert migration_file is not None
        content = migration_file.read_text()
        assert "create_table" in content.lower() or "create_table" in content

    def test_down_drops_tables(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert migration_file is not None
        content = migration_file.read_text()
        assert "drop_table" in content.lower() or "drop_table" in content

    def test_file_has_revision_id(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert migration_file is not None
        content = migration_file.read_text()
        assert "revision =" in content
        assert "down_revision =" in content

    def test_file_is_valid_python(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert migration_file is not None
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
        assert migration_file is not None
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
        assert migration_file is not None
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
        assert migration_file is not None
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
        assert migration_file is not None
        content = migration_file.read_text()
        compile(content, str(migration_file), "exec")
        assert content.count("op.create_table(") == 2
        assert content.count("op.drop_table(") == 2

    def test_migration_name_in_filename(self):
        manifest = {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        migration_file = generate_migration_for_plugin(manifest, self.versions_dir)
        assert migration_file is not None
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
        assert migration_file is not None
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
        assert migration_file is not None
        content = migration_file.read_text()
        assert "down_revision = '0001'" in content
        # The generated migration is now itself the head — it appended to
        # the chain rather than forking a second one.
        assert get_current_head_revision(self.versions_dir) == migration_file.stem.split("_")[0]

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
        assert first is not None
        assert second is not None
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
        generated = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert generated == []

    def test_generates_migration_for_discovered_plugin(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        generated = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert len(generated) == 1
        assert generated[0].exists()

    def test_plugin_with_no_tables_is_skipped(self):
        self._write_manifest("noop", {"name": "noop", "version": "1.0.0", "tables": []})
        generated = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert generated == []

    def test_rerunning_sync_is_idempotent(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        first = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        second = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
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
        generated = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert len(generated) == 2
        # Exactly one head — sync_plugin_migrations must not fork branches
        # when generating migrations for multiple plugins in one pass.
        assert get_current_head_revision(self.versions_dir) is not None

    def test_only_restricts_to_the_named_plugin(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        self._write_manifest(
            "billing",
            {"name": "billing", "version": "1.0.0", "tables": [{"name": "invoices"}]},
        )
        generated = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root, only={"rbac"}
        )
        assert len(generated) == 1
        assert "roles" in generated[0].name

    def test_only_is_a_noop_when_the_named_plugin_already_has_a_migration(self):
        self._write_manifest(
            "rbac", {"name": "rbac", "version": "1.0.0", "tables": [{"name": "roles"}]}
        )
        first = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root, only={"rbac"}
        )
        second = sync_plugin_migrations(
            self.versions_dir, services_root=self.services_root, only={"rbac"}
        )
        assert len(first) == 1
        assert second == []

    def test_stays_idempotent_after_the_plugin_gains_a_table(self):
        """Regression (issue #1511 review): sync_plugin_migrations used to
        pre-check idempotency via a revision hashed from the plugin's FULL
        current table set, but the on-disk migration's own revision is now
        hashed from only the DELTA it emitted. The first time a plugin's
        table set changed, the pre-check's hash could never match the file
        on disk again, silently defeating the fast path for that plugin
        forever after (it stayed correct via the fallback, but the point of
        an idempotency guard is not to have to fall back)."""
        self._write_manifest(
            "marketing",
            {
                "name": "marketing",
                "version": "1.0.0",
                "tables": [{"name": "marketing_campaign"}],
            },
        )
        first = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert len(first) == 1

        # Plugin gains a table.
        (self.services_root / "marketing" / "biffo.plugin.json").write_text(
            '{"name": "marketing", "version": "1.1.0", "tables": '
            '[{"name": "marketing_campaign"}, {"name": "marketing_channel"}]}'
        )
        second = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert len(second) == 1
        assert "marketing_channel" in second[0].name

        # Re-running against the now-unchanged (post-upgrade) manifest must
        # still be a clean no-op — the case the old full-set hash broke.
        third = sync_plugin_migrations(self.versions_dir, services_root=self.services_root)
        assert third == []
        assert len(list(self.versions_dir.glob("*.py"))) == 2


class TestPluginUpgradeEmitsOnlyTheDelta:
    """Issue #1511: `biffo plugin upgrade` generated a migration containing
    the plugin's ENTIRE table set, not the delta — breaking every existing
    installation (`DuplicateTableError`) and, worse, shipping a `downgrade()`
    that dropped every table the plugin owns, including ones holding live
    data the upgrade never touched.

    Real case this reproduces exactly: upgrading `biffo-plugin-marketing`
    by one table (`marketing_channel`) against a versions_dir that already
    carries a migration for its other five tables.
    """

    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.versions_dir = Path(self.tmpdir) / "versions"
        self.versions_dir.mkdir()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir)

    def test_plugin_already_installed_gains_one_table_emits_only_that_table(self):
        # First install: five tables, matching the marketing plugin's shape
        # before it gained marketing_channel.
        v1 = {
            "name": "marketing",
            "version": "1.0.0",
            "tables": [
                {"name": "marketing_campaign"},
                {"name": "marketing_artefact"},
                {"name": "marketing_asset"},
                {"name": "marketing_link"},
                {"name": "marketing_click"},
            ],
        }
        first = generate_migration_for_plugin(v1, self.versions_dir)
        assert first is not None
        assert first.read_text().count("op.create_table(") == 5

        # Upgrade: the plugin now also declares marketing_channel.
        v2 = {
            "name": "marketing",
            "version": "1.1.0",
            "tables": v1["tables"]
            + [
                {
                    "name": "marketing_channel",
                    "columns": [{"name": "key", "type": "String(64)", "index": True}],
                }
            ],
        }
        second = generate_migration_for_plugin(v2, self.versions_dir)

        assert second is not None
        content = second.read_text()
        # This is the failing assertion before the fix: it generated 6.
        assert content.count("op.create_table(") == 1
        assert "marketing_channel" in content
        for already_installed in (
            "marketing_campaign",
            "marketing_artefact",
            "marketing_asset",
            "marketing_link",
            "marketing_click",
        ):
            assert already_installed not in content

        # Chains onto the first migration rather than forking a head.
        first_revision = first.stem.split("_")[0]
        assert f"down_revision = '{first_revision}'" in content

    def test_downgrade_is_the_exact_inverse_of_the_delta_upgrade(self):
        v1 = {"name": "marketing", "version": "1.0.0", "tables": [{"name": "marketing_campaign"}]}
        generate_migration_for_plugin(v1, self.versions_dir)

        v2 = {
            "name": "marketing",
            "version": "1.1.0",
            "tables": v1["tables"] + [{"name": "marketing_channel"}],
        }
        second = generate_migration_for_plugin(v2, self.versions_dir)
        assert second is not None
        content = second.read_text()

        # The generated downgrade used to drop every table the plugin owns.
        # It must drop only the table(s) this migration's own upgrade
        # creates — never marketing_campaign, which a prior migration
        # created and which may hold live data by the time this runs.
        assert content.count("op.drop_table(") == 1
        assert "op.drop_table('marketing_channel')" in content
        assert "op.drop_table('marketing_campaign')" not in content
        compile(content, str(second), "exec")

    def test_several_prior_migrations_still_yields_only_the_new_table(self):
        # Simulates a plugin whose tables were generated across several
        # separate migrations (not necessarily all in one file), plus an
        # unrelated core migration in the same versions_dir.
        (self.versions_dir / "0001_core.py").write_text(
            "revision = '0001'\n"
            "down_revision = None\n"
            "branch_labels = None\n"
            "depends_on = None\n"
            "def upgrade():\n"
            "    pass\n"
            "def downgrade():\n"
            "    pass\n"
        )
        generate_migration_for_plugin(
            {"name": "marketing", "version": "1.0.0", "tables": [{"name": "marketing_campaign"}]},
            self.versions_dir,
        )
        generate_migration_for_plugin(
            {"name": "marketing", "version": "1.0.1", "tables": [{"name": "marketing_artefact"}]},
            self.versions_dir,
        )

        final = generate_migration_for_plugin(
            {
                "name": "marketing",
                "version": "1.1.0",
                "tables": [
                    {"name": "marketing_campaign"},
                    {"name": "marketing_artefact"},
                    {"name": "marketing_channel"},
                ],
            },
            self.versions_dir,
        )

        assert final is not None
        content = final.read_text()
        assert content.count("op.create_table(") == 1
        assert "marketing_channel" in content
        assert "marketing_campaign" not in content
        assert "marketing_artefact" not in content

    def test_unchanged_table_set_produces_no_migration(self):
        manifest = {
            "name": "marketing",
            "version": "1.0.0",
            "tables": [{"name": "marketing_campaign"}, {"name": "marketing_artefact"}],
        }
        generate_migration_for_plugin(manifest, self.versions_dir)

        # Calling again for the identical table set — every table it
        # declares is already created — must be a no-op, not an empty
        # migration and not a re-creation.
        result = generate_migration_for_plugin(dict(manifest), self.versions_dir)
        assert result is None
        assert len(list(self.versions_dir.glob("*.py"))) == 1

    def test_refuses_rather_than_guesses_when_an_existing_migration_is_unreadable(self):
        # An existing migration file that isn't valid Python — the
        # generator cannot know whether it already creates a table this
        # manifest also declares, so it must refuse rather than risk
        # recreating (or later dropping) a table it can't see.
        (self.versions_dir / "0001_broken.py").write_text("def upgrade(:\n    pass\n")

        manifest = {
            "name": "marketing",
            "version": "1.0.0",
            "tables": [{"name": "marketing_campaign"}],
        }
        with pytest.raises(ValueError, match="Refusing to generate"):
            generate_migration_for_plugin(manifest, self.versions_dir)

    def test_refuses_when_create_table_name_is_not_a_literal(self):
        # A dynamically-computed table name defeats the static scan
        # entirely — refuse rather than silently treat it as "not already
        # created" and risk a duplicate/destructive migration later.
        (self.versions_dir / "0001_dynamic.py").write_text(
            "TABLE_NAME = 'marketing_campaign'\n"
            "def upgrade():\n"
            "    op.create_table(TABLE_NAME)\n"
            "def downgrade():\n"
            "    pass\n"
        )

        manifest = {
            "name": "marketing",
            "version": "1.0.0",
            "tables": [{"name": "marketing_campaign"}],
        }
        with pytest.raises(ValueError, match="Refusing to generate"):
            generate_migration_for_plugin(manifest, self.versions_dir)


class TestAlreadyCreatedTables:
    """Direct tests of the scan `generate_migration_for_plugin` relies on to
    compute the delta."""

    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.versions_dir = Path(self.tmpdir) / "versions"
        self.versions_dir.mkdir()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir)

    def test_empty_versions_dir_has_no_created_tables(self):
        assert already_created_tables(self.versions_dir) == set()

    def test_finds_tables_across_multiple_files(self):
        (self.versions_dir / "0001_a.py").write_text(
            "def upgrade():\n    op.create_table('roles')\n"
        )
        (self.versions_dir / "0002_b.py").write_text(
            "def upgrade():\n    op.create_table('permissions')\n"
        )
        assert already_created_tables(self.versions_dir) == {"roles", "permissions"}

    def test_raises_migration_scan_error_on_unparseable_file(self):
        (self.versions_dir / "0001_broken.py").write_text("def upgrade(:\n")
        with pytest.raises(MigrationScanError):
            already_created_tables(self.versions_dir)

    def test_recognises_table_name_passed_as_a_keyword_argument(self):
        # Alembic's real signature is create_table(table_name, *columns, **kw)
        # — `table_name` is callable by keyword too, not just positionally.
        # Checking only the positional args used to silently treat this form
        # as "no table name" and skip it without raising.
        (self.versions_dir / "0001_kwarg.py").write_text(
            "def upgrade():\n    op.create_table(table_name='legacy_widgets')\n"
        )
        assert already_created_tables(self.versions_dir) == {"legacy_widgets"}

    def test_raises_on_create_table_call_with_no_determinable_name(self):
        (self.versions_dir / "0001_no_name.py").write_text(
            "kwargs = {'table_name': 'x'}\ndef upgrade():\n    op.create_table(**kwargs)\n"
        )
        with pytest.raises(MigrationScanError):
            already_created_tables(self.versions_dir)
