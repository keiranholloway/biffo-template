"""Tests for main.py's _run_ddl_import (ADR-0005).

_run_ddl_import constructs its own async engine from settings.database_url
read live at call time (mirroring migrations/env.py, not database.py's
module-level engine/AsyncSessionLocal singletons — see the function's own
docstring for why), which is what makes it possible to redirect at test time
the same way test_main_db_init.py's db_init_env fixture already does.

Known gap, not fillable here: when there is at least one new (not yet
applied) file, _run_ddl_import executes its raw SQL via
`conn.get_raw_connection().driver_connection` — the real asyncpg.Connection
API (`.transaction()`, `.execute()` with no bind params, for its
simple-query-protocol multi-statement support). sqlite's driver connection
(aiosqlite) has neither of those, so a "fresh file actually gets applied"
scenario cannot run against sqlite; it would fail with an AttributeError
before ever exercising real DDL semantics either way. What *can* and is
tested here without touching that code path: discovery/validation errors,
and the two states reachable purely through the read-phase (all files
already applied and unchanged -> all skipped; a changed already-applied file
-> hard error) by pre-seeding the bookkeeping table so `to_execute` stays
empty. The "fresh apply actually works, including PL/pgSQL/PostGIS/
session-scoped `SET search_path`" path requires the live smoke test against
a real dev deployment described in docs/ADR/0005-ddl-import-module.md.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa

_SERVICES_API_DIR = Path(__file__).resolve().parent.parent


def _table_names(db_path: Path) -> set[str]:
    engine = sa.create_engine(f"sqlite:///{db_path}")
    try:
        return set(sa.inspect(engine).get_table_names())
    finally:
        engine.dispose()


def _write_sql_file(import_dir: Path, filename: str, content: str = "SELECT 1;") -> Path:
    import_dir.mkdir(parents=True, exist_ok=True)
    path = import_dir / filename
    path.write_text(content)
    return path


@pytest.fixture
def ddl_import_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Real _run_ddl_import, pointed at a throwaway SQLite DB (schema created
    directly from Base.metadata, not via Alembic -- this test exercises
    _run_ddl_import's own logic, not the migration chain, which
    test_main_db_init.py already covers) and a throwaway db/imports/ root --
    chdir'd to the real services/api/ for consistency with the other
    main.py-level fixtures, even though _run_ddl_import itself has no
    alembic.ini/cwd dependency."""
    import asyncio

    from sqlalchemy.ext.asyncio import create_async_engine

    db_path = tmp_path / "test.db"
    database_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("BIFFO_DATABASE_URL", database_url)
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(sys.modules["src.api.config"].settings, "database_url", database_url)

    imports_root = tmp_path / "db" / "imports"
    monkeypatch.setenv("BIFFO_DDL_IMPORT_ROOT", str(imports_root))
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings, "ddl_import_root", str(imports_root)
        )

    async def _create_schema() -> None:
        from src.api.models.base import Base
        from src.api.models.ddl_import_history import DdlImportHistory  # noqa: F401
        from src.api.models.user import User  # noqa: F401

        engine = create_async_engine(database_url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        finally:
            await engine.dispose()

    asyncio.run(_create_schema())

    monkeypatch.chdir(_SERVICES_API_DIR)
    return {"db_path": db_path, "imports_root": imports_root}


async def _seed_applied(database_url: str, import_name: str, filename: str, checksum: str) -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from src.api.models.ddl_import_history import DdlImportHistory

    engine = create_async_engine(database_url)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            session.add(
                DdlImportHistory(import_name=import_name, filename=filename, checksum=checksum)
            )
            await session.commit()
    finally:
        await engine.dispose()


class TestRunDdlImportValidation:
    def test_missing_directory_raises_with_available_list(
        self, ddl_import_env: dict[str, Any]
    ) -> None:
        _write_sql_file(ddl_import_env["imports_root"] / "widgets", "000_widgets.sql")

        from src.api.main import _run_ddl_import

        with pytest.raises(ValueError, match="requires a 'directory'"):
            _run_ddl_import(None)

    def test_unknown_directory_raises_with_available_list(
        self, ddl_import_env: dict[str, Any]
    ) -> None:
        _write_sql_file(ddl_import_env["imports_root"] / "widgets", "000_widgets.sql")

        from src.api.main import _run_ddl_import

        with pytest.raises(ValueError, match="No .sql files found"):
            _run_ddl_import("does-not-exist")

    def test_empty_directory_raises(self, ddl_import_env: dict[str, Any]) -> None:
        (ddl_import_env["imports_root"] / "empty").mkdir(parents=True)

        from src.api.main import _run_ddl_import

        with pytest.raises(ValueError, match="No .sql files found"):
            _run_ddl_import("empty")


class TestRunDdlImportSkipsAlreadyApplied:
    def test_all_files_already_applied_and_unchanged_are_skipped(
        self, ddl_import_env: dict[str, Any]
    ) -> None:
        import asyncio

        content = "SELECT 1;"
        checksum = hashlib.sha256(content.encode("utf-8")).hexdigest()
        _write_sql_file(ddl_import_env["imports_root"] / "widgets", "000_widgets.sql", content)
        asyncio.run(
            _seed_applied(
                f"sqlite+aiosqlite:///{ddl_import_env['db_path']}",
                "widgets",
                "000_widgets.sql",
                checksum,
            )
        )

        from src.api.main import _run_ddl_import

        result = _run_ddl_import("widgets")
        # app_role: a DDL import can create new schemas/tables, so it re-runs
        # the biffo_app grants afterwards (#253). Postgres-only; a no-op here.
        assert result == {
            "ok": True,
            "applied": [],
            "skipped": ["000_widgets.sql"],
            "app_role": {"bootstrapped": False, "reason": "not-postgres"},
        }

    def test_changed_already_applied_file_raises_and_halts(
        self, ddl_import_env: dict[str, Any]
    ) -> None:
        import asyncio

        original_content = "SELECT 1;"
        original_checksum = hashlib.sha256(original_content.encode("utf-8")).hexdigest()
        # File on disk now has different content than what was recorded as applied.
        _write_sql_file(
            ddl_import_env["imports_root"] / "widgets",
            "000_widgets.sql",
            "SELECT 2; -- changed since it was applied",
        )
        _write_sql_file(ddl_import_env["imports_root"] / "widgets", "001_more.sql", "SELECT 3;")
        asyncio.run(
            _seed_applied(
                f"sqlite+aiosqlite:///{ddl_import_env['db_path']}",
                "widgets",
                "000_widgets.sql",
                original_checksum,
            )
        )

        from src.api.main import _run_ddl_import

        with pytest.raises(ValueError, match="has changed since it was applied"):
            _run_ddl_import("widgets")
