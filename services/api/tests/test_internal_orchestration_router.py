"""Integration test for the internal orchestration router (ADR-0009).

Drives the service-only routes end to end through FastAPI's TestClient against
in-memory SQLite, with require_service_principal overridden to a stub caller
(the IAM gate is enforced by API Gateway + tested separately in
test_service_auth.py). The StaticPool/in-memory-SQLite fixture pattern mirrors
test_core_crud_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator
from unittest.mock import patch

import pytest
from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    WorkflowDefinition,
    WorkflowRun,
)
from api.routers import internal_orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_EVENTS = "/api/v1/internal/orchestration/events"


def _fire_url(run_id: str) -> str:
    return f"/api/v1/internal/orchestration/runs/{run_id}/fire"


@pytest.fixture
def orchestration_app() -> Generator[tuple[FastAPI, async_sessionmaker]]:
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
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(internal_orchestration.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123:assumed-role/test-engine/session"
    )

    yield app, session_factory

    asyncio.run(engine.dispose())


@pytest.fixture
def client(orchestration_app) -> TestClient:
    app, _ = orchestration_app
    return TestClient(app)


async def _seed_definition(session_factory, **overrides) -> str:
    fields = dict(
        tenant_id="default",
        name="notify sales",
        trigger_source="biffo.core",
        trigger_detail_type="demo.requested",
        action_type="email",
        action_config={"to": "sales@example.com"},
        enabled=True,
    )
    fields.update(overrides)
    async with session_factory() as session:
        definition = WorkflowDefinition(**fields)
        session.add(definition)
        await session.commit()
        return definition.id


def _seed(session_factory, **overrides) -> str:
    return asyncio.run(_seed_definition(session_factory, **overrides))


def _event_body(idempotency_key: str = "demo-1") -> dict:
    return {
        "source": "biffo.core",
        "detail_type": "demo.requested",
        "idempotency_key": idempotency_key,
        "event": {"demo_request_id": idempotency_key, "email": "lead@example.com"},
    }


def test_dispatch_returns_claimed_run(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory)

    resp = client.post(_EVENTS, json=_event_body())

    assert resp.status_code == 200
    runs = resp.json()["runs"]
    assert len(runs) == 1
    assert runs[0]["created"] is True
    assert runs[0]["action_type"] == "email"
    assert runs[0]["action_config"] == {"to": "sales@example.com"}


def test_dispatch_replay_is_idempotent(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory)

    first = client.post(_EVENTS, json=_event_body()).json()["runs"][0]
    second = client.post(_EVENTS, json=_event_body()).json()["runs"][0]

    assert first["created"] is True
    assert second["created"] is False
    assert first["run_id"] == second["run_id"]


def test_dispatch_no_match_returns_empty(client):
    resp = client.post(_EVENTS, json=_event_body())

    assert resp.status_code == 200
    assert resp.json()["runs"] == []


# #418: an accidentally-disabled definition silently drops every matching event.
# The router must turn that absence into an explicit WARNING — but only when a
# definition for the trigger actually exists (disabled/filtered out), never for
# the common "no workflow for this event" case, which would be pure log noise.
# The powertools Logger doesn't propagate to caplog, so we patch the module
# logger and assert on the call (source, detail_type, and the dropped count).


def test_dispatch_disabled_definition_warns(orchestration_app, client):
    _, session_factory = orchestration_app
    # A definition exists for this exact trigger but is disabled — the accident
    # #418 is about: the matching event is received and dropped without a run.
    _seed(session_factory, enabled=False)

    with patch("api.routers.internal_orchestration.logger") as mock_logger:
        resp = client.post(_EVENTS, json=_event_body())

    assert resp.status_code == 200
    assert resp.json()["runs"] == []  # nothing dispatched
    mock_logger.warning.assert_called_once()
    extra = mock_logger.warning.call_args.kwargs["extra"]
    assert extra["source"] == "biffo.core"
    assert extra["detail_type"] == "demo.requested"
    assert extra["definitions_not_dispatched"] == 1


def test_dispatch_no_definition_does_not_warn(client):
    # No definition for this trigger at all — the normal case for most events.
    # Silence is correct; a warning here would be noise.
    with patch("api.routers.internal_orchestration.logger") as mock_logger:
        resp = client.post(_EVENTS, json=_event_body())

    assert resp.status_code == 200
    assert resp.json()["runs"] == []
    mock_logger.warning.assert_not_called()


def test_dispatch_enabled_match_does_not_warn(orchestration_app, client):
    # Happy path: an enabled definition matches, dispatches, and stays silent.
    _, session_factory = orchestration_app
    _seed(session_factory)

    with patch("api.routers.internal_orchestration.logger") as mock_logger:
        resp = client.post(_EVENTS, json=_event_body())

    assert resp.status_code == 200
    assert len(resp.json()["runs"]) == 1
    mock_logger.warning.assert_not_called()


def test_record_result_sets_status(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory)
    run_id = client.post(_EVENTS, json=_event_body()).json()["runs"][0]["run_id"]

    resp = client.post(
        f"/api/v1/internal/orchestration/runs/{run_id}/result",
        json={
            "action_type": "email",
            "status": "succeeded",
            "response": {"message_id": "ses-123"},
        },
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "succeeded"


def test_record_result_unknown_run_is_404(client):
    resp = client.post(
        "/api/v1/internal/orchestration/runs/nope/result",
        json={"action_type": "email", "status": "failed", "error": "boom"},
    )

    assert resp.status_code == 404


def test_record_result_rejects_invalid_status(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory)
    run_id = client.post(_EVENTS, json=_event_body()).json()["runs"][0]["run_id"]

    resp = client.post(
        f"/api/v1/internal/orchestration/runs/{run_id}/result",
        json={"action_type": "email", "status": "bogus"},
    )

    assert resp.status_code == 422


# ── Scheduled workflow actions (docs/implementation/0002-scheduled-workflow-actions) ──


async def _set_enabled(session_factory, definition_id: str, enabled: bool) -> None:
    async with session_factory() as session:
        result = await session.execute(
            select(WorkflowDefinition).where(WorkflowDefinition.id == definition_id)
        )
        definition = result.scalar_one()
        definition.enabled = enabled
        await session.commit()


async def _delete_definition(session_factory, definition_id: str) -> None:
    async with session_factory() as session:
        result = await session.execute(
            select(WorkflowDefinition).where(WorkflowDefinition.id == definition_id)
        )
        await session.delete(result.scalar_one())
        await session.commit()


def test_dispatch_with_schedule_claims_run_as_scheduled(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory, schedule_config={"type": "fixed_delay", "delay_seconds": 1209600})

    resp = client.post(_EVENTS, json=_event_body())

    run = resp.json()["runs"][0]
    assert run["created"] is True
    assert run["scheduled_for"] is not None


def test_dispatch_without_schedule_has_no_scheduled_for(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory)

    resp = client.post(_EVENTS, json=_event_body())

    assert resp.json()["runs"][0]["scheduled_for"] is None


def test_fire_claims_a_scheduled_run(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory, schedule_config={"type": "fixed_delay", "delay_seconds": 60})
    run_id = client.post(_EVENTS, json=_event_body()).json()["runs"][0]["run_id"]

    resp = client.post(_fire_url(run_id))

    assert resp.status_code == 200
    body = resp.json()
    assert body["claimed"] is True
    assert body["run_id"] == run_id
    assert body["action_type"] == "email"
    assert body["action_config"] == {"to": "sales@example.com"}


def test_fire_is_not_claimed_twice(orchestration_app, client):
    _, session_factory = orchestration_app
    _seed(session_factory, schedule_config={"type": "fixed_delay", "delay_seconds": 60})
    run_id = client.post(_EVENTS, json=_event_body()).json()["runs"][0]["run_id"]

    first = client.post(_fire_url(run_id))
    second = client.post(_fire_url(run_id))

    assert first.json()["claimed"] is True
    assert second.json()["claimed"] is False


def test_fire_skips_a_disabled_definition(orchestration_app, client):
    _, session_factory = orchestration_app
    definition_id = _seed(
        session_factory, schedule_config={"type": "fixed_delay", "delay_seconds": 60}
    )
    run_id = client.post(_EVENTS, json=_event_body()).json()["runs"][0]["run_id"]
    asyncio.run(_set_enabled(session_factory, definition_id, False))

    resp = client.post(_fire_url(run_id))

    assert resp.json()["claimed"] is False


def test_fire_skips_a_deleted_definition(orchestration_app, client):
    _, session_factory = orchestration_app
    definition_id = _seed(
        session_factory, schedule_config={"type": "fixed_delay", "delay_seconds": 60}
    )
    run_id = client.post(_EVENTS, json=_event_body()).json()["runs"][0]["run_id"]
    asyncio.run(_delete_definition(session_factory, definition_id))

    resp = client.post(_fire_url(run_id))

    assert resp.json()["claimed"] is False


def test_fire_unknown_run_is_not_claimed(client):
    resp = client.post(_fire_url("nope"))

    assert resp.status_code == 200
    assert resp.json()["claimed"] is False
