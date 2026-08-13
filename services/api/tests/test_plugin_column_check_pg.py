"""Real-Postgres proof that the deploy-time plugin column guard actually
reads `information_schema` and fails on a column the database genuinely lacks
(biffo-template#1556).

This file is the point of the issue. A check verified only against a passing
case is this estate's most-repeated mistake, and #1539's own record is of a
check that stated a conclusion its comparison never earned — so the fail case
is asserted here against a real table with a real missing column, not against
a mock.

## Why it cannot be a sqlite test

`assert_plugin_columns_exist_async` opens its engine through
`plugin_deploy_checks.open_master_engine()`, which returns
`(None, {"reason": "not-postgres"})` on anything that is not Postgres —
sqlite included, matching `crud_schema_guard`'s posture. And the query itself
is `information_schema.columns`, which sqlite does not have. So the real
comparison is only reachable through this repo's `scripts/pg-test-db.sh` lane
(`test_*_pg.py`, picked up by `verify.sh`'s `pg_test_run`).
`test_plugin_column_check.py` covers everything that needs no database.

## Isolation

Every test creates its own uuid-suffixed table and drops it afterwards — the
pg-test lane's database is genuinely shared with other concurrent sessions
(see `test_plugin_baseline_check_pg.py`'s and `test_ddl_import_environment_pg
.py`'s identical note). Nothing here touches a table the application owns.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

_SERVICES_API_DIR = Path(__file__).resolve().parent.parent


def _pg_dsn() -> str | None:
    return os.environ.get("BIFFO_TEST_PG_DSN") or os.environ.get("TABSII_TEST_PG_DSN")


pytestmark = [
    pytest.mark.skipif(
        _pg_dsn() is None,
        reason='no real Postgres DSN -- eval "$(sh scripts/pg-test-db.sh --export)"',
    ),
    # Creates/drops real tables against the shared pg-lane database.
    pytest.mark.serial,
]


@pytest.fixture
def pg_env(monkeypatch: pytest.MonkeyPatch):
    """Point the check at the real Postgres DSN.

    Patches BOTH module identities (`api.*` and `src.api.*`) for the same
    reason `test_plugin_baseline_check_pg.py`'s fixture documents: this
    repo's test lane can import the same file twice under two names, each
    with its own `Settings` singleton and its own `@lru_cache`d
    `resolve_master_database_url`, so patching one leaves the other stale
    when the files run in the same session.
    """
    import sys

    database_url = _pg_dsn()
    assert database_url is not None  # narrows for pyright; skipif already checked

    monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)

    cleared_caches = []
    for module_name in ("api.database", "src.api.database"):
        if module_name not in sys.modules:
            continue
        db_module = sys.modules[module_name]
        db_module.resolve_master_database_url.cache_clear()
        db_module.resolve_app_database_url.cache_clear()
        cleared_caches.append(db_module)
    for module_name in ("api.config", "src.api.config"):
        if module_name in sys.modules:
            monkeypatch.setattr(sys.modules[module_name].settings, "database_url", database_url)

    monkeypatch.chdir(_SERVICES_API_DIR)
    try:
        yield database_url
    finally:
        for db_module in cleared_caches:
            db_module.resolve_master_database_url.cache_clear()
            db_module.resolve_app_database_url.cache_clear()


async def _exec(database_url: str, sql: str) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(database_url, hide_parameters=True)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


class _Tables:
    """Real tables created for one test, dropped when it finishes."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self._created: list[str] = []

    def name(self, stem: str = "column_check") -> str:
        return f"{stem}_{uuid.uuid4().hex[:12]}"

    async def create(self, name: str, columns_sql: str) -> None:
        self._created.append(name)
        await _exec(self.database_url, f'CREATE TABLE "{name}" ({columns_sql})')  # noqa: S608  # nosec B608

    async def drop_all(self) -> None:
        for name in self._created:
            await _exec(self.database_url, f'DROP TABLE IF EXISTS "{name}"')  # noqa: S608  # nosec B608


@pytest.fixture
async def tables(pg_env: str):
    fx = _Tables(pg_env)
    try:
        yield fx
    finally:
        await fx.drop_all()


#: The DDL for the four auto-columns `PluginTableDefinition` injects into
#: every plugin table. Spelled out here rather than derived, so a test table
#: is a real, independent second opinion about what the schema should be
#: rather than a restatement of the code under test.
AUTO_COLUMNS_SQL = (
    "id text primary key, tenant_id text not null, created_at timestamptz, updated_at timestamptz"
)


def _manifest(plugin: str, table: str, columns: list[dict]) -> dict:
    return {"name": plugin, "tables": [{"name": table, "columns": columns}]}


class TestAssertPluginColumnsExist:
    async def test_a_declared_column_the_database_lacks_fails_the_deploy(
        self, tables: _Tables, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """**The whole point of #1556.** The manifest declares `channel`, the
        table does not have it, everything else about the deploy is fine — and
        this must fail, naming the environment, the plugin, the table and the
        column.

        This is the shape `biffo-plugin-marketing#116` shipped dead to
        production: code, tests, UI and both repos' CI all green, the column
        simply not there.
        """
        # Imported (not read from sys.modules) so the patch lands whether or
        # not some earlier test file happened to import this identity first —
        # `assert_plugin_columns_exist_async` reads `api.config.settings`, and
        # a conditional patch that silently no-ops would make this assertion
        # pass for the wrong reason.
        import api.config
        from api.plugin_column_check import assert_plugin_columns_exist_async

        monkeypatch.setattr(api.config.settings, "environment", "prod")

        table = tables.name("marketing_placements")
        await tables.create(table, f"{AUTO_COLUMNS_SQL}, headline text")

        with pytest.raises(RuntimeError) as exc_info:
            await assert_plugin_columns_exist_async(
                manifests=[
                    _manifest(
                        "marketing",
                        table,
                        [
                            {"name": "headline", "type": "Text"},
                            {"name": "channel", "type": "String(64)"},
                        ],
                    )
                ]
            )

        message = str(exc_info.value)
        assert "prod" in message, "the failure must name the environment"
        assert "marketing" in message, "the failure must name the plugin"
        assert table in message, "the failure must name the table"
        assert "channel" in message, "the failure must name the column"
        # `headline` is present -- it must not be reported as missing.
        assert "headline" not in message.split("Fix by")[0]

    async def test_a_matching_schema_passes(self, tables: _Tables) -> None:
        from api.plugin_column_check import assert_plugin_columns_exist_async

        table = tables.name()
        await tables.create(table, f"{AUTO_COLUMNS_SQL}, headline text")

        result = await assert_plugin_columns_exist_async(
            manifests=[_manifest("marketing", table, [{"name": "headline", "type": "Text"}])]
        )

        assert result["gaps"] == []
        assert result["tables_checked"] == 1
        # 1 declared + the 4 auto-columns.
        assert result["columns_checked"] == 5

    async def test_a_column_the_manifest_does_not_declare_does_not_fail(
        self, tables: _Tables
    ) -> None:
        """One-directional, deliberately: plugins share a database with Core
        and with an instance's own DDL imports (ADR-0005), so extra columns
        are ordinary and must never fail a deploy."""
        from api.plugin_column_check import assert_plugin_columns_exist_async

        table = tables.name()
        await tables.create(
            table, f"{AUTO_COLUMNS_SQL}, headline text, an_instances_own_column text"
        )

        result = await assert_plugin_columns_exist_async(
            manifests=[_manifest("marketing", table, [{"name": "headline", "type": "Text"}])]
        )

        assert result["gaps"] == []

    async def test_a_missing_auto_column_is_caught_even_though_no_manifest_declares_it(
        self, tables: _Tables
    ) -> None:
        """`tenant_id` is injected by `PluginTableDefinition`, never written in
        a manifest, and generic CRUD filters every query by it — its absence is
        exactly the runtime 500 #1018 and tabsii-platform#429/#436 record."""
        from api.plugin_column_check import assert_plugin_columns_exist_async

        table = tables.name()
        await tables.create(table, "id text primary key, headline text")  # no tenant_id

        with pytest.raises(RuntimeError, match="tenant_id"):
            await assert_plugin_columns_exist_async(
                manifests=[_manifest("marketing", table, [{"name": "headline", "type": "Text"}])]
            )

    async def test_a_table_that_does_not_exist_at_all_fails_saying_so(
        self, tables: _Tables
    ) -> None:
        """A migration generated but never applied to *this* environment —
        one of the routes #1551's tool-level fix explicitly does not close."""
        from api.plugin_column_check import assert_plugin_columns_exist_async

        never_created = tables.name()

        with pytest.raises(RuntimeError) as exc_info:
            await assert_plugin_columns_exist_async(
                manifests=[
                    _manifest("marketing", never_created, [{"name": "headline", "type": "Text"}])
                ]
            )

        assert "table does not exist" in str(exc_info.value)
        assert never_created in str(exc_info.value)

    async def test_a_type_mismatch_passes_which_is_the_documented_limit(
        self, tables: _Tables
    ) -> None:
        """Not an accident and not an aspiration — the deliberate boundary of
        this check, asserted so it cannot drift silently. `count` is declared
        `Integer` and created `text`; the column exists, so this passes. See
        the module docstring's "What is compared, and what is not" for why
        name-only was chosen over a manifest->SQLAlchemy->Postgres type map
        that would fail deploys falsely.
        """
        from api.plugin_column_check import assert_plugin_columns_exist_async

        table = tables.name()
        await tables.create(table, f"{AUTO_COLUMNS_SQL}, count text")  # declared Integer

        result = await assert_plugin_columns_exist_async(
            manifests=[_manifest("marketing", table, [{"name": "count", "type": "Integer"}])]
        )

        assert result["gaps"] == []
        assert result["compared"] == "column names only"
        assert "type" in result["not_compared"]

    async def test_a_nullable_mismatch_also_passes_and_is_named_as_uncompared(
        self, tables: _Tables
    ) -> None:
        """Second half of the same documented limit: declared `nullable=False`
        against a nullable column is not caught."""
        from api.plugin_column_check import assert_plugin_columns_exist_async

        table = tables.name()
        await tables.create(table, f"{AUTO_COLUMNS_SQL}, headline text NULL")

        result = await assert_plugin_columns_exist_async(
            manifests=[
                _manifest(
                    "marketing", table, [{"name": "headline", "type": "Text", "nullable": False}]
                )
            ]
        )

        assert result["gaps"] == []
        assert "nullability" in result["not_compared"]

    async def test_one_plugins_gap_does_not_hide_another_plugins_gap(self, tables: _Tables) -> None:
        """Both are reported in one failure, so a deploy is not fixed twice."""
        from api.plugin_column_check import assert_plugin_columns_exist_async

        first = tables.name("alpha")
        second = tables.name("beta")
        await tables.create(first, AUTO_COLUMNS_SQL)
        await tables.create(second, AUTO_COLUMNS_SQL)

        with pytest.raises(RuntimeError) as exc_info:
            await assert_plugin_columns_exist_async(
                manifests=[
                    _manifest("alpha", first, [{"name": "a_col", "type": "Text"}]),
                    _manifest("beta", second, [{"name": "b_col", "type": "Text"}]),
                ]
            )

        message = str(exc_info.value)
        assert "a_col" in message and "b_col" in message
        assert "alpha" in message and "beta" in message
