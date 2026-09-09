"""SnapStart's afterRestore hook (#2003).

`services/api/src/api/database.py` builds `engine`/`AsyncSessionLocal` once, at
import time, as module-level singletons. SnapStart freezes exactly that INIT
phase into a snapshot and resumes the identical objects on every future
restore of it -- however stale the credential or endpoint
`resolve_app_database_url()` returned has become by the time a given restore
actually happens (possibly long after the snapshot was taken, and across many
separate restores of it), and with no hook to re-derive anything. `main.py`
carried no restore decorator at all.

These tests pin three things: (1) rebuilding replaces the module singletons
with fresh objects rather than mutating the old ones in place, (2) a failed
warm-up connection (DB briefly unreachable, mid-rotation credential, ...)
never raises out of the restore path, and (3) the hook only ever registers
when the Lambda-injected `snapshot_restore_py` module is actually present --
absent everywhere except a real SnapStart-enabled function version -- so
this must be a no-op under pytest, `sam local`, and any instance that has not
turned SnapStart on.
"""

from __future__ import annotations

import sys
import types

import pytest
from api import database, main
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.asyncio
async def test_prime_connection_runs_a_query_against_a_reachable_engine() -> None:
    """The happy path, isolated from the swallow-on-failure behaviour below:
    against an engine that *can* connect, the warm-up genuinely executes."""
    probe = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await database._prime_connection(probe)  # must not raise
    finally:
        await probe.dispose()


def test_rebuild_engine_after_restore_replaces_the_module_singletons(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rebuilding must swap in new `engine`/`AsyncSessionLocal` objects --
    reusing the old ones in place would still be resuming whatever import
    time captured, just under a name that looks re-derived.

    The replacement engine points at an address nothing listens on
    (127.0.0.1, a port too low to be a real service), so the warm-up
    connection is guaranteed to fail here, deterministically, rather than
    depending on whether this environment happens to have a reachable
    Postgres at the default `settings.database_url`. That failure must not
    propagate -- see the next test for the same assertion in isolation.
    """
    original_engine = database.engine
    original_sessionmaker = database.AsyncSessionLocal

    def _build_unreachable_engine() -> object:
        return create_async_engine(
            "postgresql+asyncpg://127.0.0.1:1/does-not-exist", hide_parameters=True
        )

    monkeypatch.setattr(database, "_build_engine", _build_unreachable_engine)
    try:
        database.rebuild_engine_after_restore()  # must not raise
        assert database.engine is not original_engine
        assert database.AsyncSessionLocal is not original_sessionmaker
    finally:
        database.engine = original_engine
        database.AsyncSessionLocal = original_sessionmaker


def test_rebuild_engine_after_restore_swallows_a_warmup_failure(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The specific failure mode named in the docstring: a warm-up connection
    that cannot be established must never fail the restore itself. The next
    real request falls back to opening its own connection, same as today."""

    async def _always_fails(_engine: object) -> None:
        raise ConnectionRefusedError("simulated: DB unreachable at restore time")

    monkeypatch.setattr(database, "_prime_connection", _always_fails)

    original_engine = database.engine
    original_sessionmaker = database.AsyncSessionLocal
    try:
        database.rebuild_engine_after_restore()  # must not raise
        assert database.engine is not original_engine
    finally:
        database.engine = original_engine
        database.AsyncSessionLocal = original_sessionmaker


def test_register_snapstart_restore_hook_is_a_noop_without_the_runtime_module() -> None:
    """`snapshot_restore_py` is injected by the Lambda Python runtime only for
    a function version with SnapStart applied. It genuinely does not exist in
    this dev/test environment -- confirmed by the assertion below rather than
    assumed -- so calling the registrar here exercises the real ImportError
    path, not a simulated one."""
    assert "snapshot_restore_py" not in sys.modules
    with pytest.raises(ImportError):
        import snapshot_restore_py  # noqa: F401  # pyright: ignore[reportMissingImports]

    main._register_snapstart_restore_hook()  # must not raise


def test_register_snapstart_restore_hook_registers_the_rebuild_function(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the runtime module *is* present (simulating an actual SnapStart-
    enabled restore), the hook must register exactly
    `database.rebuild_engine_after_restore` -- not a wrapper, not a copy --
    so a real restore event ends up calling the function these other tests
    pin the behaviour of."""
    registered: list[object] = []
    fake_module = types.ModuleType("snapshot_restore_py")
    fake_module.register_after_restore = registered.append  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "snapshot_restore_py", fake_module)

    main._register_snapstart_restore_hook()

    assert registered == [database.rebuild_engine_after_restore]
