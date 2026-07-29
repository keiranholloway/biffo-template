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


# ── Cost aggregation ────────────────────────────────────────────────────────


def test_costs_groups_by_model(app, client: TestClient):
    """Grouping by model across several runs with different models."""
    _, session_factory = app
    # Seed runs with two different models
    snapshot_sonnet = {
        "instructions": "Enrich the demo request.",
        "model": "anthropic/claude-sonnet-4",
        "tools": ["web_search"],
        "read_scope": [],
        "max_turns": 6,
    }
    snapshot_opus = {
        "instructions": "Enrich the demo request.",
        "model": "anthropic/claude-opus",
        "tools": ["web_search"],
        "read_scope": [],
        "max_turns": 6,
    }

    async def _seed_with_model(
        snapshot: dict,
        created_offset: int,
        cost: float,
        input_tok: int,
        output_tok: int,
    ) -> str:
        async with session_factory() as session:
            run, _ = await create_run(
                session,
                tenant_id="default",
                agent_name="demo-enricher",
                definition_snapshot=snapshot,
                input_payload={},
                max_depth=8,
            )
            run.created_at = _T0 + timedelta(seconds=created_offset)
            await session.flush()
            await complete_run(
                session,
                tenant_id="default",
                run_id=run.id,
                status="completed",
                messages=_MESSAGES,
                result={},
                input_tokens=input_tok,
                output_tokens=output_tok,
                cost_usd=cost,
            )
            await session.commit()
            return run.id

    asyncio.run(_seed_with_model(snapshot_sonnet, 0, 0.01, 100, 50))
    asyncio.run(_seed_with_model(snapshot_sonnet, 1, 0.015, 150, 75))
    asyncio.run(_seed_with_model(snapshot_opus, 2, 0.03, 200, 100))

    # Query with explicit date range covering _T0 +/- 1 day
    since_iso = (_T0 - timedelta(days=1)).isoformat()
    until_iso = (_T0 + timedelta(days=1)).isoformat()
    rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()
    # Should have 2 groups
    assert len(rows) == 2

    # Find each group
    sonnet = next(r for r in rows if r["model"] == "anthropic/claude-sonnet-4")
    opus = next(r for r in rows if r["model"] == "anthropic/claude-opus")

    assert sonnet["runs"] == 2
    assert sonnet["total_cost_usd"] == pytest.approx(0.025)
    assert sonnet["total_input_tokens"] == 250
    assert sonnet["total_output_tokens"] == 125
    assert sonnet["unpriced_runs"] == 0

    assert opus["runs"] == 1
    assert opus["total_cost_usd"] == pytest.approx(0.03)
    assert opus["total_input_tokens"] == 200
    assert opus["total_output_tokens"] == 100
    assert opus["unpriced_runs"] == 0


def test_costs_counts_unpriced_runs_separately(app, client: TestClient):
    """Runs with NULL cost_usd are counted in unpriced_runs and excluded from total_cost_usd."""
    _, session_factory = app

    async def _seed_unpriced(offset: int) -> str:
        async with session_factory() as session:
            run, _ = await create_run(
                session,
                tenant_id="default",
                agent_name="demo-enricher",
                definition_snapshot=_SNAPSHOT,
                input_payload={},
                max_depth=8,
            )
            run.created_at = _T0 + timedelta(seconds=offset)
            await session.flush()
            # Complete without cost_usd (None)
            await complete_run(
                session,
                tenant_id="default",
                run_id=run.id,
                status="completed",
                messages=_MESSAGES,
                result={},
                input_tokens=100,
                output_tokens=50,
                cost_usd=None,
            )
            await session.commit()
            return run.id

    async def _seed_priced(offset: int) -> str:
        async with session_factory() as session:
            run, _ = await create_run(
                session,
                tenant_id="default",
                agent_name="demo-enricher",
                definition_snapshot=_SNAPSHOT,
                input_payload={},
                max_depth=8,
            )
            run.created_at = _T0 + timedelta(seconds=offset)
            await session.flush()
            await complete_run(
                session,
                tenant_id="default",
                run_id=run.id,
                status="completed",
                messages=_MESSAGES,
                result={},
                input_tokens=200,
                output_tokens=100,
                cost_usd=0.05,
            )
            await session.commit()
            return run.id

    asyncio.run(_seed_unpriced(0))
    asyncio.run(_seed_unpriced(1))
    asyncio.run(_seed_priced(2))

    since_iso = (_T0 - timedelta(days=1)).isoformat()
    until_iso = (_T0 + timedelta(days=1)).isoformat()
    rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()
    assert len(rows) == 1
    row = rows[0]

    # Total runs: 3 (2 unpriced + 1 priced)
    assert row["runs"] == 3
    # Only the priced run's cost should count
    assert row["total_cost_usd"] == pytest.approx(0.05)
    # Total input tokens: 100 + 100 + 200 = 400
    assert row["total_input_tokens"] == 400
    # Total output tokens: 50 + 50 + 100 = 200
    assert row["total_output_tokens"] == 200
    # Unpriced runs: 2
    assert row["unpriced_runs"] == 2


def test_costs_respects_date_range(app, client: TestClient):
    """Date-range boundaries are inclusive or exclusive as stated."""
    _, session_factory = app

    async def _seed_at_time(dt: datetime) -> str:
        async with session_factory() as session:
            run, _ = await create_run(
                session,
                tenant_id="default",
                agent_name="demo-enricher",
                definition_snapshot=_SNAPSHOT,
                input_payload={},
                max_depth=8,
            )
            run.created_at = dt
            await session.flush()
            await complete_run(
                session,
                tenant_id="default",
                run_id=run.id,
                status="completed",
                messages=_MESSAGES,
                result={},
                input_tokens=100,
                output_tokens=50,
                cost_usd=0.01,
            )
            await session.commit()
            return run.id

    # Create runs on specific dates
    t0 = datetime(2026, 7, 20, 12, 0, 0, tzinfo=UTC)
    t1 = datetime(2026, 7, 25, 12, 0, 0, tzinfo=UTC)
    t2 = datetime(2026, 7, 29, 12, 0, 0, tzinfo=UTC)

    asyncio.run(_seed_at_time(t0))
    asyncio.run(_seed_at_time(t1))
    asyncio.run(_seed_at_time(t2))

    # Query with range covering only middle and latest
    since_iso = t1.isoformat()
    until_iso = t2.isoformat()
    rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()

    # Should be inclusive on both ends
    assert len(rows) == 1
    assert rows[0]["runs"] == 2  # t1 and t2


def test_costs_filters_by_agent_name(app, client: TestClient):
    """Optional agent_name filters results."""
    _, session_factory = app

    async def _seed_agent(agent_name: str, offset: int) -> str:
        async with session_factory() as session:
            run, _ = await create_run(
                session,
                tenant_id="default",
                agent_name=agent_name,
                definition_snapshot=_SNAPSHOT,
                input_payload={},
                max_depth=8,
            )
            run.created_at = _T0 + timedelta(seconds=offset)
            await session.flush()
            await complete_run(
                session,
                tenant_id="default",
                run_id=run.id,
                status="completed",
                messages=_MESSAGES,
                result={},
                input_tokens=100,
                output_tokens=50,
                cost_usd=0.01,
            )
            await session.commit()
            return run.id

    asyncio.run(_seed_agent("agent-a", 0))
    asyncio.run(_seed_agent("agent-a", 1))
    asyncio.run(_seed_agent("agent-b", 2))

    since_iso = (_T0 - timedelta(days=1)).isoformat()
    until_iso = (_T0 + timedelta(days=1)).isoformat()

    # All agents
    all_rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()
    assert len(all_rows) == 1  # Same model
    assert all_rows[0]["runs"] == 3

    # Filter by agent
    agent_a = client.get(
        f"{_BASE}/costs",
        params={"agent_name": "agent-a", "since": since_iso, "until": until_iso},
    ).json()
    assert len(agent_a) == 1
    assert agent_a[0]["runs"] == 2

    agent_b = client.get(
        f"{_BASE}/costs",
        params={"agent_name": "agent-b", "since": since_iso, "until": until_iso},
    ).json()
    assert len(agent_b) == 1
    assert agent_b[0]["runs"] == 1


def test_costs_empty_range_returns_empty_list(app, client: TestClient):
    """Empty range returns an empty list, not an error."""
    _, session_factory = app
    asyncio.run(_seed(session_factory))

    # Query a far-future range where no runs exist
    since_iso = datetime(2099, 1, 1, tzinfo=UTC).isoformat()
    until_iso = datetime(2099, 12, 31, tzinfo=UTC).isoformat()
    rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()
    assert rows == []


def test_costs_requires_admin(app, client: TestClient):
    """Route is admin-gated."""
    _, session_factory = app
    asyncio.run(_seed(session_factory))
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=["user"])
    assert client.get(f"{_BASE}/costs").status_code == 403


def test_costs_respects_tenant_isolation(app, client: TestClient):
    """Seed a run under a second tenant and assert it does not appear (ADR-0001)."""
    _, session_factory = app
    asyncio.run(_seed(session_factory, tenant_id="default"))
    asyncio.run(_seed(session_factory, tenant_id="other"))

    # Caller is in "default" tenant; should only see their own run
    since_iso = (_T0 - timedelta(days=1)).isoformat()
    until_iso = (_T0 + timedelta(days=1)).isoformat()
    rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()
    assert len(rows) == 1
    assert rows[0]["runs"] == 1


def test_costs_run_with_no_model_reports_none(app, client: TestClient):
    """A run with no model in definition_snapshot reports model as None."""
    _, session_factory = app

    async def _seed_no_model(offset: int) -> str:
        async with session_factory() as session:
            # Snapshot with no model key
            snapshot_no_model = {
                "instructions": "Test instruction.",
                "tools": [],
                "read_scope": [],
                "max_turns": 1,
            }
            run, _ = await create_run(
                session,
                tenant_id="default",
                agent_name="test-agent",
                definition_snapshot=snapshot_no_model,
                input_payload={},
                max_depth=8,
            )
            run.created_at = _T0 + timedelta(seconds=offset)
            await session.flush()
            await complete_run(
                session,
                tenant_id="default",
                run_id=run.id,
                status="completed",
                messages=_MESSAGES,
                result={},
                input_tokens=100,
                output_tokens=50,
                cost_usd=0.01,
            )
            await session.commit()
            return run.id

    asyncio.run(_seed_no_model(0))

    since_iso = (_T0 - timedelta(days=1)).isoformat()
    until_iso = (_T0 + timedelta(days=1)).isoformat()
    rows = client.get(f"{_BASE}/costs", params={"since": since_iso, "until": until_iso}).json()

    assert len(rows) == 1
    assert rows[0]["model"] is None  # Should be None, not ""
    assert rows[0]["runs"] == 1
