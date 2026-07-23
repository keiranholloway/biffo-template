"""Thread-of-runs: assembling a thread's conversation history (ADR-0016 §2).

``AgentRun`` is a regular ORM table (public schema), so the fixture is plain
in-memory SQLite — no schema attach. Rows are seeded with explicit ``created_at``
so ordering is deterministic (the id tiebreaker is a random UUID).
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from api.agent_runs import thread_messages
from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.agent_run import AgentRun
from api.models.base import Base
from api.routers import internal_agents
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool


def _msgs(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    return [{"role": role, "content": content} for role, content in pairs]


def _run(
    thread_id: str, at: int, messages: list[dict[str, str]], *, tenant_id: str = "default"
) -> AgentRun:
    return AgentRun(
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        agent_name="ideation",
        status="completed",
        thread_id=thread_id,
        messages=messages,
        created_at=datetime(2026, 1, 1, 0, 0, at, tzinfo=UTC),
    )


def _rows() -> list[AgentRun]:
    """Fresh ORM instances each call — one instance can't be added to two
    sessions, and each test seeds its own."""
    return [
        # thread t1, turn 1 — system/tool noise that must NOT appear in history
        _run(
            "t1",
            1,
            _msgs(
                ("system", "sys"),
                ("user", "idea one"),
                ("assistant", "reply one"),
                ("tool", "{}"),
            ),
        ),
        # thread t1, turn 2 (later)
        _run("t1", 2, _msgs(("user", "idea two"), ("assistant", "reply two"))),
        # a different thread
        _run("t2", 1, _msgs(("user", "other thread"), ("assistant", "other reply"))),
        # another tenant, SAME thread id — must be invisible
        _run("t1", 1, _msgs(("user", "leak?"), ("assistant", "no")), tenant_id="tenant-b"),
    ]


async def _seeded[T](fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            session.add_all(_rows())
            await session.commit()
        async with factory() as session:
            return await fn(session)
    finally:
        await engine.dispose()


class TestAssembly:
    def test_orders_user_and_assistant_history_oldest_first(self) -> None:
        history = asyncio.run(
            _seeded(lambda s: thread_messages(s, tenant_id="default", thread_id="t1"))
        )
        # system/tool excluded; both turns, in chronological order.
        assert [(m["role"], m["content"]) for m in history] == [
            ("user", "idea one"),
            ("assistant", "reply one"),
            ("user", "idea two"),
            ("assistant", "reply two"),
        ]

    def test_scopes_to_the_thread_and_tenant(self) -> None:
        other = asyncio.run(
            _seeded(lambda s: thread_messages(s, tenant_id="default", thread_id="t2"))
        )
        assert [m["content"] for m in other] == ["other thread", "other reply"]
        # The same thread id in another tenant does not leak in.
        assert all(m["content"] != "leak?" for m in other)

    def test_unknown_thread_is_an_empty_conversation(self) -> None:
        assert (
            asyncio.run(
                _seeded(lambda s: thread_messages(s, tenant_id="default", thread_id="nope"))
            )
            == []
        )


def _app(factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def override_get_db() -> Any:
        async with factory() as session:
            yield session

    app = FastAPI()
    app.include_router(internal_agents.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/test-agent-runtime/session"
    )
    return app


class TestEndpoint:
    def test_reads_a_threads_history(self) -> None:
        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )

        async def _seed() -> None:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as session:
                session.add_all(_rows())
                await session.commit()

        asyncio.run(_seed())
        client = TestClient(_app(async_sessionmaker(engine, expire_on_commit=False)))

        resp = client.get("/api/v1/internal/agent-runs/threads/t1/messages")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["thread_id"] == "t1"
        assert [m["content"] for m in body["messages"]] == [
            "idea one",
            "reply one",
            "idea two",
            "reply two",
        ]

        # A first turn has no prior runs — an unknown thread is 200 + empty, not 404.
        empty = client.get("/api/v1/internal/agent-runs/threads/brand-new/messages")
        assert empty.status_code == 200
        assert empty.json() == {"thread_id": "brand-new", "messages": []}

        asyncio.run(engine.dispose())
