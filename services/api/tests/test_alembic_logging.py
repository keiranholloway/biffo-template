"""Guard for the fixed defect: `migrations/env.py` used to call
`fileConfig(config.config_file_name)` with no `disable_existing_loggers`
argument, which defaults to True. `logging.config.fileConfig` does not merely
leave an unlisted logger alone in that mode -- it sets `.disabled = True` on
every logger that already exists and is not named in alembic.ini's [loggers]
section (root, sqlalchemy, alembic only). A disabled logger emits nothing,
regardless of level, handlers, or propagation.

The practical effect: anything that runs Alembic in-process (a Lambda
db-init, a test fixture) silently switches off logging for every module
already imported, for the rest of the process -- a seeding warning, an error
path, a diagnostic, gone with no indication anything changed.

This is deliberately a behavioural test, not a spelling one -- it does not
assert that env.py passes a particular keyword argument. It asserts the
actual property: a logger that exists BEFORE Alembic's own logging
configuration runs must still emit AFTER. That fails against the old
`fileConfig(config.config_file_name)` call and passes once it stops
disabling loggers it does not own.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

_SERVICES_API_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture
def alembic_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A real Alembic Config running the repo's actual migrations against a
    throwaway SQLite file DB -- same chdir/env-var reasoning as
    test_plugin_migrations_integration.py's fixture of the same name, so
    alembic.ini/env.py resolve exactly as they do when the real Lambda's
    `_run_db_init` runs `Config("alembic.ini")`."""
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("BIFFO_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings,
            "database_url",
            f"sqlite+aiosqlite:///{db_path}",
        )
    monkeypatch.chdir(_SERVICES_API_DIR)
    return Config("alembic.ini")


class _CapturingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record.getMessage())


class TestAlembicEnvDoesNotDisableExistingLoggers:
    def test_a_pre_existing_logger_still_emits_after_alembic_runs(
        self, alembic_setup: Config
    ) -> None:
        """The property, not the spelling. `some_third_party_module` is not
        named in alembic.ini's [loggers] section -- exactly the class of
        logger that `disable_existing_loggers=True` (fileConfig's default)
        silently disables. Before this fix, running a real `alembic upgrade`
        (which env.py drives via fileConfig) left this logger `.disabled`
        with zero records captured; the fix keeps it live."""
        probe = logging.getLogger("some_third_party_module")
        probe.setLevel(logging.DEBUG)
        probe.disabled = False
        handler = _CapturingHandler()
        probe.addHandler(handler)
        try:
            probe.error("captured before alembic ever runs")
            assert handler.records == ["captured before alembic ever runs"]
            handler.records.clear()

            # Drives the real env.py, exactly as `_run_db_init` does in
            # production -- this is what calls fileConfig(...) on alembic.ini.
            command.upgrade(alembic_setup, "head")

            assert probe.disabled is False, (
                "alembic's fileConfig() disabled a logger it does not own -- "
                "disable_existing_loggers must be False in migrations/env.py"
            )
            probe.error("captured after alembic has run")
            assert handler.records == ["captured after alembic has run"], (
                "logger emitted nothing after Alembic ran -- fileConfig's "
                "disable_existing_loggers default silently disabled it"
            )
        finally:
            probe.removeHandler(handler)

    def test_alembic_configured_loggers_still_get_their_own_settings(
        self, alembic_setup: Config
    ) -> None:
        """disable_existing_loggers=False must not stop alembic.ini's own
        [loggers] from being applied -- only the reach outside them changes.
        sqlalchemy.engine is explicitly configured to WARN in alembic.ini."""
        command.upgrade(alembic_setup, "head")

        assert logging.getLogger("sqlalchemy.engine").level == logging.WARNING
        assert not logging.getLogger("sqlalchemy.engine").disabled
