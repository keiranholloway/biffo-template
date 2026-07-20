"""Regression tests for main.py's _run_db_init().

Plugin table migrations are generated and committed at CLI time now (`biffo
plugin install`/`upgrade`/`sync-migrations`, via
services/api/scripts/generate_plugin_migrations.py) -- not here. _run_db_init
used to also copy the bundled versions/ directory into a writable /tmp copy
and dynamically generate any missing plugin migration there before
upgrading, but that ran on every single Lambda invocation against a
directory wiped clean each time, so a generated migration's down_revision
was silently recomputed on every deploy and never actually persisted --
corrupting the revision graph the moment a later real migration was added.
This first bit a real deployment (tabsii-platform dev): db-init kept
reporting {"ok": true} while a genuinely committed migration
(0002_create_ddl_import_history_table.py) silently never applied. See
plugin_migrations.sync_plugin_migrations's docstring and ADR-0003's
implementation note for the full incident.

These tests encode the corrected, much simpler contract: _run_db_init only
ever applies migrations that are already committed under
services/api/migrations/versions/ -- it never generates anything, and never
writes anywhere outside the database itself.
"""

from __future__ import annotations

import sys
import tempfile
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


@pytest.fixture
def db_init_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Real _run_db_init(), pointed at a throwaway SQLite DB -- chdir'd to the
    real services/api/ so alembic.ini/env.py resolve exactly as they do in
    production (same reasoning as test_plugin_migrations_integration.py's
    alembic_setup fixture)."""
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("BIFFO_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings,
            "database_url",
            f"sqlite+aiosqlite:///{db_path}",
        )
    monkeypatch.chdir(_SERVICES_API_DIR)
    return {"db_path": db_path}


class TestRunDbInitAppliesOnlyCommittedMigrations:
    def test_upgrades_to_head_using_the_real_committed_migrations(
        self, db_init_env: dict[str, Any]
    ) -> None:
        from src.api.main import _run_db_init

        result = _run_db_init()

        # app_role: _run_db_init now also bootstraps the least-privilege
        # biffo_app role (#253). That is a Postgres-only concern -- roles,
        # schemas and GRANT do not exist in the SQLite this suite runs on --
        # so it reports itself as a deliberate no-op here.
        assert result == {
            "ok": True,
            "app_role": {"bootstrapped": False, "reason": "not-postgres"},
        }
        # 0001_create_users_table.py, 0002_create_ddl_import_history_table.py --
        # both already committed in this repo; no plugin fixture needed since
        # _run_db_init no longer discovers or generates anything.
        table_names = _table_names(db_init_env["db_path"])
        assert "users" in table_names
        assert "ddl_import_history" in table_names

    def test_idempotent_rerun_does_not_duplicate_or_error(
        self, db_init_env: dict[str, Any]
    ) -> None:
        from src.api.main import _run_db_init

        noop = {
            "ok": True,
            "app_role": {"bootstrapped": False, "reason": "not-postgres"},
        }
        assert _run_db_init() == noop
        assert _run_db_init() == noop
        assert "users" in _table_names(db_init_env["db_path"])

    def test_never_writes_a_migrations_versions_copy_under_tmp(
        self, db_init_env: dict[str, Any]
    ) -> None:
        """Regression guard for the fixed bug: _run_db_init used to copy the
        bundled versions/ directory into Path(tempfile.gettempdir()) /
        "migrations_versions" on every call. That copy-and-redirect dance is
        gone entirely -- assert the directory it used to create never
        appears."""
        stale_tmp_copy = Path(tempfile.gettempdir()) / "migrations_versions"
        if stale_tmp_copy.exists():
            import shutil

            shutil.rmtree(stale_tmp_copy)

        from src.api.main import _run_db_init

        _run_db_init()

        assert not stale_tmp_copy.exists()

    def test_a_plugin_manifest_without_a_committed_migration_gets_no_table(
        self, db_init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Positively encodes the new contract: a plugin manifest discoverable
        under services_root but with no pre-generated/committed migration
        file does NOT get its table created by _run_db_init -- generation is
        strictly a CLI-time concern now, db-init only ever applies what's
        already committed."""
        import json

        services_root = db_init_env["db_path"].parent / "services"
        plugin_dir = services_root / "widgets"
        plugin_dir.mkdir(parents=True)
        (plugin_dir / "biffo.plugin.json").write_text(
            json.dumps(
                {
                    "name": "widgets",
                    "version": "1.0.0",
                    "tables": [
                        {
                            "name": "widgets",
                            "columns": [{"name": "label", "type": "String(100)"}],
                        }
                    ],
                }
            )
        )
        monkeypatch.setenv("BIFFO_PLUGIN_SERVICES_ROOT", str(services_root))
        if "src.api.config" in sys.modules:
            monkeypatch.setattr(
                sys.modules["src.api.config"].settings,
                "plugin_services_root",
                str(services_root),
            )

        from src.api.main import _run_db_init

        result = _run_db_init()

        # app_role: _run_db_init now also bootstraps the least-privilege
        # biffo_app role (#253). That is a Postgres-only concern -- roles,
        # schemas and GRANT do not exist in the SQLite this suite runs on --
        # so it reports itself as a deliberate no-op here.
        assert result == {
            "ok": True,
            "app_role": {"bootstrapped": False, "reason": "not-postgres"},
        }
        assert "widgets" not in _table_names(db_init_env["db_path"])
