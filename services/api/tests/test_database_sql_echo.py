"""Bound SQL parameters must never reach the logs.

The engine was built with ``echo=settings.environment == "dev"``, and
SQLAlchemy's echo logs statements *with their bound parameters*. In a deployed
dev environment that wrote complete agent transcripts, agent result payloads,
founder-profile snapshots and ``owner_sub`` values into CloudWatch in clear text
— a far more widely readable place than the database those columns live in, and
one whose name gives no hint it holds user content.

Measured before the fix on a live dev account: 135 parameter-payload lines in a
single 48-hour sample, and the identical exposure in a second instance's
account. See biffo-platform#85.

These tests observe the failure the way it was found: by reading what the
``sqlalchemy.engine.Engine`` logger actually emits when a statement carrying a
sensitive value is executed. A test that only asserted the *flag* would pass
against a build where the flag no longer controls anything.
"""

import ast
import logging
from pathlib import Path

import pytest
from api.config import Settings
from api.database import engine
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


def test_sql_echo_is_off_by_default() -> None:
    """The flag is explicit and defaults off in every environment — including
    ``dev``, which is a *shared* deployment, not a laptop."""
    assert Settings().sql_echo is False
    assert Settings(environment="dev").sql_echo is False
    assert Settings(environment="prod").sql_echo is False


def test_the_request_path_engine_does_not_echo_and_hides_parameters() -> None:
    assert not engine.echo
    # AsyncEngine does not proxy hide_parameters; it lives on the sync engine.
    # Asserting it on the async wrapper raises AttributeError, which reads as a
    # failing test rather than a wrong assertion.
    assert engine.sync_engine.hide_parameters is True


@pytest.mark.asyncio
async def test_bound_parameters_are_not_logged_even_with_echo_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The defence that does not depend on nobody ever flipping the flag.

    ``hide_parameters`` is unconditional, so an operator who turns echo on to
    debug a slow query still gets the statement text — the part with diagnostic
    value — without the values, which are the part with the exposure.

    ``hide_parameters`` is taken from the shipped engine rather than hard-coded
    here, so this cannot pass by testing SQLAlchemy instead of Biffo.
    """
    secret = "founder-profile-should-never-appear"
    probe = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=True,
        hide_parameters=engine.sync_engine.hide_parameters,
    )
    try:
        with caplog.at_level(logging.INFO, logger="sqlalchemy.engine.Engine"):
            async with probe.connect() as conn:
                await conn.execute(text("SELECT :value"), {"value": secret})
    finally:
        await probe.dispose()

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "SELECT" in logged, "statement text should still be logged — that is the useful part"
    assert secret not in logged


def test_every_engine_in_the_service_hides_parameters() -> None:
    """Applied to the class of engines, not just the one that was reported.

    The reported leak was the request-path engine's echo. The *other* route —
    SQLAlchemy embedding bound values in ``StatementError`` messages — fires on
    any engine, echo or not, and a failing statement is precisely when someone
    reads and pastes the output.

    Fixing only the reported caller is a mistake this project has already made
    and recorded: a known trap was fixed for one workflow by name, and the next
    caller inherited the original bug. So this asserts on every
    ``create_async_engine`` call in the service instead of a list of files.

    ``db_app_role`` is the one that matters most: it runs ``CREATE ROLE …
    PASSWORD`` for the app role.

    **Test engines are excluded**, and that exclusion is not a convenience. A
    fixture engine is built per-test against in-memory SQLite and never touches
    a deployment's data or its log group, so requiring the flag there would be
    ceremony — and ceremony is what gets a guard relaxed wholesale later.

    The exclusion exists because this guard shipped without it and broke an
    instance. The template happens to keep every test under ``tests/`` at the
    service root, so scanning all of ``src/`` was indistinguishable from
    scanning production code *here*. An instance using a domain-driven layout
    (``src/api/domains/<domain>/tests/``) has fixture engines inside ``src/``,
    and the guard failed its CI on five of them. The bug was that this test
    encoded the template's own file layout as though it were a property of
    every Biffo service.
    """
    root = Path(__file__).resolve().parents[1]
    sources = [
        path
        for path in (*(root / "src").rglob("*.py"), *(root / "migrations").rglob("*.py"))
        # Matches a `tests` *directory component*, not a substring, so a
        # production module named e.g. `latest_run.py` is still scanned.
        if "tests" not in path.relative_to(root).parts
    ]

    missing: list[str] = []
    for path in sources:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = node.func.id if isinstance(node.func, ast.Name) else None
            if name not in {"create_async_engine", "create_engine"}:
                continue
            if not any(kw.arg == "hide_parameters" for kw in node.keywords):
                missing.append(f"{path.relative_to(root)}:{node.lineno}")

    assert missing == []

    # Guards the guard. `missing == []` is also what a scan of nothing returns,
    # so the exclusion above could be widened until this test asserted nothing
    # and still looked green. Naming the four engines it must reach makes that
    # failure loud instead: they are the files the fix was actually about.
    scanned = {str(path.relative_to(root)) for path in sources}
    assert {
        "src/api/database.py",
        "src/api/db_app_role.py",
        "src/api/main.py",
        "migrations/env.py",
    } <= scanned


@pytest.mark.parametrize(
    ("relative_path", "scanned"),
    [
        ("src/api/database.py", True),
        ("src/api/db_app_role.py", True),
        # The layout that broke biffo-platform: fixture engines nested inside
        # `src/`, which the template itself has no example of. Asserted on
        # synthetic paths precisely because this repo cannot demonstrate it —
        # a test that could only fail on someone else's layout is a test that
        # never runs here.
        ("src/api/domains/early_access/tests/test_public_router.py", False),
        ("src/api/domains/user_profile/tests/conftest.py", False),
        # Not a substring match: a production module whose name merely contains
        # "tests" must still be scanned.
        ("src/api/latest_runs.py", True),
        ("src/api/contests.py", True),
    ],
)
def test_the_engine_scan_skips_test_directories_without_skipping_production(
    relative_path: str, scanned: bool
) -> None:
    """The exclusion rule, checked independently of this repo's file tree."""
    parts = Path(relative_path).parts
    assert ("tests" not in parts) is scanned
