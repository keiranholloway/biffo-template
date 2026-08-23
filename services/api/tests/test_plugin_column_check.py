"""Database-free half of the deploy-time plugin column guard
(biffo-template#1556).

`test_plugin_column_check_pg.py` is the other half: the real-Postgres proof
that the check actually reads `information_schema` and fails on a column the
database genuinely lacks. This file covers everything reachable without a
database — declaration parsing, the comparison, the message, and the two
paths that never open an engine at all (no declared tables; not Postgres).

The split matters for the same reason `crud_schema_guard`'s docstring gives:
the API's ordinary test lane builds its schema from the ORM's own metadata,
so a column is present *because* the model declared it. Only a real database
can disagree with a manifest, so only the `_pg` file can prove the fail case
end to end — and only the pure functions here can be exercised in CI's
Postgres-less Python job.
"""

from __future__ import annotations

import pytest
from api.plugin_column_check import (
    ColumnGap,
    DeclaredTable,
    UnreadableDeclaration,
    assert_plugin_columns_exist_async,
    collect_declared_tables,
    find_plugin_column_gaps,
    format_column_error,
)

#: The four columns `PluginTableDefinition` injects into every plugin table
#: (ADR-0001's TenantScopedModel shape). No manifest declares these, and
#: `tenant_id`'s absence is the exact runtime failure #1018 records — so a
#: check that only looked at explicitly-declared columns would miss the most
#: valuable one.
AUTO_COLUMNS = {"id", "tenant_id", "created_at", "updated_at"}


def _manifest(plugin: str, table: str, columns: list[dict] | None = None) -> dict:
    return {
        "name": plugin,
        "tables": [
            {
                "name": table,
                "columns": columns
                if columns is not None
                else [{"name": "headline", "type": "String(255)"}],
            }
        ],
    }


class TestCollectDeclaredTables:
    def test_reads_declared_columns_including_the_auto_columns(self):
        declared, unreadable = collect_declared_tables(
            [_manifest("widgets", "widget_items")], "dev"
        )

        assert unreadable == []
        assert len(declared) == 1
        assert declared[0].plugin == "widgets"
        assert declared[0].table == "widget_items"
        assert set(declared[0].columns) == {"headline"} | AUTO_COLUMNS

    def test_keeps_the_declared_type_string_for_the_message_only(self):
        declared, _ = collect_declared_tables([_manifest("widgets", "widget_items")], "dev")
        assert declared[0].columns["headline"] == "String(255)"

    def test_a_plugin_declaring_no_tables_contributes_nothing_and_is_not_an_error(self):
        declared, unreadable = collect_declared_tables([{"name": "frontend_only"}], "dev")
        assert declared == []
        assert unreadable == []

    def test_an_unparseable_manifest_is_reported_not_silently_skipped(self):
        # `tenant_id` is a reserved auto-column: PluginTableDefinition rejects
        # a manifest that redeclares it. A cannot-tell must never be a pass.
        bad = {"name": "widgets", "tables": [{"name": "w", "columns": [{"name": "tenant_id"}]}]}
        declared, unreadable = collect_declared_tables([bad], "prod")

        assert declared == []
        assert len(unreadable) == 1
        assert unreadable[0].plugin == "widgets"
        assert unreadable[0].environment == "prod"

    def test_one_broken_manifest_does_not_hide_another_plugins_real_declaration(self):
        bad = {"name": "broken", "tables": [{"name": "w", "columns": [{"name": "id"}]}]}
        declared, unreadable = collect_declared_tables(
            [bad, _manifest("widgets", "widget_items")], "dev"
        )

        assert [d.plugin for d in declared] == ["widgets"]
        assert [u.plugin for u in unreadable] == ["broken"]

    def test_a_table_name_that_is_not_a_plain_identifier_is_reported_as_unreadable(self):
        # Postgres folds an unquoted identifier to lower case, so `Widgets`
        # would otherwise be reported as "table does not exist" and send the
        # reader hunting for a migration rather than a typo.
        declared, unreadable = collect_declared_tables([_manifest("widgets", "Widgets")], "dev")

        assert declared == []
        assert "not a valid unquoted identifier" in unreadable[0].reason

    def test_a_manifest_that_is_not_an_object_is_reported_rather_than_crashing(self):
        declared, unreadable = collect_declared_tables(["not-a-manifest"], "dev")  # type: ignore[list-item]
        assert declared == []
        assert unreadable[0].plugin == "<unnamed>"


class TestFindPluginColumnGaps:
    def test_a_declared_column_missing_from_the_table_is_a_gap(self):
        declared = [DeclaredTable("widgets", "widget_items", {"headline": "String(255)"})]
        gaps = find_plugin_column_gaps(declared, {"widget_items": {"id", "tenant_id"}}, "staging")

        assert gaps == [
            ColumnGap(
                environment="staging",
                plugin="widgets",
                table="widget_items",
                missing=(("headline", "String(255)"),),
                table_exists=True,
            )
        ]

    def test_a_column_the_database_has_and_the_manifest_does_not_is_not_a_gap(self):
        """The manifest is the contract for what must exist, not for what may
        not — plugins share a database with Core and with an instance's own
        DDL imports (ADR-0005), so extra columns are ordinary."""
        declared = [DeclaredTable("widgets", "widget_items", {"headline": "String(255)"})]
        actual = {"widget_items": {"headline", "id", "tenant_id", "an_instances_own_column"}}

        assert find_plugin_column_gaps(declared, actual, "dev") == []

    def test_a_missing_table_is_reported_as_a_missing_table_not_as_loose_columns(self):
        declared = [DeclaredTable("widgets", "widget_items", {"headline": "String(255)"})]
        gaps = find_plugin_column_gaps(declared, {}, "dev")

        assert gaps[0].table_exists is False
        assert "table does not exist" in gaps[0].describe()

    def test_two_plugins_declaring_one_table_name_merge_rather_than_one_being_dropped(self):
        """Impossible past db-init (`build_permissions_registry(strict=True)`
        fails on a duplicate table name first), but handled rather than
        assumed away — neither plugin's promise may go unasserted."""
        declared = [
            DeclaredTable("alpha", "shared", {"a_col": "Integer"}),
            DeclaredTable("beta", "shared", {"b_col": "Integer"}),
        ]
        gaps = find_plugin_column_gaps(declared, {"shared": set()}, "dev")

        assert gaps[0].plugin == "alpha, beta"
        assert dict(gaps[0].missing) == {"a_col": "Integer", "b_col": "Integer"}

    def test_nothing_declared_is_no_gaps(self):
        assert find_plugin_column_gaps([], {"widget_items": {"id"}}, "dev") == []


class TestFormatColumnError:
    def test_names_the_environment_plugin_table_and_column(self):
        """The whole reason this is a separate assertion: the check runs in
        three environments, and a failure that says only "check failed" costs
        more than it saves."""
        message = format_column_error(
            "prod",
            [
                ColumnGap(
                    environment="prod",
                    plugin="marketing",
                    table="marketing_placements",
                    missing=(("channel", "String(64)"),),
                    table_exists=True,
                )
            ],
            [],
        )

        assert "prod" in message
        assert "marketing" in message
        assert "marketing_placements" in message
        assert "channel" in message
        assert "String(64)" in message

    def test_says_what_it_compared_and_what_it_did_not(self):
        message = format_column_error(
            "dev",
            [ColumnGap("dev", "p", "t", (("c", "Integer"),), True)],
            [],
        )
        assert "column names only" in message
        for not_compared in ("type", "nullability", "default", "indexes"):
            assert not_compared in message

    def test_an_unreadable_manifest_reads_as_a_cannot_tell_not_as_a_pass(self):
        message = format_column_error(
            "staging", [], [UnreadableDeclaration("staging", "broken", "bad table def")]
        )
        assert "could not be read" in message
        assert "not a pass" in message
        assert "broken" in message


class TestAssertPluginColumnsExistAsync:
    async def test_no_plugin_declares_a_table_passes_and_never_opens_an_engine(self):
        """Deliberately a pass, not a suspicion: an ADR-0003 plugin may be
        pure frontend or pure compute and promise nothing about the schema.
        Proven to touch no database by leaving the settings pointing at
        nothing usable and still getting a clean summary back."""
        result = await assert_plugin_columns_exist_async(
            manifests=[{"name": "frontend_only"}, {"name": "compute_only", "tables": []}]
        )

        assert result["tables_checked"] == 0
        assert result["columns_checked"] == 0
        assert result["plugins"] == 2
        assert result["gaps"] == []

    async def test_the_summary_distinguishes_nothing_bundled_from_nothing_declared(self):
        """`plugins: 0` and `plugins: 2, tables_checked: 0` are different
        states, and a check whose silence cannot be interpreted is the defect
        #1539 records."""
        nothing_bundled = await assert_plugin_columns_exist_async(manifests=[])
        nothing_declared = await assert_plugin_columns_exist_async(
            manifests=[{"name": "a"}, {"name": "b"}]
        )

        assert nothing_bundled["plugins"] == 0
        assert nothing_declared["plugins"] == 2
        assert nothing_bundled["tables_checked"] == nothing_declared["tables_checked"] == 0

    async def test_an_unreadable_manifest_fails_even_when_nothing_else_is_declared(self):
        bad = {"name": "widgets", "tables": [{"name": "w", "columns": [{"name": "id"}]}]}
        with pytest.raises(RuntimeError, match="could not be read"):
            await assert_plugin_columns_exist_async(manifests=[bad])

    async def test_skips_a_non_postgres_deployment_and_says_so(self, monkeypatch, tmp_path):
        """Mirrors `crud_schema_guard`'s posture: the information_schema query
        is Postgres-shaped, and a non-Postgres deployment is not what this
        guard exists to protect. The reason is in the response so the skip is
        visible in the deploy log rather than looking like a pass."""
        import sys

        database_url = f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"
        monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)
        if "api.config" in sys.modules:
            monkeypatch.setattr(sys.modules["api.config"].settings, "database_url", database_url)

        result = await assert_plugin_columns_exist_async(
            manifests=[_manifest("widgets", "widget_items")]
        )

        assert result["reason"] == "not-postgres"
        assert result["gaps"] == []

    async def test_a_failed_information_schema_read_is_not_reported_as_missing_columns(
        self, monkeypatch
    ):
        """The #1560 review's three-way posture, applied here: a query that
        fails is neither "columns present" nor "columns missing". Reporting it
        as missing fails a deploy that may have been fine; swallowing it goes
        silent exactly when the check matters.
        """
        import api.crud_schema_guard as crud_schema_guard
        import api.plugin_column_check as module
        from api.plugin_column_check import SchemaQueryFailedError

        class _FakeConn:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc_info):
                return False

        class _FakeEngine:
            def connect(self):
                return _FakeConn()

            async def dispose(self):
                return None

        async def fake_open():
            return _FakeEngine(), None

        async def fake_actual_columns(conn, tables, schemas):
            from sqlalchemy.exc import DBAPIError

            raise DBAPIError("SELECT ...", {}, Exception("connection reset"))

        monkeypatch.setattr(module, "open_master_engine", fake_open)
        monkeypatch.setattr(crud_schema_guard, "actual_columns", fake_actual_columns)

        with pytest.raises(SchemaQueryFailedError, match="UNKNOWN"):
            await assert_plugin_columns_exist_async(
                manifests=[_manifest("widgets", "widget_items")]
            )
