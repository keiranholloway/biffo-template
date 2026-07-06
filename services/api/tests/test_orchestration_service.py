"""Unit tests for the orchestration domain logic (api/orchestration.py).

Exercised directly against an in-memory SQLite session — no HTTP. Covers the two
behaviours the wedge depends on: matching + idempotent claim (dispatch_event),
and outcome recording (record_result).
"""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from api import orchestration as svc
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    WorkflowDefinition,
    WorkflowRun,
)


@pytest.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session

    await engine.dispose()


async def _make_definition(session, **overrides) -> WorkflowDefinition:
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
    definition = WorkflowDefinition(**fields)
    session.add(definition)
    await session.flush()
    return definition


async def _count(session, model) -> int:
    result = await session.execute(select(func.count()).select_from(model))
    return result.scalar_one()


async def test_dispatch_claims_one_run_per_matching_definition(db_session):
    await _make_definition(db_session, name="a")
    await _make_definition(db_session, name="b", action_config={"to": "ops@x"})

    claimed = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={"demo_request_id": "demo-1"},
    )

    assert len(claimed) == 2
    assert all(c.created for c in claimed)
    assert all(c.action_type == "email" for c in claimed)
    assert await _count(db_session, WorkflowRun) == 2


async def test_dispatch_is_idempotent_on_replay(db_session):
    await _make_definition(db_session)

    first = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={"demo_request_id": "demo-1"},
    )
    second = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={"demo_request_id": "demo-1"},
    )

    assert first[0].created is True
    assert second[0].created is False
    # Same run, claimed once.
    assert first[0].run_id == second[0].run_id
    assert await _count(db_session, WorkflowRun) == 1


async def test_dispatch_ignores_disabled_and_mismatched(db_session):
    await _make_definition(db_session, name="disabled", enabled=False)
    await _make_definition(
        db_session, name="other-event", trigger_detail_type="lead.captured"
    )
    await _make_definition(
        db_session, name="other-source", trigger_source="other.system"
    )

    claimed = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )

    assert claimed == []
    assert await _count(db_session, WorkflowRun) == 0


async def test_dispatch_is_tenant_scoped(db_session):
    await _make_definition(db_session, tenant_id="other-tenant")

    claimed = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )

    assert claimed == []


async def test_record_result_updates_run_and_writes_log(db_session):
    definition = await _make_definition(db_session)
    [claimed] = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )

    run = await svc.record_result(
        db_session,
        tenant_id="default",
        run_id=claimed.run_id,
        action_type="email",
        status="succeeded",
        request={"to": "sales@example.com"},
        response={"message_id": "ses-123"},
    )

    assert run is not None
    assert run.status == "succeeded"
    assert run.definition_id == definition.id
    assert await _count(db_session, ActionLog) == 1
    log = (await db_session.execute(select(ActionLog))).scalar_one()
    assert log.run_id == claimed.run_id
    assert log.status == "succeeded"
    assert log.response == {"message_id": "ses-123"}


async def test_record_result_unknown_run_returns_none(db_session):
    run = await svc.record_result(
        db_session,
        tenant_id="default",
        run_id="does-not-exist",
        action_type="email",
        status="failed",
        error="boom",
    )

    assert run is None
    assert await _count(db_session, ActionLog) == 0
