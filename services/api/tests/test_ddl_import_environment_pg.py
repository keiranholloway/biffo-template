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


pytestmark = pytest.mark.skipif(
    _pg_dsn() is None,
    reason='no real Postgres DSN -- eval "$(sh scripts/pg-test-db.sh --export)"',
)


@pytest.fixture
def guarded_seed_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Points `_run_ddl_import` at the real Postgres DSN and a throwaway
    db/imports root, mirroring `test_main_ddl_import.py`'s `ddl_import_env`
    fixture but against Postgres instead of sqlite — the one substitution
    that makes the guarded-SQL path reachable at all.

    Also clears `api.database.resolve_master_database_url`'s
    `@lru_cache(maxsize=1)` on both sides of the test. That cache is
    process-wide and keyed on nothing, so the first caller anywhere in a
    pytest session decides the URL for every caller after it — this repo had
    no `test_*_pg.py` file to expose that before this one, and without the
    clear, this fixture's real DSN survives into `test_main_ddl_import.py`'s
    sqlite-backed tests when both run in the same session, reporting
    `app_role: {"reason": "no-app-credential"}` where sqlite should report
    `"not-postgres"`. Scoped narrowly here rather than fixed at the source,
    which is a wider test-isolation change this PR does not otherwise touch.
    """
    database_url = _pg_dsn()
    assert database_url is not None  # narrows for pyright; skipif already checked

    from src.api.database import resolve_app_database_url, resolve_master_database_url

    resolve_master_database_url.cache_clear()
    resolve_app_database_url.cache_clear()

    monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(sys.modules["src.api.config"].settings, "database_url", database_url)

    imports_root = tmp_path / "db" / "imports"
    monkeypatch.setenv("BIFFO_DDL_IMPORT_ROOT", str(imports_root))
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings, "ddl_import_root", str(imports_root)
        )

    monkeypatch.chdir(_SERVICES_API_DIR)
    try:
        yield {"database_url": database_url, "imports_root": imports_root}
    finally:
        resolve_master_database_url.cache_clear()
        resolve_app_database_url.cache_clear()


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
