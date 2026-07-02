"""Regression test for main.py's _run_db_init(): a deployed Lambda extracts
its zip to /var/task read-only, but generating a plugin migration file
means writing into script_location's versions/ directory
(plugin_migrations.generate_migration_for_plugin). This first surfaced as a
real OSError ("[Errno 30] Read-only file system") in the tabsii-platform dev
deploy, the first time a plugin manifest (services/rbac/biffo.plugin.json)
was actually discoverable at runtime -- see the deploy-app.yml/plugins.py
bundling fix this commit ships alongside. Before that fix,
discover_plugin_manifests() always returned [] in a deployed Lambda, so this
code path was never exercised there.

This test doesn't need to actually mark a directory read-only to prove the
fix: it calls the real _run_db_init() against the real repo's
services/api/migrations/ (writable in this test sandbox, same as it would
be in local dev/CI) and asserts the bundled versions/ directory is never
written to -- generation happens entirely in a redirected, writable copy.
That's the property that matters: in a deployed Lambda, writing into the
bundled versions/ raises OSError; in every other context it merely would
have succeeded silently, which is exactly why this bug shipped unnoticed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa

_SERVICES_API_DIR = Path(__file__).resolve().parent.parent
_BUNDLED_VERSIONS_DIR = _SERVICES_API_DIR / "migrations" / "versions"


def _table_names(db_path: Path) -> set[str]:
    engine = sa.create_engine(f"sqlite:///{db_path}")
    try:
        return set(sa.inspect(engine).get_table_names())
    finally:
        engine.dispose()


@pytest.fixture
def db_init_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Real _run_db_init(), pointed at a throwaway SQLite DB and a
    throwaway services/ root containing one plugin manifest -- chdir'd to
    the real services/api/ so alembic.ini/env.py resolve exactly as they do
    in production (same reasoning as test_plugin_migrations_integration.py's
    alembic_setup fixture)."""
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("BIFFO_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings,
            "database_url",
            f"sqlite+aiosqlite:///{db_path}",
        )

    services_root = tmp_path / "services"
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

    monkeypatch.chdir(_SERVICES_API_DIR)
    return {"db_path": db_path}


class TestRunDbInitDoesNotWriteBundledVersionsDir:
    def test_generates_and_applies_plugin_migration_without_touching_bundled_versions(
        self, db_init_env: dict[str, Any]
    ) -> None:
        before = set(_BUNDLED_VERSIONS_DIR.iterdir())

        from src.api.main import _run_db_init

        result = _run_db_init()

        assert result == {"ok": True}
        assert "widgets" in _table_names(db_init_env["db_path"])

        # The bundled versions/ directory -- read-only in a deployed Lambda
        # -- must be byte-for-byte untouched. Generation happened in a
        # redirected writable copy instead.
        after = set(_BUNDLED_VERSIONS_DIR.iterdir())
        assert before == after

    def test_idempotent_rerun_does_not_duplicate_or_error(
        self, db_init_env: dict[str, Any]
    ) -> None:
        from src.api.main import _run_db_init

        assert _run_db_init() == {"ok": True}
        assert _run_db_init() == {"ok": True}
        assert "widgets" in _table_names(db_init_env["db_path"])
