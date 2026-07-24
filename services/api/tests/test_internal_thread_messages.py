"""The internal thread-messages read endpoint
(GET /api/v1/internal/agent-runs/threads/{thread_id}/messages, ADR-0016 §2).

A module driving an async run over a chat it held on the synchronous spine (the
Ideation analyst) reads the thread's conversation here to hand it to that run.
``AgentRun`` is a plain public-schema table, so the fixture is in-memory SQLite;
rows are seeded with explicit ``created_at`` for deterministic ordering.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import Any

from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.agent_run import AgentRun
from api.models.base import Base
from api.routers import internal_agents
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/internal/agent-runs/threads"


def _msgs(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    return [{"role": role, "content": content} for role, content in pairs]


def _run(
    thread_id: str, at: int, messages: list[dict[str, str]], *, tenant_id: str = "default"
) -> AgentRun:
    return AgentRun(
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        agent_name="ideation-challenger",
        status="completed",
        thread_id=thread_id,
        messages=messages,
        created_at=datetime(2026, 1, 1, 0, 0, at, tzinfo=UTC),
    )


def _rows() -> list[AgentRun]:
    return [
        # thread t1, turn 1 — system/tool noise that must NOT appear
        _run(
            "t1",
            1,
            _msgs(
                ("system", "sys"), ("user", "idea one"), ("assistant", "reply one"), ("tool", "{}")
            ),
        ),
        _run("t1", 2, _msgs(("user", "idea two"), ("assistant", "reply two"))),  # turn 2, later
        _run("t2", 1, _msgs(("user", "other thread"), ("assistant", "other reply"))),
        _run(
            "t1", 1, _msgs(("user", "leak?"), ("assistant", "no")), tenant_id="tenant-b"
        ),  # another tenant
    ]


def _app() -> tuple[FastAPI, Any]:
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
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[Any]:
        async with factory() as session:
            yield session

    app = FastAPI()
    app.include_router(internal_agents.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/test-agent-runtime/session"
    )
    return app, engine


def test_reads_a_threads_conversation_oldest_first():
    app, engine = _app()
    client = TestClient(app)

    resp = client.get(f"{_BASE}/t1/messages")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["thread_id"] == "t1"
    # system/tool excluded; both turns, chronological.
    assert [(m["role"], m["content"]) for m in body["messages"]] == [
        ("user", "idea one"),
        ("assistant", "reply one"),
        ("user", "idea two"),
        ("assistant", "reply two"),
    ]
    asyncio.run(engine.dispose())


def test_scopes_to_the_thread_and_tenant():
    app, engine = _app()
    client = TestClient(app)

    other = client.get(f"{_BASE}/t2/messages").json()["messages"]
    assert [m["content"] for m in other] == ["other thread", "other reply"]
    # the same thread id in another tenant never leaks in
    assert all(
        m["content"] != "leak?" for m in client.get(f"{_BASE}/t1/messages").json()["messages"]
    )
    asyncio.run(engine.dispose())


def test_an_unknown_thread_is_an_empty_conversation_not_404():
    app, engine = _app()
    client = TestClient(app)

    resp = client.get(f"{_BASE}/brand-new/messages")

    assert resp.status_code == 200
    assert resp.json() == {"thread_id": "brand-new", "messages": []}
    asyncio.run(engine.dispose())
