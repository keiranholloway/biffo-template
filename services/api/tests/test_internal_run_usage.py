"""Internal usage routes: model + cost by thread_id and by run-id list."""

from __future__ import annotations

import asyncio
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

_BASE = "/api/v1/internal/agent-runs"


def _run(rid, agent, *, thread=None, cost=None, model="m1", tenant="default", at=1):
    return AgentRun(
        id=rid,
        tenant_id=tenant,
        agent_name=agent,
        status="completed",
        thread_id=thread,
        definition_snapshot={"model": model},
        input_tokens=10,
        output_tokens=5,
        cost_usd=cost,
        created_at=datetime(2026, 1, 1, 0, 0, at, tzinfo=UTC),
    )


def _app() -> tuple[FastAPI, Any]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _seed() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with factory() as session:
            session.add_all(
                [
                    _run("r1", "chat", thread="t1", cost=0.5, at=1),
                    _run("r2", "chat", thread="t1", cost=0.25, at=2),
                    _run("r3", "chat", thread="t1", cost=None, at=3),
                    _run("r4", "research", cost=1.0),
                    _run("r5", "synthesis", cost=2.0, model="m2"),
                    _run("x1", "chat", thread="t1", cost=99.0, tenant="tenant-b"),
                ]
            )
            await session.commit()

    asyncio.run(_seed())

    async def override_get_db() -> AsyncGenerator[Any]:
        async with factory() as session:
            yield session

    app = FastAPI()
    app.include_router(internal_agents.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/test/session"
    )
    return app, engine


def test_thread_usage_totals_priced_and_counts_unpriced():
    app, engine = _app()
    body = TestClient(app).get(f"{_BASE}/threads/t1/usage").json()
    assert [r["id"] for r in body["runs"]] == ["r1", "r2", "r3"]
    assert body["runs"][0]["model"] == "m1"
    assert body["runs"][2]["cost_usd"] is None
    assert body["total_cost_usd"] == 0.75
    assert body["unpriced_runs"] == 1
    assert body["total_input_tokens"] == 30
    asyncio.run(engine.dispose())


def test_run_id_list_spans_agents_and_excludes_other_tenant():
    app, engine = _app()
    resp = TestClient(app).post(f"{_BASE}/usage", json={"run_ids": ["r4", "r5", "x1", "nope"]})
    body = resp.json()
    assert {r["agent_name"] for r in body["runs"]} == {"research", "synthesis"}
    assert {r["model"] for r in body["runs"]} == {"m1", "m2"}
    assert body["total_cost_usd"] == 3.0
    assert body["unpriced_runs"] == 0
    asyncio.run(engine.dispose())


def test_unknown_thread_is_empty_not_404():
    app, engine = _app()
    resp = TestClient(app).get(f"{_BASE}/threads/none/usage")
    assert resp.status_code == 200
    assert resp.json()["runs"] == []
    assert resp.json()["unpriced_runs"] == 0
    asyncio.run(engine.dispose())
