"""Real-Postgres proof that assert_plugin_baselines_populated_async actually
reads rows and fails/passes correctly (biffo-template#1554).

Why this cannot be a sqlite test: `assert_plugin_baselines_populated_async`
opens its engine via `plugin_deploy_checks.open_master_engine()`, which
checks `db_app_role.is_postgres()` first and returns `(None, {"reason":
"not-postgres"})` on anything else — sqlite included, matching
`crud_schema_guard`'s own posture (see that module's docstring). So the real
row-reading logic — "does this table actually have this tenant's rows" — is
only reachable against a real Postgres, per this repo's
`scripts/pg-test-db.sh` lane (`test_*_pg.py`, picked up by `verify.sh`'s
`pg_test_run`). `test_plugin_baseline_check.py` covers everything that
doesn't need a database (manifest parsing, message formatting); this file is
the other half.

## Why this never touches the real `users` table

`assert_plugin_baselines_populated_async` takes `tenant_source_table` purely
for this reason: writing real rows into the shared pg-test-lane database's
actual `users` table would be visible to every other test/session that reads
it concurrently. Every test here creates its own throwaway, uuid-suffixed
"tenant source" table instead and points the check at it — the same
uuid-scoping `test_main_ddl_import.py`'s `guarded_seed_<key>` tables use for
the same reason (isolation on a genuinely shared database, not a private one
per test run).
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
        reason=(
            "NEVER EXECUTED IN THIS REPO -- biffo-template ships no Postgres CI lane "
            "(biffo-template#1648), so this test has not run once here; a green suite "
            "proves nothing about the code it guards. Run it for real: "
            'eval "$(sh scripts/pg-test-db.sh --export)"'
        ),
    ),
    # Creates/drops real tables against the shared pg-lane database — same
    # concurrency hazard test_ddl_import_environment_pg.py flags for its own
    # CREATE TABLE use.
    pytest.mark.serial,
]


@pytest.fixture
def pg_env(monkeypatch: pytest.MonkeyPatch):
    """Points the check at the real Postgres DSN, mirroring
    test_ddl_import_environment_pg.py's guarded_seed_env fixture, with one
    correction: this repo's test lane can import the same file under TWO
    distinct module identities — `api.*` (this file's own `from
    api.plugin_baseline_check import ...`, matching test_plugin_baseline_
    check.py and test_crud_schema_guard.py) and `src.api.*` (what
    test_ddl_import_environment_pg.py imports through). Each identity gets
    its OWN `Settings` singleton, so patching only one leaves the other
    reading whatever it read at first import in this pytest session.
    `resolve_master_database_url` is no longer `@lru_cache`d (#1725) — it
    used to additionally need clearing per identity here, which is why this
    fixture used to reach into `sys.modules["api.database"]` and
    `sys.modules["src.api.database"]` directly; that reasoning no longer
    applies, only the `Settings` patch below does. Patch both identities
    defensively rather than assume which one is live.
    """
    import sys

    database_url = _pg_dsn()
    assert database_url is not None  # narrows for pyright; skipif already checked

    monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)

    for module_name in ("api.config", "src.api.config"):
        if module_name in sys.modules:
            monkeypatch.setattr(sys.modules[module_name].settings, "database_url", database_url)

    monkeypatch.chdir(_SERVICES_API_DIR)
    yield database_url


async def _exec(database_url: str, sql: str, params: dict[str, object] | None = None) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(database_url, hide_parameters=True)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql), params or {})
    finally:
        await engine.dispose()


def _manifest(plugin: str, table: str, baseline_tables: list[str] | None = None) -> dict:
    return {
        "name": plugin,
        "tables": [{"name": table}],
        "seed": {"dir": "db/seed", "baseline_tables": baseline_tables or [table]},
    }


class _Fixture:
    """One uuid-scoped tenant-source table plus a create/drop helper for
    baseline tables, all cleaned up when the test's `with` block exits."""

    def __init__(self, database_url: str, key: str) -> None:
        self.database_url = database_url
        self.tenant_source = f"baseline_check_tenants_{key}"
        self._tables = [self.tenant_source]

    async def create_tenant_source(self, tenant_ids: list[str]) -> None:
        await _exec(
            self.database_url,
            f'CREATE TABLE "{self.tenant_source}" (id serial primary key, tenant_id text)',  # noqa: S608  # nosec B608
        )
        for tid in tenant_ids:
            await _exec(
                self.database_url,
                f'INSERT INTO "{self.tenant_source}" (tenant_id) VALUES (:tid)',  # noqa: S608  # nosec B608
                {"tid": tid},
            )

    async def create_baseline_table(self, name: str, rows: list[str]) -> None:
        """`rows` is the list of tenant_ids to insert — may be empty (an
        existing-but-empty table, the exact "seed ran but inserted nothing"
        shape #1554 records)."""
        self._tables.append(name)
        await _exec(
            self.database_url,
            f'CREATE TABLE "{name}" (id serial primary key, tenant_id text)',  # noqa: S608  # nosec B608
        )
        for tid in rows:
            await _exec(
                self.database_url,
                f'INSERT INTO "{name}" (tenant_id) VALUES (:tid)',  # noqa: S608  # nosec B608
                {"tid": tid},
            )

    async def drop_all(self) -> None:
        for name in self._tables:
            await _exec(self.database_url, f'DROP TABLE IF EXISTS "{name}"')  # noqa: S608  # nosec B608


@pytest.fixture
async def fixture_tables(pg_env: str):
    key = uuid.uuid4().hex[:12]
    fx = _Fixture(pg_env, key)
    try:
        yield fx
    finally:
        await fx.drop_all()


class TestAssertPluginBaselinesPopulated:
    async def test_populated_table_passes(self, fixture_tables: _Fixture) -> None:
        from api.plugin_baseline_check import assert_plugin_baselines_populated_async

        table = f"widgets_items_{uuid.uuid4().hex[:8]}"
        await fixture_tables.create_tenant_source(["acme"])
        await fixture_tables.create_baseline_table(table, rows=["acme"])

        result = await assert_plugin_baselines_populated_async(
            manifests=[_manifest("widgets", table)],
            tenant_source_table=fixture_tables.tenant_source,
        )

        assert result["checked"] == 1
        assert result["failures"] == []
        assert result["tenants"] == ["acme"]

    async def test_empty_table_fails_loudly(self, fixture_tables: _Fixture) -> None:
        """The exact shape #1554 records: the seed applied without error and
        the table exists, but has zero rows for a tenant this deployment
        already knows about."""
        from api.plugin_baseline_check import assert_plugin_baselines_populated_async

        table = f"widgets_items_{uuid.uuid4().hex[:8]}"
        await fixture_tables.create_tenant_source(["acme"])
        await fixture_tables.create_baseline_table(table, rows=[])  # applied, inserted nothing

        with pytest.raises(RuntimeError) as exc_info:
            await assert_plugin_baselines_populated_async(
                manifests=[_manifest("widgets", table)],
                tenant_source_table=fixture_tables.tenant_source,
            )

        message = str(exc_info.value)
        assert "widgets" in message
        assert table in message
        assert "acme" in message

    async def test_missing_table_fails_loudly_the_same_way(self, fixture_tables: _Fixture) -> None:
        """A declared baseline table that was never created at all (seed.dir
        never vendored, wrong directory, etc) must fail exactly like an empty
        one — see the module docstring's "indistinguishable, and that's
        correct" note."""
        from api.plugin_baseline_check import assert_plugin_baselines_populated_async

        never_created = f"widgets_items_{uuid.uuid4().hex[:8]}"
        await fixture_tables.create_tenant_source(["acme"])

        with pytest.raises(RuntimeError, match="acme"):
            await assert_plugin_baselines_populated_async(
                manifests=[_manifest("widgets", never_created)],
                tenant_source_table=fixture_tables.tenant_source,
            )

    async def test_multi_tenant_partial_population_fails_naming_only_the_missing_tenant(
        self, fixture_tables: _Fixture
    ) -> None:
        """Populated for one tenant, empty for another -- must fail, and the
        failure must name the tenant that is actually missing, not the one
        that is fine."""
        from api.plugin_baseline_check import assert_plugin_baselines_populated_async

        table = f"widgets_items_{uuid.uuid4().hex[:8]}"
        await fixture_tables.create_tenant_source(["acme", "globex"])
        await fixture_tables.create_baseline_table(table, rows=["acme"])  # globex missing

        with pytest.raises(RuntimeError) as exc_info:
            await assert_plugin_baselines_populated_async(
                manifests=[_manifest("widgets", table)],
                tenant_source_table=fixture_tables.tenant_source,
            )

        message = str(exc_info.value)
        assert "globex" in message
        # acme is fully populated -- it must not be reported as missing.
        assert "no rows for tenant(s): acme" not in message
        assert "no rows for tenant(s): acme, globex" not in message

    async def test_no_known_tenants_passes_vacuously(self, fixture_tables: _Fixture) -> None:
        """A fresh deployment with no tenant yet has nothing to have failed
        to seed -- see the module docstring's "known tenant" section."""
        from api.plugin_baseline_check import assert_plugin_baselines_populated_async

        table = f"widgets_items_{uuid.uuid4().hex[:8]}"
        await fixture_tables.create_tenant_source([])  # table exists, zero tenants
        await fixture_tables.create_baseline_table(table, rows=[])

        result = await assert_plugin_baselines_populated_async(
            manifests=[_manifest("widgets", table)],
            tenant_source_table=fixture_tables.tenant_source,
        )

        assert result["failures"] == []

    async def test_a_plugin_with_no_seed_is_unaffected_and_touches_no_database(
        self, fixture_tables: _Fixture
    ) -> None:
        """No baseline_tables declared anywhere -> short-circuits before ever
        opening an engine (see assert_plugin_baselines_populated_async's
        early return) -- proven here by NOT creating a tenant-source table at
        all and still getting a clean pass rather than a connection error."""
        from api.plugin_baseline_check import assert_plugin_baselines_populated_async

        result = await assert_plugin_baselines_populated_async(
            manifests=[{"name": "widgets", "tables": [{"name": "widgets_items"}]}],
            tenant_source_table="table_that_does_not_exist_and_is_never_queried",
        )

        assert result == {"checked": 0, "failures": []}
