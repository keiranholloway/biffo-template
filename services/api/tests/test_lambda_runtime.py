"""Regression tests for the two Lambda-runtime fixes in issue #180.

Both encode the same underlying constraint: the Lambda container is long-lived
but the asyncio event loop is not, and an asyncpg connection is bound to the
loop it was opened on.

1. `database.py` must not retain an application-side connection pool. A pooled
   connection outlives the loop it was created on and then raises
   `RuntimeError: <Future ...> attached to a different loop` on the next
   invocation that draws it -- the intermittent ~50% 500s on every DB-touching
   endpoint. Pooling is RDS Proxy's job in this architecture.
2. `main.py` must reuse one event loop per warm container rather than building a
   fresh one per HTTP invocation (which leaked a loop and its selector fd each
   time), while still repairing the current-loop-is-None state that
   `asyncio.run()` leaves behind in _run_db_init/_run_ddl_import.
"""

from __future__ import annotations

import asyncio
import warnings
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.pool import NullPool


def _installed_loop() -> asyncio.AbstractEventLoop | None:
    """The loop currently installed on this thread, without creating one.

    asyncio exposes no non-deprecated read-only accessor for this (
    asyncio.get_event_loop() would create a loop, hiding exactly the None state
    these tests assert on), so go through the policy and silence the 3.16
    deprecation locally rather than at suite level.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        policy = asyncio.get_event_loop_policy()
        try:
            return policy.get_event_loop()
        except RuntimeError:
            return None


class TestEngineUsesNullPool:
    def test_engine_has_no_retained_connection_pool(self) -> None:
        """Assert the engine's actual pool implementation, not the kwargs it was
        built with -- NullPool is what makes 'no connection outlives the
        invocation that opened it' true."""
        from src.api.database import engine

        assert isinstance(engine.pool, NullPool)

    def test_sessions_inherit_the_unpooled_engine(self) -> None:
        """Every request-scoped session comes from AsyncSessionLocal, so it is
        that binding -- not the module-level `engine` name alone -- that has to
        be unpooled."""
        from src.api.database import AsyncSessionLocal

        bind = AsyncSessionLocal.kw["bind"]
        assert isinstance(bind.pool, NullPool)


class TestEventLoopReuse:
    @pytest.fixture(autouse=True)
    def _isolate_module_loop(self) -> Any:
        """Save/restore both main's cached loop and the thread's current loop so
        these tests don't leak a loop into the rest of the suite."""
        from src.api import main

        saved_module_loop = main._event_loop
        saved_current = _installed_loop()
        main._event_loop = None
        yield
        if main._event_loop is not None and main._event_loop is not saved_module_loop:
            main._event_loop.close()
        main._event_loop = saved_module_loop
        asyncio.set_event_loop(saved_current)

    def test_repeated_calls_return_the_same_loop(self) -> None:
        """The core of the fix: a warm container gets one loop, not one per
        invocation."""
        from src.api.main import _ensure_event_loop

        first = _ensure_event_loop()
        second = _ensure_event_loop()
        third = _ensure_event_loop()

        assert first is second is third
        assert not first.is_closed()

    def test_the_loop_is_installed_as_the_current_loop(self) -> None:
        """Mangum reaches for asyncio.get_event_loop(); the reused loop has to
        actually be the thread's current one."""
        from src.api.main import _ensure_event_loop

        loop = _ensure_event_loop()

        assert _installed_loop() is loop

    def test_reinstalls_the_same_loop_after_asyncio_run_clears_it(self) -> None:
        """asyncio.run() (alembic/asyncpg, _run_db_init, _run_ddl_import) sets
        the thread's current loop to None on exit. Repair that -- but by
        re-installing the existing loop, not by building a new one."""
        from src.api.main import _ensure_event_loop

        original = _ensure_event_loop()

        asyncio.run(asyncio.sleep(0))
        assert _installed_loop() is None

        restored = _ensure_event_loop()

        assert restored is original
        assert not original.is_closed()
        assert _installed_loop() is original

    def test_replaces_the_loop_only_once_it_has_been_closed(self) -> None:
        """Reuse must not mean handing back an unusable loop."""
        from src.api.main import _ensure_event_loop

        original = _ensure_event_loop()
        original.close()

        replacement = _ensure_event_loop()

        assert replacement is not original
        assert not replacement.is_closed()

    def test_http_invocations_do_not_create_a_loop_each_time(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """End-to-end through lambda_handler: the leak this fixes was one fresh
        loop (and selector fd) per HTTP invocation."""
        from src.api import main

        seen: list[asyncio.AbstractEventLoop | None] = []

        def fake_handler(event: dict, context: Any) -> dict:
            seen.append(_installed_loop())
            return {"statusCode": 200}

        monkeypatch.setattr(main, "handler", fake_handler)
        context = SimpleNamespace(
            function_name="api",
            memory_limit_in_mb=512,
            invoked_function_arn="arn:aws:lambda:eu-west-2:123456789012:function:api",
            aws_request_id="req-1",
        )

        for _ in range(3):
            assert main.lambda_handler({"rawPath": "/api/v1/health"}, context) == {  # type: ignore[arg-type]
                "statusCode": 200
            }

        assert len(seen) == 3
        assert seen[0] is seen[1] is seen[2]
