"""Guard for the repo-root `conftest.py` fixture (biffo-template#1565,
symptom 3): a caplog assertion in one test silently captures nothing because
an *earlier* test or import in a much larger suite left a `logging.Logger`
disabled or non-propagating -- passes when the affected plugin's own two
test directories run alone, fails once vendored into an instance's full
~2,800-test suite, and the difference is purely test order.

This does not hand-copy the fixture's logic into a second implementation to
test against (the drift `AGENTS.md` calls out repeatedly: `_extract_detail`
written twice, a rule reconstructed rather than captured live). It runs
pytest's own `pytester` plugin -- the standard way to test a conftest.py's
actual behaviour -- against a throwaway two-file project, first copying in
the REAL root `conftest.py` bytes from this checkout, so the guard exercises
whatever actually ships rather than a restatement of it that could go stale.

Two independent mechanisms are reproduced, matching the two named in the
root conftest's own docstring:

1. `logger.disabled = True`, via `logging.config.fileConfig()`'s own
   default (`disable_existing_loggers=True`) -- the general shape of the
   defect #1581 fixed for one call site (Alembic's `env.py`). Measured
   live, without the root conftest's fixture, this reliably empties a
   later test's `caplog.records`.
2. `logger.propagate = False`, via
   `aws_lambda_powertools.logging.utils.copy_config_to_registered_loggers`
   -- real, public Powertools API, not hypothetical misuse. Measured live,
   this one does NOT currently break `caplog` even without the root
   fixture, because pytest's own `_pytest/logging.py::catching_logs`
   already re-attaches its capture handler to any logger it finds with
   `propagate=False` at test setup. It is included here anyway so the
   guard demonstrates the root fixture is harmless to that already-covered
   path, not just untested against it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest_plugins = ["pytester"]


def _repo_root() -> Path:
    """Walk up from this file to the directory holding the real root
    conftest.py -- located structurally (via core-manifest.json, which is
    only ever at the repo root) rather than by a hardcoded parents[N]
    depth, so this keeps working if this test file ever moves."""
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / "core-manifest.json").is_file():
            return candidate
    raise RuntimeError("could not locate repo root from " + str(here))


_CONTAMINATION_TEST = '''
import logging


def test_a_disables_an_unrelated_logger_via_fileconfig_default(tmp_path):
    """Mirrors #1581's original shape but at a DIFFERENT call site, to prove
    the class rather than re-check the one site already fixed there: any
    fileConfig() call anywhere in a large suite, using the stdlib's own
    default, disables a logger it does not own."""
    from logging.config import fileConfig

    logging.getLogger("victim_disabled")  # registered before fileConfig runs
    ini_path = tmp_path / "logging.ini"
    ini_path.write_text(
        "[loggers]\\nkeys=root\\n\\n"
        "[handlers]\\nkeys=console\\n\\n"
        "[formatters]\\nkeys=simple\\n\\n"
        "[logger_root]\\nlevel=WARNING\\nhandlers=console\\n\\n"
        "[handler_console]\\nclass=StreamHandler\\nlevel=WARNING\\n"
        "formatter=simple\\nargs=(sys.stderr,)\\n\\n"
        "[formatter_simple]\\nformat=%(message)s\\n"
    )
    fileConfig(str(ini_path))  # disable_existing_loggers defaults to True


def test_b_disables_propagation_via_the_real_powertools_utility():
    """aws_lambda_powertools.logging.utils.copy_config_to_registered_loggers
    is real, documented Powertools API for unifying third-party logger
    output under one formatter -- idiomatic usage, not a bug."""
    from aws_lambda_powertools import Logger
    from aws_lambda_powertools.logging.utils import copy_config_to_registered_loggers

    logging.getLogger("victim_propagate")  # registered before the copy call
    source = Logger(service="some_earlier_service_1565")
    copy_config_to_registered_loggers(source_logger=source)
'''

_VICTIM_TEST = """
import logging


def test_victim_disabled_caplog(caplog):
    caplog.set_level(logging.WARNING)
    logger = logging.getLogger("victim_disabled")
    logger.warning("disabled-victim message")
    messages = [r.message for r in caplog.records]
    assert any("disabled-victim message" in m for m in messages), (
        f"disabled={logger.disabled} propagate={logger.propagate} records={messages}"
    )


def test_victim_propagate_caplog(caplog):
    caplog.set_level(logging.WARNING)
    logger = logging.getLogger("victim_propagate")
    logger.warning("propagate-victim message")
    messages = [r.message for r in caplog.records]
    assert any("propagate-victim message" in m for m in messages), (
        f"disabled={logger.disabled} propagate={logger.propagate} records={messages}"
    )
"""


@pytest.fixture
def _project(pytester: pytest.Pytester) -> pytest.Pytester:
    pytester.makepyfile(
        test_1_contaminate=_CONTAMINATION_TEST,
        test_2_victim=_VICTIM_TEST,
    )
    return pytester


class TestRootConftestGuardsCaplogAgainstEarlierTestOrder:
    def test_a_without_the_root_conftest_the_disabled_victim_fails(
        self, _project: pytest.Pytester
    ) -> None:
        """Fail-first evidence: the hazard is real, not a theory. No
        conftest.py at all is present in this throwaway project, so nothing
        resets logger state between test_1_contaminate and test_2_victim --
        exactly the shape of a plugin's own two test directories running as
        part of an instance's much larger, differently-ordered suite."""
        result = _project.runpytest_subprocess()

        # The disabled-logger victim must fail (this is the real, currently
        # unguarded hazard). The propagate victim is expected to pass even
        # here, because pytest's own catching_logs already defends that one
        # -- asserting that keeps this test honest about which mechanism is
        # actually closed by the fixture under test.
        result.assert_outcomes(passed=3, failed=1)
        result.stdout.fnmatch_lines(["FAILED test_2_victim.py::test_victim_disabled_caplog*"])

    def test_b_with_the_real_root_conftest_both_victims_pass(
        self, _project: pytest.Pytester
    ) -> None:
        """Same two files, unchanged, plus the actual conftest.py this repo
        ships at its root (copied verbatim from disk, not retyped) -- proves
        the fix that exists is the fix that was tested."""
        real_conftest = (_repo_root() / "conftest.py").read_text()
        _project.makepyfile(conftest=real_conftest)

        result = _project.runpytest_subprocess()

        result.assert_outcomes(passed=4, failed=0)
