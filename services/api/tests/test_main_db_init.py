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
    # Pin the DDL-import root to an empty directory, so these tests state the
    # assumption they have always silently relied on: this instance is
    # SINGLE-phase, its schema is complete once Alembic has run, and so
    # `_run_db_init` performs the generic-CRUD check itself rather than
    # deferring it to a DDL import (#1018).
    #
    # Pinned rather than left to the ambient default, because the default is
    # resolved from `settings` at call time and these tests would otherwise
    # depend on what an earlier test file left behind — which is exactly what
    # they did: running test_main_ddl_import.py first made three of them fail,
    # and running them first made all nine pass.
    empty_imports = tmp_path / "no-imports"
    empty_imports.mkdir()
    monkeypatch.setenv("BIFFO_DDL_IMPORT_ROOT", str(empty_imports))
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings, "ddl_import_root", str(empty_imports)
        )
    monkeypatch.chdir(_SERVICES_API_DIR)
    return {"db_path": db_path, "empty_imports": empty_imports}


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
        # crud_schema: _run_db_init now also asserts every generic-CRUD table's
        # real schema has the columns its model declares (#1018). No core table
        # opts in via __crud_permissions__ in the base template, so there is
        # nothing to check and it reports zero rather than skipping silently.
        assert result == {
            "ok": True,
            "app_role": {"bootstrapped": False, "reason": "not-postgres"},
            "crud_schema": {"checked": 0, "drift": []},
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
            "crud_schema": {"checked": 0, "drift": []},
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
        # crud_schema: _run_db_init now also asserts every generic-CRUD table's
        # real schema has the columns its model declares (#1018). No core table
        # opts in via __crud_permissions__ in the base template, so there is
        # nothing to check and it reports zero rather than skipping silently.
        assert result == {
            "ok": True,
            "app_role": {"bootstrapped": False, "reason": "not-postgres"},
            "crud_schema": {"checked": 0, "drift": []},
        }
        assert "widgets" not in _table_names(db_init_env["db_path"])


class TestCrudSchemaCheckRunsInTheLastSchemaPhase:
    """Where the generic-CRUD schema check happens, and why it moves (#1018).

    Alembic is not always the whole schema. An ADR-0005 instance creates most
    of its generic-CRUD tables from `db/imports/<name>/*.sql`, applied by
    `_run_ddl_import` in a LATER, separate Lambda invocation. Checking at the
    end of `_run_db_init` therefore compares the models against a deliberately
    half-built schema, reports every imported table as missing, and fails a
    deploy that should have passed — which is what happened to
    tabsii-platform, whose own #499 disabled the check entirely to get deploys
    moving again.
    """

    def test_defers_when_the_instance_ships_a_ddl_import(
        self, db_init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Patch the discovery function itself rather than the settings it reads.
        # This suite loads the API under two module identities (`api.*` from
        # some files, `src.api.*` from others), each with its own `settings`
        # singleton, so a fixture that patches one of them is a no-op when the
        # other is the one in play — which made an earlier version of this test
        # pass alone and fail in the full run. Patching the callee is identity-
        # agnostic and states exactly what the branch under test depends on.
        import src.api.ddl_import as ddl_import

        monkeypatch.setattr(ddl_import, "discover_ddl_import_dirs", lambda *_: ["widgets"])

        from src.api.main import _run_db_init

        result = _run_db_init()

        # Deferred, and says so — a deploy log that simply omitted the check
        # would be indistinguishable from the check silently not running.
        assert result["crud_schema"] == {"checked": 0, "deferred": "ddl-import"}

    def test_runs_here_when_there_is_no_ddl_import(
        self, db_init_env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The single-phase case, unchanged: Alembic is the whole schema, so
        this IS the last phase and the check belongs here."""
        import src.api.ddl_import as ddl_import

        monkeypatch.setattr(ddl_import, "discover_ddl_import_dirs", lambda *_: [])

        from src.api.main import _run_db_init

        result = _run_db_init()

        assert "deferred" not in result["crud_schema"]
