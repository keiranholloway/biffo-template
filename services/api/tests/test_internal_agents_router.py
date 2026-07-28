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
from typing import Any, cast

import api.dependencies as dependencies
import pytest
from api.config import settings
from api.database import get_db
from api.events import BiffoEvent
from api.events.emit import publish_pending
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.agent_run import AgentRun
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
    # Exposed so a test can mark a run as a dry run — the one attribute no route
    # sets, because dry runs are created by the admin dry-run service (#726),
    # not through this service-only surface.
    app.state.session_factory = session_factory
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


# ── Reap (ADR-0014 §5, issue #402) ───────────────────────────────────────────
#
# A run reaches `running` only by being claimed, so one still there long after
# any invocation could have finished is a runtime that died holding it: already
# paid for, no result, and anything waiting on agent.run.completed waits for
# ever. The sweep makes that a definite "failed".


def _claimed_run(client: TestClient) -> str:
    """A run in `running` — the only state the reaper considers."""
    run_id = _create(client).json()["id"]
    client.post(f"{_RUNS}/{run_id}/claim", json={})
    return run_id


# Staleness is driven by the threshold rather than by ageing `started_at`:
# `stale_after_seconds=0` puts the cutoff at "now", so a run claimed a moment
# ago is already past it. That exercises the same comparison without a test that
# either sleeps for half an hour or reaches behind the API to rewrite a column.
STALE_IMMEDIATELY = 0
NEVER_STALE = 3600


def test_reap_fails_a_run_stuck_running_past_the_threshold(client, monkeypatch):
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    run_id = _claimed_run(client)

    resp = client.post(f"{_RUNS}/reap", json={})

    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()] == [run_id]
    assert resp.json()[0]["status"] == "failed"

    after = client.get(f"{_RUNS}/{run_id}").json()
    assert after["status"] == "failed"
    assert "Reaped" in after["error"]
    assert after["completed_at"] is not None


def test_reap_leaves_a_run_that_is_still_within_its_budget(client, monkeypatch):
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", NEVER_STALE)
    run_id = _claimed_run(client)

    assert client.post(f"{_RUNS}/reap", json={}).json() == []
    assert client.get(f"{_RUNS}/{run_id}").json()["status"] == "running"


def test_reap_leaves_a_pending_run_inside_its_grace_period(client, monkeypatch):
    # This test used to be `test_reap_never_touches_a_pending_run`, and its
    # stated reason was "pending means nothing was spent and nothing is waiting
    # on it — re-delivery can still pick it up". idea-scout#27 disproved the
    # second half: a run whose `agent.run.requested` was never delivered is
    # never re-delivered either, so it sits in `pending` for ever while the
    # founder-facing UI reports "Running". Only the *grace period* survives from
    # that reasoning, and that is what this now asserts.
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", NEVER_STALE)
    run_id = _create(client).json()["id"]

    assert client.post(f"{_RUNS}/reap", json={}).json() == []
    assert client.get(f"{_RUNS}/{run_id}").json()["status"] == "pending"


def test_reap_fails_a_run_left_unclaimed_past_the_threshold(client, monkeypatch):
    # The idea-scout#27 reproduction. A run nothing ever claimed never leaves
    # `pending`, so it was invisible to the very sweep built to catch abandoned
    # work — one survived ~17 sweeps over 255 minutes.
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", STALE_IMMEDIATELY)
    run_id = _create(client).json()["id"]

    resp = client.post(f"{_RUNS}/reap", json={})

    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()] == [run_id]

    after = client.get(f"{_RUNS}/{run_id}").json()
    assert after["status"] == "failed"
    assert after["completed_at"] is not None


def test_an_unclaimed_reap_does_not_blame_a_runtime_that_never_ran(client, monkeypatch):
    # The two abandonment shapes need different messages. Telling someone "the
    # runtime that claimed it is presumed dead" about a run nothing ever claimed
    # sends the next person to inspect the runtime instead of event delivery,
    # which is where the actual fault is.
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", STALE_IMMEDIATELY)
    run_id = _create(client).json()["id"]

    client.post(f"{_RUNS}/reap", json={})

    error = client.get(f"{_RUNS}/{run_id}").json()["error"]
    assert "never claimed" in error
    assert "presumed dead" not in error


def test_the_two_thresholds_move_independently(client, monkeypatch):
    # They are bounded by different things — a Lambda invocation cap versus
    # event-delivery latency — so they are separate settings. This is the guard
    # against them being quietly collapsed into one: raising the budget for a
    # slow runtime must not also extend how long a never-claimed run is
    # invisible, and vice versa.
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", NEVER_STALE)
    running_id = _claimed_run(client)
    pending_id = _create(client).json()["id"]

    assert [r["id"] for r in client.post(f"{_RUNS}/reap", json={}).json()] == [running_id]
    assert client.get(f"{_RUNS}/{pending_id}").json()["status"] == "pending"

    # Now the other way round: the unclaimed one goes, an in-budget claimed run stays.
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", NEVER_STALE)
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", STALE_IMMEDIATELY)
    still_running_id = _claimed_run(client)

    assert [r["id"] for r in client.post(f"{_RUNS}/reap", json={}).json()] == [pending_id]
    assert client.get(f"{_RUNS}/{still_running_id}").json()["status"] == "running"


def test_reaping_an_unclaimed_run_releases_its_subscribers(client, publisher, monkeypatch):
    # The whole point of reaping it. idea-scout#27's stuck scout had a plugin
    # polling a run that would never terminate; §5 exists so a subscriber can
    # tell "failed" from "still running", and a stranded run says neither.
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", STALE_IMMEDIATELY)
    run_id = _create(client).json()["id"]
    publisher.events.clear()

    client.post(f"{_RUNS}/reap", json={})

    assert [e.detail_type for e in publisher.events] == ["agent.run.completed"]
    assert publisher.events[0].payload["run_id"] == run_id
    assert publisher.events[0].payload["status"] == "failed"


def test_a_claim_cannot_resurrect_a_reaped_unclaimed_run(client, monkeypatch):
    # The race the conditional UPDATE exists for, in its new direction: a late
    # `agent.run.requested` delivery arriving after the sweep must not start
    # paying for a run already reported as failed.
    monkeypatch.setattr(settings, "agent_run_unclaimed_after_seconds", STALE_IMMEDIATELY)
    run_id = _create(client).json()["id"]
    client.post(f"{_RUNS}/reap", json={})

    resp = client.post(f"{_RUNS}/{run_id}/claim", json={})

    assert resp.status_code == 409
    assert client.get(f"{_RUNS}/{run_id}").json()["status"] == "failed"


def test_reap_never_rewrites_a_finished_run(client, monkeypatch):
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    run_id = _claimed_run(client)
    client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "completed", "result": {"output": "real answer"}},
    )

    assert client.post(f"{_RUNS}/reap", json={}).json() == []
    after = client.get(f"{_RUNS}/{run_id}").json()
    assert after["status"] == "completed"
    assert after["result"] == {"output": "real answer"}


def test_reap_emits_a_completion_per_reaped_run(client, publisher, monkeypatch):
    # The point of the sweep: §5 exists so a subscriber can tell "failed" from
    # "still running", and a stranded run says neither.
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    run_id = _claimed_run(client)
    publisher.events.clear()

    client.post(f"{_RUNS}/reap", json={})

    assert [e.detail_type for e in publisher.events] == ["agent.run.completed"]
    assert publisher.events[0].payload["run_id"] == run_id
    assert publisher.events[0].payload["status"] == "failed"


def test_reap_with_nothing_stale_is_a_silent_no_op(client, publisher, monkeypatch):
    # It runs on a schedule, so the common case is having nothing to do.
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    publisher.events.clear()

    assert client.post(f"{_RUNS}/reap", json={}).json() == []
    assert publisher.events == []


def test_reaping_twice_reaps_once(client, publisher, monkeypatch):
    # Scheduled, so it will be called again before anyone looks at the result.
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    _claimed_run(client)

    assert len(client.post(f"{_RUNS}/reap", json={}).json()) == 1
    publisher.events.clear()
    assert client.post(f"{_RUNS}/reap", json={}).json() == []
    assert publisher.events == []


# ── Idempotent creation (#661) ───────────────────────────────────────────────
#
# The DB-level race is covered in test_agent_run_idempotency.py. These assert the
# two things only the HTTP layer decides: the status code a duplicate gets, and
# whether it re-announces a run it did not create.


def test_a_duplicate_key_returns_the_first_run_with_200_not_a_second_run(client):
    first = _create(client, idempotency_key="fan-in:chain-1:synthesis")
    assert first.status_code == 201

    second = _create(client, idempotency_key="fan-in:chain-1:synthesis")

    assert second.status_code == 200, "a duplicate is not a creation"
    assert second.json()["id"] == first.json()["id"]
    assert len(client.get(_RUNS).json()) == 1


def test_a_duplicate_does_not_announce_the_run_a_second_time(client, publisher):
    """The load-bearing half. Re-announcing would dispatch the same work twice —
    `claim_run` survives that (§5), but only by paying for an invocation that
    exists solely to discover it lost. #661 is a billing defect; emitting again
    would leave half of it unfixed."""
    _create(client, idempotency_key="fan-in:chain-2:synthesis")
    publisher.events.clear()

    resp = _create(client, idempotency_key="fan-in:chain-2:synthesis")

    assert resp.status_code == 200
    assert publisher.events == [], "the duplicate must not re-request the run"


def test_creation_without_a_key_still_creates_and_announces(client, publisher):
    """Most callers pass no key. Their behaviour must be untouched — two
    requests are two runs, each announced."""
    publisher.events.clear()

    first = _create(client)
    second = _create(client)

    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    assert [e.detail_type for e in publisher.events] == [
        "agent.run.requested",
        "agent.run.requested",
    ]


def test_reap_is_not_shadowed_by_the_run_id_routes(client):
    # `/reap` is a literal segment where `{run_id}` also lives. If FastAPI ever
    # matched it as a run id, the sweep would silently 404 instead of running.
    assert client.post(f"{_RUNS}/reap", json={}).status_code == 200


# ── Listing a causation chain (issue #656) ──────────────────────────────────
#
# How a fan-in discovers the siblings of the run that just completed: given the
# causation_id off the completion event, ask which runs share it and whether
# they are all terminal yet.


def test_list_returns_only_the_runs_of_the_named_chain(client):
    _create(client, agent_name="research-a", causation_id="chain-1")
    _create(client, agent_name="research-b", causation_id="chain-1")
    _create(client, agent_name="unrelated", causation_id="chain-2")

    resp = client.get(_RUNS, params={"causation_id": "chain-1"})

    assert resp.status_code == 200
    assert {row["agent_name"] for row in resp.json()} == {"research-a", "research-b"}


def test_list_can_narrow_a_chain_to_one_agent(client):
    _create(client, agent_name="research-a", causation_id="chain-1")
    _create(client, agent_name="research-b", causation_id="chain-1")

    resp = client.get(_RUNS, params={"causation_id": "chain-1", "agent_name": "research-b"})

    assert [row["agent_name"] for row in resp.json()] == ["research-b"]


def test_list_of_an_unknown_chain_is_empty_not_an_error(client):
    """A fan-in polling a chain it has not seen must get [], not a 404 it has to
    special-case."""
    resp = client.get(_RUNS, params={"causation_id": "never-existed"})

    assert resp.status_code == 200
    assert resp.json() == []


def test_list_requires_a_causation_id(client):
    """Deliberately not optional: an unfiltered list here would hand any
    allowlisted principal every run in the tenant. The human-gated admin surface
    is where an unfiltered list belongs."""
    resp = client.get(_RUNS)

    assert resp.status_code == 422


def test_list_reports_each_runs_status_so_a_fan_in_can_decide(client):
    """The whole point of the endpoint — a fan-in fires only once every sibling
    is terminal, and terminal includes failed."""
    first = _create(client, agent_name="research-a", causation_id="chain-1").json()["id"]
    _create(client, agent_name="research-b", causation_id="chain-1")

    client.post(f"{_RUNS}/{first}/claim")
    client.post(
        f"{_RUNS}/{first}/complete",
        json={"status": "failed", "messages": [], "error": "boom"},
    )

    rows = {
        row["agent_name"]: row["status"]
        for row in client.get(_RUNS, params={"causation_id": "chain-1"}).json()
    }

    assert rows == {"research-a": "failed", "research-b": "pending"}


def test_list_never_returns_transcripts_or_payloads(client):
    """Summaries only. A list that carried unbounded messages/result/input_payload
    is what the load_only discipline in list_runs exists to prevent."""
    _create(client, causation_id="chain-1")

    row = client.get(_RUNS, params={"causation_id": "chain-1"}).json()[0]

    assert "messages" not in row
    assert "result" not in row
    assert "input_payload" not in row
    # The summary still carries what a fan-in needs to identify the run.
    assert row["agent_name"] == "demo-enricher"
    assert row["model"] == "anthropic/claude-sonnet-4"


def test_list_bounds_its_page_size(client):
    resp = client.get(_RUNS, params={"causation_id": "chain-1", "limit": 500})
    assert resp.status_code == 422


# ── dry runs are recorded but never announced (issue #726) ──────────────────
#
# The workflow dry-run is a real run executed by the real runtime, so by the time
# it completes it is indistinguishable from a genuine one. The *only* thing that
# stops a preview firing the write-back it was previewing is this router
# withholding `agent.run.completed` — the orchestrator is that event's sole
# subscriber, and it is what executes write-backs and fires chained agents.
#
# These are therefore the tests that make "a preview causes nothing" true.


def _mark_dry_run(client: TestClient, run_id: str) -> None:
    """Flip an existing run to a dry run, as the admin dry-run service creates it."""

    # `client.app` is typed as a bare ASGI callable, which has no `.state`; the
    # FastAPI instance underneath does. Cast rather than restructure the fixture,
    # which every other test in this file depends on.
    session_factory = cast("Any", client.app).state.session_factory

    async def _mark() -> None:
        async with session_factory() as session:
            run = await session.get(AgentRun, run_id)
            run.dry_run = True
            await session.commit()

    asyncio.run(_mark())


def test_completing_a_dry_run_emits_nothing(client, publisher):
    run_id = _create(client).json()["id"]
    _mark_dry_run(client, run_id)
    publisher.events.clear()

    resp = client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "completed", "result": {"summary": "previewed enrichment"}},
    )

    assert resp.status_code == 200
    # Not "no write-back happened" — nothing was *told*, which is the property
    # that holds no matter what subscribers are added later.
    assert publisher.events == []


def test_a_completed_dry_run_is_still_recorded_for_the_poller(client):
    run_id = _create(client).json()["id"]
    _mark_dry_run(client, run_id)

    client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "completed", "result": {"summary": "previewed enrichment"}},
    )

    after = client.get(f"{_RUNS}/{run_id}").json()
    # Silence on the bus must not mean silence to the person waiting: the portal
    # polls this row, so a preview that completed invisibly would hang the UI.
    assert after["status"] == "completed"
    assert after["result"] == {"summary": "previewed enrichment"}


def test_a_failed_dry_run_emits_nothing_either(client, publisher):
    run_id = _create(client).json()["id"]
    _mark_dry_run(client, run_id)
    publisher.events.clear()

    client.post(
        f"{_RUNS}/{run_id}/complete",
        json={"status": "failed", "error": "the agent runtime turn failed"},
    )

    # The orchestrator subscribes to failures as well as successes, so a failed
    # preview could otherwise advance a workflow that the successful one did not.
    assert publisher.events == []


def test_reaping_a_stale_dry_run_emits_nothing(client, publisher, monkeypatch):
    monkeypatch.setattr(settings, "agent_run_stale_after_seconds", STALE_IMMEDIATELY)
    run_id = _claimed_run(client)
    _mark_dry_run(client, run_id)
    publisher.events.clear()

    resp = client.post(f"{_RUNS}/reap", json={})

    # The easier one to miss: the reaper announces every run it fails, on a
    # schedule, long after the request that created the preview is gone.
    assert [r["id"] for r in resp.json()] == [run_id]
    assert resp.json()[0]["status"] == "failed"
    assert publisher.events == []


def test_a_real_run_alongside_a_dry_one_is_still_announced(client, publisher):
    """The suppression must key off the run, not off a global switch."""
    dry_id = _create(client).json()["id"]
    _mark_dry_run(client, dry_id)
    real_id = _create(client).json()["id"]
    publisher.events.clear()

    client.post(f"{_RUNS}/{dry_id}/complete", json={"status": "completed"})
    client.post(f"{_RUNS}/{real_id}/complete", json={"status": "completed"})

    assert [e.payload["run_id"] for e in publisher.events] == [real_id]
