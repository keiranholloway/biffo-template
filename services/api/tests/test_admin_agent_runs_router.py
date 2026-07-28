"""Integration tests for the admin agent-run read surface
(/api/v1/admin/agent-runs, ADR-0014).

Runs are seeded through the *real* domain path (``create_run`` +
``complete_run``) so the records a caller reads are the records the runtime
actually writes. StaticPool/in-memory-SQLite fixture, mirroring
test_orchestration_runs_router.py and test_internal_agents_router.py.

The security-critical case here is cross-tenant isolation: an admin of one
tenant must never read another tenant's run, on the list or the detail route.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator
from datetime import UTC, datetime, timedelta

import pytest
from api.agent_runs import complete_run, create_run
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table on Base.metadata
from api.models.base import Base
from api.routers.admin import agent_runs as admin_agent_runs
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/admin/agent-runs"

_SNAPSHOT = {
    "instructions": "Enrich the demo request.",
    "model": "anthropic/claude-sonnet-4",
    "tools": ["web_search"],
    "read_scope": [],
    "max_turns": 6,
}
_MESSAGES = [
    {"role": "user", "content": "Who is Acme?"},
    {"role": "assistant", "content": "Acme is a mid-market manufacturer."},
]


def _caller(*, tenant_id: str = "default", roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"] if roles is None else roles,
    )


@pytest.fixture
def app() -> Generator[tuple[FastAPI, async_sessionmaker]]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    fastapi = FastAPI()
    fastapi.include_router(admin_agent_runs.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: _caller()

    yield fastapi, session_factory

    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    fastapi, _ = app
    return TestClient(fastapi)


# A fixed base so seeded runs get distinct, ordered created_at values — in
# SQLite rows seeded in the same tick otherwise share a timestamp, and the id
# tiebreak is a random UUID, which would make "newest first" untestable.
_T0 = datetime(2026, 1, 1, tzinfo=UTC)


async def _seed(
    session_factory: async_sessionmaker,
    *,
    tenant_id: str = "default",
    agent_name: str = "demo-enricher",
    complete: bool = True,
    outcome: str = "completed",
    created_offset: int = 0,
) -> str:
    """Create a run (optionally completing it), returning its id.

    ``created_offset`` sets ``created_at`` to ``_T0 + offset`` so ordering tests
    have deterministic, distinct timestamps.
    """
    async with session_factory() as session:
        run, _ = await create_run(
            session,
            tenant_id=tenant_id,
            agent_name=agent_name,
            definition_snapshot=_SNAPSHOT,
            input_payload={"demo_request_id": "d1", "company": "Acme", "email": "buyer@acme.test"},
            max_depth=8,
        )
        run.created_at = _T0 + timedelta(seconds=created_offset)
        await session.flush()
        run_id = run.id
        if complete:
            await complete_run(
                session,
                tenant_id=tenant_id,
                run_id=run_id,
                status=outcome,
                messages=_MESSAGES,
                result={"summary": "mid-market manufacturer"},
                input_tokens=1200,
                output_tokens=340,
                cost_usd=0.0182,
            )
        await session.commit()
        return run_id


# ── List ─────────────────────────────────────────────────────────────────────


def test_list_is_newest_first(app, client: TestClient):
    _, session_factory = app
    first = asyncio.run(_seed(session_factory, created_offset=0))
    second = asyncio.run(_seed(session_factory, created_offset=1))
    third = asyncio.run(_seed(session_factory, created_offset=2))

    rows = client.get(_BASE).json()
    assert [r["id"] for r in rows] == [third, second, first]


def test_list_returns_the_summary_shape(app, client: TestClient):
    _, session_factory = app
    run_id = asyncio.run(_seed(session_factory))

    row = client.get(_BASE).json()[0]
    assert row["id"] == run_id
    assert row["agent_name"] == "demo-enricher"
    assert row["status"] == "completed"
    # `model` is lifted out of the definition snapshot for the row.
    assert row["model"] == "anthropic/claude-sonnet-4"
    assert row["input_tokens"] == 1200
    assert row["output_tokens"] == 340
    assert row["cost_usd"] == pytest.approx(0.0182)
    assert row["completed_at"] is not None


def test_list_does_not_return_heavy_content(app, client: TestClient):
    # The whole reason this surface exists: the transcript/result/payload are
    # unbounded and PII-adjacent, so they must not travel on a list.
    _, session_factory = app
    asyncio.run(_seed(session_factory))

    row = client.get(_BASE).json()[0]
    assert "messages" not in row
    assert "result" not in row
    assert "input_payload" not in row
    assert "definition_snapshot" not in row
    # The full transcript text never appears anywhere in the list body.
    assert "mid-market manufacturer" not in client.get(_BASE).text
    assert "buyer@acme.test" not in client.get(_BASE).text


def test_list_filters_by_agent_name(app, client: TestClient):
    _, session_factory = app
    enricher = asyncio.run(_seed(session_factory, agent_name="demo-enricher"))
    scorer = asyncio.run(_seed(session_factory, agent_name="lead-scorer"))

    assert {r["id"] for r in client.get(_BASE).json()} == {enricher, scorer}
    only = client.get(_BASE, params={"agent_name": "lead-scorer"}).json()
    assert [r["id"] for r in only] == [scorer]


def test_list_filters_by_status(app, client: TestClient):
    _, session_factory = app
    done = asyncio.run(_seed(session_factory, outcome="completed"))
    failed = asyncio.run(_seed(session_factory, outcome="failed"))
    pending = asyncio.run(_seed(session_factory, complete=False))

    assert {r["id"] for r in client.get(_BASE).json()} == {done, failed, pending}
    assert [r["id"] for r in client.get(_BASE, params={"status": "failed"}).json()] == [failed]
    assert [r["id"] for r in client.get(_BASE, params={"status": "pending"}).json()] == [pending]


def test_list_rejects_an_unknown_status(client: TestClient):
    assert client.get(_BASE, params={"status": "exploded"}).status_code == 422


def test_list_paginates(app, client: TestClient):
    _, session_factory = app
    ids = [asyncio.run(_seed(session_factory, created_offset=i)) for i in range(5)]
    newest_first = list(reversed(ids))

    page1 = client.get(_BASE, params={"limit": 2, "offset": 0}).json()
    page2 = client.get(_BASE, params={"limit": 2, "offset": 2}).json()
    assert [r["id"] for r in page1] == newest_first[:2]
    assert [r["id"] for r in page2] == newest_first[2:4]


def test_list_bounds_pagination(client: TestClient):
    assert client.get(_BASE, params={"limit": 0}).status_code == 422
    assert client.get(_BASE, params={"limit": 500}).status_code == 422
    assert client.get(_BASE, params={"offset": -1}).status_code == 422


# ── Detail ───────────────────────────────────────────────────────────────────


def test_detail_returns_the_full_record(app, client: TestClient):
    _, session_factory = app
    run_id = asyncio.run(_seed(session_factory))

    body = client.get(f"{_BASE}/{run_id}").json()
    assert body["id"] == run_id
    # The full transcript, result and snapshot the list withholds.
    assert body["messages"] == _MESSAGES
    assert body["result"] == {"summary": "mid-market manufacturer"}
    assert body["definition_snapshot"]["instructions"] == "Enrich the demo request."
    assert body["input_payload"]["company"] == "Acme"
    assert body["input_tokens"] == 1200
    assert body["cost_usd"] == pytest.approx(0.0182)


def test_detail_unknown_run_is_404(client: TestClient):
    assert client.get(f"{_BASE}/nope").status_code == 404


# ── Auth and tenant isolation ────────────────────────────────────────────────


def test_list_requires_admin(app, client: TestClient):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=["user"])
    assert client.get(_BASE).status_code == 403


def test_detail_requires_admin(app, client: TestClient):
    fastapi, session_factory = app
    run_id = asyncio.run(_seed(session_factory))
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=["user"])
    assert client.get(f"{_BASE}/{run_id}").status_code == 403


def test_a_run_in_another_tenant_is_not_listed(app, client: TestClient):
    # Security-critical: AgentRun is tenant-scoped; another tenant's run must be
    # invisible on the list.
    _, session_factory = app
    asyncio.run(_seed(session_factory, tenant_id="other"))
    assert client.get(_BASE).json() == []


def test_a_run_in_another_tenant_is_404_on_detail(app, client: TestClient):
    # Security-critical: fetching another tenant's run by id is a 404, never a
    # read — indistinguishable from a run that does not exist.
    _, session_factory = app
    other_run = asyncio.run(_seed(session_factory, tenant_id="other"))

    # The caller is tenant "default"; the run belongs to "other".
    assert client.get(f"{_BASE}/{other_run}").status_code == 404
