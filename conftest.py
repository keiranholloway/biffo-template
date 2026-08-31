"""Repo-root pytest configuration.

Template-owned (see `core-manifest.json`) and delivered to every instance via
`biffo core upgrade`. This file is an ancestor of every directory under
`[tool.pytest.ini_options].testpaths` (`services/`, `packages/`), so pytest
loads it -- and applies its autouse fixtures -- to every test collected
anywhere in the tree, including a vendored plugin's own tests
(`services/<plugin>/tests/`), with no action required from that plugin.

## The hazard this guards (biffo-template#1565, symptom 3)

Four tests belonging to vendored plugins (idea-scout, ideation) assert on
captured log output and pass when their own two test directories run alone,
but failed when the instance's full ~2,800-test suite ran them among
everything else -- an ordering hazard, not a content bug: identical code,
identical assertion, different verdict depending on what ran earlier in the
same process.

Two distinct stdlib/library mechanisms can produce exactly this shape by
mutating a `logging.Logger` that already exists, and a fix for one does not
close the other:

1. **`logger.disabled = True`.** `logging.config.fileConfig(...)` defaults
   to `disable_existing_loggers=True`, which sets `.disabled = True` on
   every logger that already exists and is not named in the ini file's own
   `[loggers]` section. A disabled logger emits nothing at all --
   `Logger.handle()` returns before handlers or propagation are even
   considered -- regardless of level, handlers, or `.propagate`.
   `services/api/migrations/env.py` used to call `fileConfig()` this way
   (Alembic's own default); fixed in #1581 to pass
   `disable_existing_loggers=False`, guarded there by
   `test_alembic_logging.py`. That fix is real, and it is scoped to
   Alembic's one call site -- it says nothing about any other code, present
   or future (a different migration runner, a plugin's own startup, a
   third-party library), that reaches for `fileConfig()`'s default and
   disables a logger it does not own. **Confirmed live**: a fresh,
   unrelated logger disabled this way, in a test that has nothing to do
   with Alembic, silently empties a later test's `caplog.records` --
   `disabled=True propagate=True records=[]` -- even though pytest's own
   capture handler is attached and the message was genuinely logged.

2. **`logger.propagate = False`.** `aws_lambda_powertools.logging.utils.
   copy_config_to_registered_loggers` -- real, public, documented Powertools
   API for unifying third-party logger output (e.g. boto3/urllib3) under one
   formatter -- walks every currently-registered top-level logger and sets
   `.propagate = False`. Nothing in this repo calls it today, but it is
   ordinary, idiomatic Powertools usage, not a mistake, and the issue's
   original report named `Logger()` construction as the suspect. **Measured
   directly against pytest 9.1.1 in this repo's own `.venv`**: pytest's own
   `_pytest/logging.py::catching_logs.__enter__` already re-scans
   `logging.Logger.manager.loggerDict` on every test's setup and attaches
   its capture handler directly to any logger it finds with
   `propagate=False` at that point -- specifically to defend against this
   exact class. So a logger that became non-propagating *before* the
   current test started (the shape this issue describes -- an earlier test
   or import touched it) is already covered by pytest itself, confirmed by
   reproducing the `copy_config_to_registered_loggers` path directly: the
   later test's `caplog` still captured the message. Pytest's own comment
   names the one gap it deliberately leaves: "will miss loggers that
   *become* non-propagating after `__enter__`" -- i.e. a mutation that
   happens *during* the very test asserting on `caplog`, after its own
   setup already ran. Resetting `.propagate` here does not duplicate
   pytest's defence; it removes the residual gap pytest names outright, at
   the point where doing so is cheap and total rather than best-effort.

Both are the same underlying property failing: **caplog depends on every
logger between the one under test and root staying `propagate=True` and
`disabled=False` for the life of the whole test process**, and nothing
enforces that per-test. Fixing one call site (as #1581 did) closes one
instance of the class; it does not make the class impossible, because
`logging.Logger.manager.loggerDict` keeps every named logger alive for the
rest of the process (Python never releases one), so whatever an earlier
test or import left behind stays behind for every test that runs after it.

## The fix: restore the invariant before every test, not detect its absence

This is fix-hierarchy level 1 (impossible), not level 4 (detect): rather than
asserting the invariant holds and failing loudly when it does not, the
autouse fixture below makes the starting condition of every test the same
regardless of what ran before it, so there is no absence to detect. It does
not restore whatever a test leaves behind afterwards -- nothing in this tree
has a legitimate reason to want `propagate=False` or `disabled=True` as an
*ending* state (every existing reference to either attribute in this repo
is a guard test asserting they are NOT set), so there is no prior state
worth preserving, and every test starts from the identical clean invariant.

Guarded by `services/api/tests/test_root_conftest_caplog_guard.py`, which
uses pytest's own `pytester` plugin to run a throwaway two-test project
first *without* this fixture (asserting it fails, for the same reason
measured above) and then *with* the real fixture defined here (asserting it
passes) -- so the guard exercises this exact file's content, not a
hand-copied restatement of it.
"""

from __future__ import annotations

import logging

import pytest


@pytest.fixture(autouse=True)
def _reset_logger_propagation() -> None:
    """Force every currently-registered logger back to a clean
    `propagate=True, disabled=False` state before each test runs.

    `logging.Logger.manager.loggerDict` also holds `logging.PlaceHolder`
    entries -- a name referenced only as an ancestor (e.g. `"a.b"` gets a
    placeholder the moment something calls `logging.getLogger("a.b.c")`,
    before anything ever calls `logging.getLogger("a.b")` itself) -- which
    carry neither attribute and are not real loggers, so they're skipped.
    """
    for name in list(logging.Logger.manager.loggerDict):
        candidate = logging.Logger.manager.loggerDict[name]
        if isinstance(candidate, logging.PlaceHolder):
            continue
        candidate.propagate = True
        candidate.disabled = False
    # The root logger itself isn't in loggerDict and has no `.propagate`
    # (no parent to propagate to), but `fileConfig(disable_existing_loggers=
    # True)` can still disable it if a caller's ini file omits "root" from
    # its own `[loggers]` section -- cheap to cover explicitly.
    logging.getLogger().disabled = False
