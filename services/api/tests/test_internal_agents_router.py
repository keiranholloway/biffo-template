"""Integration tests for the internal agent-run router (ADR-0009 / ADR-0014).

Drives the service-only routes end to end through FastAPI's TestClient against
in-memory SQLite, with require_service_principal overridden to a stub caller (the
IAM gate is enforced by API Gateway + tested separately in test_service_auth.py).
The StaticPool/in-memory-SQLite fixture pattern mirrors
test_internal_orchestration_router.py.

The get_db override reproduces the real one's commit/publish contract (commit,
then publish_pending; rollback and re-raise on failure, buffer discarded) so the
emission assertions here exercise the same post-commit buffer production does —
including the "a rolled-back transaction emits nothing" case (ADR-0014 §5).
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import api.dependencies as dependencies
import pytest
from api.config import settings
from api.database import get_db
from api.events import BiffoEvent
from api.events.emit import publish_pending
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table on Base.metadata
from api.models.base import Base
from api.routers import internal_agents
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_RUNS = "/api/v1/internal/agent-runs"


class _RecordingPublisher:
    def __init__(self) -> None:
        self.events: list[BiffoEvent] = []

    def publish(self, event: BiffoEvent) -> None:
        self.events.append(event)


@pytest.fixture(autouse=True)
def publisher(monkeypatch) -> _RecordingPublisher:
    """Capture what reaches the bus — and keep the real EventBridge client out
    of every test in this module. ``publish_pending`` runs on each successful
    request here, so a test that never inspects events would still construct a
    boto3 client and fail where no AWS region is configured (CI)."""
    rec = _RecordingPublisher()
    monkeypatch.setattr(dependencies, "get_event_publisher", lambda: rec)
    return rec


@pytest.fixture
def fail_commit() -> dict[str, bool]:
    """Flip ``["on"]`` to make the request's transaction blow up before commit."""
    return {"on": False}


@pytest.fixture
def agents_app(fail_commit) -> Generator[FastAPI]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create_tables() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create_tables())

    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        # Same shape as api.database.get_db: publish only in the else branch.
        async with session_factory() as session:
            try:
                yield session
                if fail_commit["on"]:
                    raise RuntimeError("commit failed")
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            else:
                await publish_pending(session)

    app = FastAPI()
    app.include_router(internal_agents.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/test-agent-runtime/session"
    )

    yield app

    asyncio.run(engine.dispose())


@pytest.fixture
def client(agents_app) -> TestClient:
    return TestClient(agents_app)


def _create_body(**overrides) -> dict:
    body = {
        "agent_name": "demo-enricher",
        "definition_snapshot": {
            "instructions": "Enrich the demo request.",
            "model": "anthropic/claude-sonnet-4",
            "tools": ["web_search"],
            "read_scope": [],
            "max_turns": 6,
        },
        "input_payload": {"demo_request_id": "d1", "company": "Acme"},
        "causation_id": "demo.requested/d1",
        "depth": 0,
        "workflow_run_id": "wr-1",
    }
    body.update(overrides)
    return body


def _create(client: TestClient, **overrides):
    return client.post(_RUNS, json=_create_body(**overrides))


def test_create_persists_pending_run_with_snapshot(client, publisher):
    resp = _create(client)

    assert resp.status_code == 201
    run = resp.json()
    assert run["status"] == "pending"
    assert run["agent_name"] == "demo-enricher"
    assert run["run_as_kind"] == "system"
    assert run["run_as_user_id"] is None
    assert run["workflow_run_id"] == "wr-1"
    assert run["depth"] == 0
    assert run["messages"] == []
    # §10: the resolved definition is captured verbatim (JSON round-trips).
    assert run["definition_snapshot"]["model"] == "anthropic/claude-sonnet-4"
    assert run["definition_snapshot"]["tools"] == ["web_search"]
    assert run["input_payload"]["company"] == "Acme"


def test_create_emits_agent_run_requested_with_a_reference(client, publisher):
    run_id = _create(client).json()["id"]

    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.source == "biffo.core"
    assert event.detail_type == "agent.run.requested"
    assert event.payload == {
        "run_id": run_id,
        "agent": "demo-enricher",
        "status": "pending",
        "causation_id": "demo.requested/d1",
        "depth": 0,
    }


def test_rolled_back_transaction_emits_nothing(client, publisher, fail_commit):
    fail_commit["on"] = True

    with pytest.raises(RuntimeError):
        _create(client)

    # The buffer is discarded with the session — no phantom event (§5).
    assert publisher.events == []


def test_create_refuses_past_the_depth_ceiling(client, publisher, monkeypatch):
    # A configured ceiling, deliberately not the default, so this proves the
    # route reads settings rather than a constant.
    monkeypatch.setattr(settings, "agent_max_run_depth", 1)

    ok = _create(client, depth=1)
    refused = _create(client, depth=2)

    assert ok.status_code == 201
    assert refused.status_code == 409
    assert "depth" in refused.json()["detail"]
    # The refused run never existed, so only the accepted one announced itself.
    assert [e.payload["depth"] for e in publisher.events] == [1]


def test_create_rejects_negative_depth(client):
    assert _create(client, depth=-1).status_code == 422


def test_get_returns_definition_and_input(client):
    run_id = _create(client).json()["id"]

    resp = client.get(f"{_RUNS}/{run_id}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == run_id
    # The event carries only a reference; this is where the runtime reads the rest.
    assert body["definition_snapshot"]["instructions"] == "Enrich the demo request."
    assert body["input_payload"] == {"demo_request_id": "d1", "company": "Acme"}


def test_get_unknown_run_is_404(client):
    assert client.get(f"{_RUNS}/nope").status_code == 404


def test_complete_records_outcome_and_accounting(client):
    run_id = _create(client).json()["id"]

    resp = client.post(
        f"{_RUNS}/{run_id}/complete",
        json={
            "status": "completed",
            "messages": [{"role": "assistant", "content": "Acme is a mid-market manufacturer."}],
            "result": {"summary": "mid-market manufacturer"},
            "input_tokens": 1200,
            "output_tokens": 340,
            "cost_usd": 0.0182,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    assert body["result"] == {"summary": "mid-market manufacturer"}
    assert body["messages"][0]["role"] == "assistant"
    assert body["input_tokens"] == 1200
    assert body["output_tokens"] == 340
    assert body["cost_usd"] == pytest.approx(0.0182)
    assert body["completed_at"] is not None


def test_complete_emits_with_status_and_no_result(client, publisher):
    run_id = _create(client).json()["id"]
    publisher.events.clear()

    client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "completed", "result": {"summary": "secret enrichment"}},
    )

    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event.detail_type == "agent.run.completed"
    assert event.payload["status"] == "completed"
    assert event.payload["run_id"] == run_id
    # The result and transcript stay behind the authenticated fetch (§5).
    assert set(event.payload) == {"run_id", "agent", "status", "causation_id", "depth"}


def test_terminal_failure_emits_too(client, publisher):
    run_id = _create(client).json()["id"]
    publisher.events.clear()

    resp = client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "failed", "error": "model call timed out"},
    )

    assert resp.status_code == 200
    assert resp.json()["error"] == "model call timed out"
    # A subscriber must be able to tell "failed" from "still running".
    assert len(publisher.events) == 1
    assert publisher.events[0].detail_type == "agent.run.completed"
    assert publisher.events[0].payload["status"] == "failed"


def test_double_completion_is_rejected(client, publisher):
    run_id = _create(client).json()["id"]
    client.post(f"{_RUNS}/{run_id}/complete", json={"status": "completed", "result": {"n": 1}})
    publisher.events.clear()

    second = client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "failed", "error": "late retry"},
    )

    assert second.status_code == 409
    # The first outcome survives, and the replay does not re-announce.
    assert client.get(f"{_RUNS}/{run_id}").json()["result"] == {"n": 1}
    assert publisher.events == []


def test_complete_rejects_non_terminal_status(client):
    run_id = _create(client).json()["id"]

    resp = client.post(f"{_RUNS}/{run_id}/complete", json={"status": "running"})

    assert resp.status_code == 422


def test_complete_unknown_run_is_404(client):
    resp = client.post(f"{_RUNS}/nope/complete", json={"status": "completed"})

    assert resp.status_code == 404


# ── Claim (ADR-0014 §5, issue #371) ──────────────────────────────────────────
#
# EventBridge delivery is at-least-once. Without a claim, two deliveries of the
# same agent.run.requested both read `pending`, both call the provider, and both
# are billed — only the second *completion* is refused, so the recorded outcome
# is right and the invoice is not.


def test_claim_moves_a_pending_run_to_running_and_stamps_started_at(client):
    run_id = _create(client).json()["id"]

    resp = client.post(f"{_RUNS}/{run_id}/claim", json={})

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "running"
    # started_at is what makes a stranded run detectable: "running for longer
    # than the ceiling" is a query; "pending for ever" is indistinguishable from
    # "never picked up".
    assert body["started_at"] is not None


def test_a_second_claim_is_refused(client):
    run_id = _create(client).json()["id"]
    assert client.post(f"{_RUNS}/{run_id}/claim", json={}).status_code == 200

    resp = client.post(f"{_RUNS}/{run_id}/claim", json={})

    assert resp.status_code == 409
    assert "running" in resp.json()["detail"]


def test_claiming_a_finished_run_is_refused(client):
    run_id = _create(client).json()["id"]
    client.post(f"{_RUNS}/{run_id}/claim", json={})
    client.post(f"{_RUNS}/{run_id}/complete", json={"status": "completed"})

    resp = client.post(f"{_RUNS}/{run_id}/claim", json={})

    assert resp.status_code == 409


def test_claim_unknown_run_is_404(client):
    assert client.post(f"{_RUNS}/nope/claim", json={}).status_code == 404


def test_claim_emits_nothing(client, publisher):
    # A claim is a lease on work already announced by agent.run.requested, not a
    # new fact. Emitting per claim would put a message on the bus for every
    # duplicate delivery — the thing being suppressed.
    run_id = _create(client).json()["id"]
    publisher.events.clear()

    client.post(f"{_RUNS}/{run_id}/claim", json={})

    assert publisher.events == []


def test_a_claimed_run_still_completes_normally(client):
    run_id = _create(client).json()["id"]
    client.post(f"{_RUNS}/{run_id}/claim", json={})

    resp = client.post(f"{_RUNS}/{run_id}/complete", json={"status": "completed"})

    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"
