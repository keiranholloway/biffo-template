"""Real-Postgres proof that a DDL seed module can gate itself to one
environment (tabsii-platform#830).

Why this cannot be a sqlite test: `test_main_ddl_import.py`'s own docstring
already documents that the "fresh apply actually works" path — raw asyncpg
`.execute()`/`.transaction()` calls on the driver connection, which is where
`_run_ddl_import` publishes the `biffo.environment` GUC — cannot run against
sqlite at all (`aiosqlite`'s driver connection has neither method). A guarded
`DO $$ ... current_setting(...) ... END $$;` block is exactly that path, so
proving the guard actually gates requires a real Postgres, per this repo's own
`scripts/pg-test-db.sh` lane (`test_*_pg.py`, picked up by `verify.sh`'s
`pg_test_run`).

Each scenario applies its own DDL import name against a `guarded_seed_<key>`
table private to this test run (`<key>` is a fresh uuid4 hex per run), so the
three `_run_ddl_import` calls below never collide with the checksum-based
"already applied, skip" path — each genuinely executes rather than skipping.

## Why the fixture also isolates the CRUD-schema completeness check

`_run_ddl_import` unconditionally calls `assert_crud_schema_matches_async()`
at the end of every invocation (`main.py`) — correct in production, where it
runs once, after Alembic and after the instance's real `db/imports/<name>/`
batch, so the whole registered generic-CRUD schema is complete by the time it
runs. This fixture builds neither: no Alembic head beyond what
`pg-test-db.sh` seeds, no real DDL import, just one throwaway
`guarded_seed_<key>` table. In the bare template that is invisible, because
no core table opts into generic CRUD. In an instance with registered
generic-CRUD models (tabsii has 50), the check runs anyway, queries the same
real database this fixture points at, and fails every one of them as
"table does not exist" — none of them were ever created here (biffo-template
#1453).

That is a different guard doing its job against an input this test was never
trying to give it a fair run at. This test's docstring is about the
environment gate, not whole-schema completeness (`test_crud_schema_guard.py`
covers the pure comparison logic, and a real deploy exercises it against a
schema this fixture never attempts to build) — so the fixture isolates the
schema check the same way it isolates the imports root, rather than trying
to satisfy it with data the DDL-import path this test drives was never asked
to create.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path
from typing import Any

import asyncpg
import pytest

_SERVICES_API_DIR = Path(__file__).resolve().parent.parent


def _pg_dsn() -> str | None:
    # Both names, deliberately: `scripts/pg-test-db.sh --export` sets both
    # (tabsii-platform#755), and different consumers in this estate read one
    # or the other.
    return os.environ.get("BIFFO_TEST_PG_DSN") or os.environ.get("TABSII_TEST_PG_DSN")


pytestmark = [
    pytest.mark.skipif(
        _pg_dsn() is None,
        reason='no real Postgres DSN -- eval "$(sh scripts/pg-test-db.sh --export)"',
    ),
    # This file performs real DDL (CREATE TABLE, via _run_ddl_import) against
    # the shared pg-lane database, so it cannot share the database with a
    # concurrent worker -- the same shape test_serial_marker_coverage_pg.py
    # (biffo-template#703 class) flags. Concurrently that produces "tuple
    # concurrently updated" / "cache lookup failed" flakes, not a clean
    # failure.
    pytest.mark.serial,
]


@pytest.fixture
def guarded_seed_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Points `_run_ddl_import` at the real Postgres DSN and a throwaway
    db/imports root, mirroring `test_main_ddl_import.py`'s `ddl_import_env`
    fixture but against Postgres instead of sqlite — the one substitution
    that makes the guarded-SQL path reachable at all.

    `resolve_master_database_url`/`resolve_app_database_url` used to be
    `@lru_cache(maxsize=1)`, process-wide and keyed on nothing, so the first
    caller anywhere in a pytest session decided the URL for every caller
    after it — this fixture's real DSN would otherwise survive into
    `test_main_ddl_import.py`'s sqlite-backed tests when both ran in the same
    session. They are no longer cached (#1725), so there is nothing left to
    clear here; the `BIFFO_DATABASE_URL`/`Settings` patch below is what
    actually scopes the DSN to this test.
    """
    database_url = _pg_dsn()
    assert database_url is not None  # narrows for pyright; skipif already checked

    monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(sys.modules["src.api.config"].settings, "database_url", database_url)

    imports_root = tmp_path / "db" / "imports"
    monkeypatch.setenv("BIFFO_DDL_IMPORT_ROOT", str(imports_root))
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings, "ddl_import_root", str(imports_root)
        )

    # Isolate the whole-schema generic-CRUD completeness check the same way
    # the imports root above is isolated (see the module docstring). This
    # fixture never builds the full schema -- no Alembic head beyond what
    # pg-test-db.sh seeds, no real DDL import -- so `_run_ddl_import`'s own
    # unconditional call to `assert_crud_schema_matches_async()` is not a
    # fair test of anything this file's docstring claims to prove. Patched at
    # the same name `main.py`'s `_apply()` imports (`from .crud_schema_guard
    # import assert_crud_schema_matches_async`), which resolves this module
    # attribute at call time, so the stub is picked up regardless of how many
    # times `_run_ddl_import` runs inside one test.
    import src.api.crud_schema_guard as crud_schema_guard

    async def _isolated_crud_schema_check() -> dict[str, Any]:
        return {
            "checked": 0,
            "drift": [],
            "reason": "isolated-for-ddl-import-env-gate-test",
        }

    monkeypatch.setattr(
        crud_schema_guard, "assert_crud_schema_matches_async", _isolated_crud_schema_check
    )

    monkeypatch.chdir(_SERVICES_API_DIR)
    yield {"database_url": database_url, "imports_root": imports_root}


def _write_guarded_module(imports_root: Path, import_name: str, table: str, note: str) -> None:
    import_dir = imports_root / import_name
    import_dir.mkdir(parents=True, exist_ok=True)
    # `table` is this test's own uuid4-derived identifier (see the callers),
    # never external input -- the interpolation is identifier construction for
    # a throwaway fixture table, not a value in a query.
    sql = f"""
CREATE TABLE IF NOT EXISTS {table} (id serial primary key, note text);

DO $$
BEGIN
  IF current_setting('biffo.environment', true) = 'dev' THEN
    INSERT INTO {table} (note) VALUES ('{note}');
  END IF;
END $$;
"""  # noqa: S608  # nosec B608
    (import_dir / "000_guarded_seed.sql").write_text(sql)


async def _fetch_notes(database_url: str, table: str) -> list[str]:
    # asyncpg wants a plain postgres DSN, not the +asyncpg SQLAlchemy variant.
    dsn = database_url.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)
    try:
        # `table` is this test's own uuid4-derived identifier, not external
        # input (see callers) -- no bind parameter applies to an identifier.
        rows = await conn.fetch(f"SELECT note FROM {table} ORDER BY note")  # noqa: S608  # nosec B608
        return [r["note"] for r in rows]
    finally:
        await conn.close()


class TestDdlSeedEnvironmentGate:
    """Three directions, per tabsii-platform#830: unset and non-dev must both
    seed nothing (the fail-safe half is the one that matters); dev must
    still seed. Before the `biffo.environment` GUC was published at all, the
    `dev` case failed here too — a guarded module correctly refused to insert
    for EVERY environment, because `current_setting(..., true)` had nothing
    to read. That is the fail-first evidence: this test is red without
    `_run_ddl_import` setting the GUC, and green with it, on the one
    assertion that is supposed to differ."""

    def test_environment_unset_seeds_nothing(
        self, guarded_seed_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        key = uuid.uuid4().hex[:8]
        table = f"guarded_seed_{key}"
        import_name = f"guard_unset_{key}"
        _write_guarded_module(guarded_seed_env["imports_root"], import_name, table, "unset-run")

        monkeypatch.delenv("BIFFO_ENVIRONMENT", raising=False)

        from src.api.main import _run_ddl_import

        result = _run_ddl_import(import_name)
        assert result["applied"] == ["000_guarded_seed.sql"]
        # Proof the fixture's isolation actually took effect here, not just
        # that nothing raised -- asserted once (not in every scenario in this
        # class) since it is a property of the fixture, not of the
        # environment being tested.
        assert result["crud_schema"]["reason"] == "isolated-for-ddl-import-env-gate-test"

        notes = asyncio.run(_fetch_notes(guarded_seed_env["database_url"], table))
        assert notes == [], (
            "an unset BIFFO_ENVIRONMENT must fail safe -- the guarded seed must "
            f"NOT apply, but found rows: {notes}"
        )

    def test_environment_staging_seeds_nothing(
        self, guarded_seed_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        key = uuid.uuid4().hex[:8]
        table = f"guarded_seed_{key}"
        import_name = f"guard_staging_{key}"
        _write_guarded_module(guarded_seed_env["imports_root"], import_name, table, "staging-run")

        monkeypatch.setenv("BIFFO_ENVIRONMENT", "staging")

        from src.api.main import _run_ddl_import

        result = _run_ddl_import(import_name)
        assert result["applied"] == ["000_guarded_seed.sql"]

        notes = asyncio.run(_fetch_notes(guarded_seed_env["database_url"], table))
        assert notes == [], f"staging must NOT apply a dev-guarded seed, but found rows: {notes}"

    def test_environment_dev_seeds(
        self, guarded_seed_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        key = uuid.uuid4().hex[:8]
        table = f"guarded_seed_{key}"
        import_name = f"guard_dev_{key}"
        _write_guarded_module(guarded_seed_env["imports_root"], import_name, table, "dev-run")

        monkeypatch.setenv("BIFFO_ENVIRONMENT", "dev")

        from src.api.main import _run_ddl_import

        result = _run_ddl_import(import_name)
        assert result["applied"] == ["000_guarded_seed.sql"]

        notes = asyncio.run(_fetch_notes(guarded_seed_env["database_url"], table))
        assert notes == ["dev-run"], f"dev must apply the guarded seed exactly once, got: {notes}"
