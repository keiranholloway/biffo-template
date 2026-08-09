"""Unit tests for the orchestration domain logic (api/orchestration.py).

Exercised directly against an in-memory SQLite session — no HTTP. Covers the two
behaviours the wedge depends on: matching + idempotent claim (dispatch_event),
and outcome recording (record_result).
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from api import orchestration as svc
from api import scope_resolvers as sr
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    WorkflowDefinition,
    WorkflowRun,
)
from api.run_observers import RunOutcome
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


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
    await _make_definition(db_session, name="other-event", trigger_detail_type="lead.captured")
    await _make_definition(db_session, name="other-source", trigger_source="other.system")

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


async def test_dispatch_honors_trigger_filter(db_session):
    # Two definitions on the same coarse (source, detail_type); a payload filter
    # refines each so only the one whose predicate matches claims a run (#226).
    await _make_definition(
        db_session,
        name="won-only",
        trigger_detail_type="leads.updated",
        trigger_filter={"status": "won"},
    )
    await _make_definition(
        db_session,
        name="lost-only",
        trigger_detail_type="leads.updated",
        trigger_filter={"status": "lost"},
    )

    claimed = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="leads.updated",
        idempotency_key="lead-1",
        event={"id": "lead-1", "status": "won"},
    )

    assert len(claimed) == 1
    assert claimed[0].created is True
    assert await _count(db_session, WorkflowRun) == 1


async def test_dispatch_empty_filter_matches_every_event(db_session):
    # A None/empty filter is the wildcard: the definition fires regardless of
    # payload — the default behaviour for triggers that don't need refining.
    await _make_definition(db_session, trigger_detail_type="leads.updated", trigger_filter=None)

    claimed = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="leads.updated",
        idempotency_key="lead-1",
        event={"id": "lead-1", "status": "anything"},
    )

    assert len(claimed) == 1


async def test_dispatch_filter_miss_claims_nothing(db_session):
    await _make_definition(
        db_session,
        trigger_detail_type="leads.updated",
        trigger_filter={"status": "won"},
    )

    claimed = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="leads.updated",
        idempotency_key="lead-1",
        event={"id": "lead-1", "status": "open"},
    )

    assert claimed == []
    assert await _count(db_session, WorkflowRun) == 0


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


async def test_record_result_notifies_observers_with_the_triggering_payload(db_session):
    """The seam an instance builds its domain record on (run_observers.py).

    Asserted from the real service call rather than the registry in isolation,
    because the thing being promised is that ``trigger_event`` is still in hand
    at outcome time — that is what lets an observer say which record the send
    concerned.
    """
    from api.run_observers import (
        clear_run_outcome_observers,
        register_run_outcome_observer,
    )

    seen: list[dict] = []
    clear_run_outcome_observers()
    register_run_outcome_observer(
        lambda ctx, db: seen.append(
            {
                "lead_id": ctx.trigger_payload.get("lead_id"),
                "action_type": ctx.action_type,
                "succeeded": ctx.succeeded,
                "same_session": db is db_session,
            }
        )
    )
    try:
        await _make_definition(db_session)
        [claimed] = await svc.dispatch_event(
            db_session,
            tenant_id="default",
            source="biffo.core",
            detail_type="demo.requested",
            idempotency_key="demo-observed",
            event={"payload": {"lead_id": "lead-42"}},
        )

        await svc.record_result(
            db_session,
            tenant_id="default",
            run_id=claimed.run_id,
            action_type="email",
            status="succeeded",
            response={"message_id": "ses-9"},
        )
    finally:
        clear_run_outcome_observers()

    assert seen == [
        {
            "lead_id": "lead-42",
            "action_type": "email",
            "succeeded": True,
            "same_session": True,
        }
    ]


async def test_record_result_survives_a_broken_observer(db_session):
    """A bookkeeping fault must not turn a delivered message into a 500."""
    from api.run_observers import (
        clear_run_outcome_observers,
        register_run_outcome_observer,
    )

    clear_run_outcome_observers()

    @register_run_outcome_observer
    def _boom(ctx, db):
        raise RuntimeError("observer is broken")

    try:
        await _make_definition(db_session)
        [claimed] = await svc.dispatch_event(
            db_session,
            tenant_id="default",
            source="biffo.core",
            detail_type="demo.requested",
            idempotency_key="demo-broken-observer",
            event={},
        )

        run = await svc.record_result(
            db_session,
            tenant_id="default",
            run_id=claimed.run_id,
            action_type="email",
            status="succeeded",
        )
    finally:
        clear_run_outcome_observers()

    assert run is not None
    assert run.status == "succeeded"
    assert await _count(db_session, ActionLog) == 1


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


async def test_run_outcome_reads_the_payload_the_producer_actually_stored(db_session):
    """The contract between dispatch_event and the observer seam, in one test.

    This exists because both sides were unit-tested in isolation and still
    disagreed: ``RunOutcome.trigger_payload`` unwrapped a ``payload`` key that
    ``dispatch_event`` never writes, so it returned ``{}`` for every real run
    while ten tests on either side passed (tabsii-platform#301). Neither suite
    could catch it, because each built its own fixture from the same assumption.

    So this one does not construct a ``trigger_event`` at all — it dispatches an
    event, reads the run back out of the database, and hands the stored value to
    the consumer. If the two ever drift again, this fails.
    """
    await _make_definition(db_session)
    await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={"lead_id": "lead-1", "email": "a@example.com"},
    )

    stored = (await db_session.execute(select(WorkflowRun))).scalars().one()
    outcome = RunOutcome(
        run=stored,
        action_type="email",
        status="succeeded",
        trigger_event=stored.trigger_event,
        request=None,
        response=None,
        error=None,
    )

    assert outcome.trigger_payload == {"lead_id": "lead-1", "email": "a@example.com"}


# ── Hierarchy-scoped dispatch (#616) ─────────────────────────────────────────
#
# `scope_matches_chain` is proven exhaustively as a pure function in
# test_scope_resolvers.py. That is not the same thing as proving the engine
# *uses* it: a refactor that dropped the `resolve_scope_chain` /
# `scope_matches_chain` calls out of `dispatch_event` would leave every one of
# those unit tests green while every scoped workflow in the estate silently
# fired for every brand. These tests drive the same behaviour through
# `dispatch_event` — the path production actually takes — and assert on claimed
# runs and rows in the database, not on the resolver's return value.
#
# The claim under test (docs/implementation/0003-hierarchy-scoped-workflows):
# a brand-scoped workflow fires for its own brand's unit event and does NOT
# fire for a sibling brand's.

# Stands in for the instance-owned hierarchy lookup a real resolver performs
# against its own tables (tabsii's brand/region/unit). The template deliberately
# owns no such tables — the levels are opaque strings here, exactly as in
# `scope_resolvers.py`.
_HIERARCHY: dict[str, dict[str, str | None]] = {
    "unit-alpha-1": {"brand": "brand-alpha", "region": "region-north", "unit": "unit-alpha-1"},
    "unit-alpha-2": {"brand": "brand-alpha", "region": "region-south", "unit": "unit-alpha-2"},
    # Sibling brand: a different brand entirely, under no shared ancestor.
    "unit-beta-1": {"brand": "brand-beta", "region": "region-east", "unit": "unit-beta-1"},
}


@pytest.fixture
def resolver_calls():
    """Register a brand/region/unit resolver for the duration of one test and
    yield the list of sessions it was called with.

    The registry is a single module-global pair (an instance has exactly one
    hierarchy shape), so it is saved and restored around every test — the same
    discipline test_scope_resolvers.py uses, and necessary here because a real
    instance registers its own resolver at import time and would otherwise be
    clobbered for the rest of the process.

    Recording the sessions is deliberate: it proves `dispatch_event` threads its
    own `AsyncSession` into the resolver (a real resolver needs it to look up a
    unit's region/brand) and that the chain is resolved once per event, not once
    per candidate definition.
    """
    calls: list[AsyncSession] = []

    async def resolver(
        db: AsyncSession, source: str, detail_type: str, payload: dict[str, Any]
    ) -> dict[str, str | None]:
        calls.append(db)
        unit_id = payload.get("unit_id")
        known = _HIERARCHY.get(unit_id) if unit_id is not None else None
        if known is None:
            return {"brand": payload.get("brand_id"), "region": None, "unit": unit_id}
        return dict(known)

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr.register_scope_resolver(resolver, levels=("brand", "region", "unit"))
    yield calls
    sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


async def _onboard_unit(db_session, unit_id: str, *, idempotency_key: str | None = None):
    """Dispatch a unit-level event exactly as the engine would — the payload
    carries only the unit's own id, so every coarser level in the chain comes
    from the resolver, not from the event."""
    return await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="unit.onboarded",
        idempotency_key=idempotency_key or f"onboard-{unit_id}",
        event={"unit_id": unit_id},
    )


async def test_dispatch_fires_a_brand_scoped_definition_for_its_own_unit(
    db_session, resolver_calls
):
    """(a) A Brand-scoped workflow fires for a unit event under that brand,
    even though the event names no brand — the resolver supplies it."""
    definition = await _make_definition(
        db_session,
        name="alpha welcome",
        trigger_detail_type="unit.onboarded",
        scope={"level": "brand", "id": "brand-alpha"},
    )

    claimed = await _onboard_unit(db_session, "unit-alpha-1")

    assert [c.definition_id for c in claimed] == [definition.id]
    assert claimed[0].created is True
    assert await _count(db_session, WorkflowRun) == 1
    # The chain came from the registered resolver, called with dispatch's own
    # session — not inferred from the payload by dispatch_event itself.
    assert resolver_calls == [db_session]


async def test_dispatch_does_not_fire_a_brand_scoped_definition_for_a_sibling_brand(
    db_session, resolver_calls
):
    """(b) The assertion the whole feature rests on: the *same* definition,
    the *same* trigger, a unit belonging to a different brand — no run, and
    nothing written to the database."""
    await _make_definition(
        db_session,
        name="alpha welcome",
        trigger_detail_type="unit.onboarded",
        scope={"level": "brand", "id": "brand-alpha"},
    )

    claimed = await _onboard_unit(db_session, "unit-beta-1")

    assert claimed == []
    assert await _count(db_session, WorkflowRun) == 0
    assert resolver_calls == [db_session]


async def test_dispatch_routes_a_unit_event_to_only_its_own_brands_definition(
    db_session, resolver_calls
):
    """Both brands' workflows and an unscoped one exist side by side on the
    same trigger. One event must claim exactly two of the three: its own
    brand's, and the tenant-wide one."""
    alpha = await _make_definition(
        db_session,
        name="alpha welcome",
        trigger_detail_type="unit.onboarded",
        scope={"level": "brand", "id": "brand-alpha"},
    )
    beta = await _make_definition(
        db_session,
        name="beta welcome",
        trigger_detail_type="unit.onboarded",
        scope={"level": "brand", "id": "brand-beta"},
    )
    tenant_wide = await _make_definition(
        db_session,
        name="tenant wide audit",
        trigger_detail_type="unit.onboarded",
        scope=None,
    )

    claimed = await _onboard_unit(db_session, "unit-alpha-1")

    assert {c.definition_id for c in claimed} == {alpha.id, tenant_wide.id}
    assert beta.id not in {c.definition_id for c in claimed}
    assert await _count(db_session, WorkflowRun) == 2
    # Resolved once for the event, not once per candidate definition.
    assert len(resolver_calls) == 1


async def test_dispatch_brand_scope_covers_every_region_beneath_it(db_session, resolver_calls):
    """ "A higher level covers everything beneath it": the same brand-scoped
    definition fires for two units in two different regions of that brand."""
    await _make_definition(
        db_session,
        name="alpha welcome",
        trigger_detail_type="unit.onboarded",
        scope={"level": "brand", "id": "brand-alpha"},
    )

    first = await _onboard_unit(db_session, "unit-alpha-1")
    second = await _onboard_unit(db_session, "unit-alpha-2")

    assert len(first) == 1
    assert len(second) == 1
    # Distinct events, distinct runs — not an idempotent re-claim of one run.
    assert first[0].run_id != second[0].run_id
    assert await _count(db_session, WorkflowRun) == 2


async def test_dispatch_region_scoped_definition_ignores_a_sibling_region(
    db_session, resolver_calls
):
    """The same containment rule one level down: a Region-scoped definition
    fires for its own region's unit and not for another region of the *same*
    brand — so matching is genuinely per-level, not "same brand wins"."""
    await _make_definition(
        db_session,
        name="north only",
        trigger_detail_type="unit.onboarded",
        scope={"level": "region", "id": "region-north"},
    )

    fired = await _onboard_unit(db_session, "unit-alpha-1")  # region-north
    not_fired = await _onboard_unit(db_session, "unit-alpha-2")  # region-south, same brand

    assert len(fired) == 1
    assert not_fired == []
    assert await _count(db_session, WorkflowRun) == 1


async def test_dispatch_scoped_definition_is_still_tenant_scoped(db_session, resolver_calls):
    """(c) Scope refines tenancy, it never widens it: a definition whose scope
    matches the event perfectly still does not fire across a tenant boundary
    (ADR-0001)."""
    await _make_definition(
        db_session,
        tenant_id="other-tenant",
        name="other tenant alpha welcome",
        trigger_detail_type="unit.onboarded",
        scope={"level": "brand", "id": "brand-alpha"},
    )

    claimed = await _onboard_unit(db_session, "unit-alpha-1")

    assert claimed == []
    assert await _count(db_session, WorkflowRun) == 0


async def test_dispatch_does_not_resolve_a_chain_when_nothing_is_scoped(db_session, resolver_calls):
    """Unscoped definitions keep today's behaviour and cost nothing: the
    resolver (potentially a database round-trip) is never invoked."""
    await _make_definition(db_session, trigger_detail_type="unit.onboarded", scope=None)

    claimed = await _onboard_unit(db_session, "unit-alpha-1")

    assert len(claimed) == 1
    assert resolver_calls == []


# ── Recurring, payload-less triggers actually fire more than once
# (tabsii-platform#808) ───────────────────────────────────────────────────────


async def test_dispatch_recurring_payload_less_trigger_claims_a_run_every_occurrence(db_session):
    """The guard for #808's own shape at the service layer.

    `dispatch_event` itself never computed the idempotency_key — that always
    lived in the orchestrator plugin's `_idempotency_key` — so this doesn't
    reproduce the historical bug (a content hash of "nothing" colliding
    forever), only the contract the fix depends on: when the caller supplies a
    *different* idempotency_key per firing of the same (source, detail_type)
    with an empty payload — exactly what the fixed plugin now does for
    `orchestrator.tick` — dispatch keeps creating fresh runs rather than ever
    reusing the first one bound to that trigger.
    """
    await _make_definition(
        db_session, trigger_source="biffo.orchestrator", trigger_detail_type="orchestrator.tick"
    )

    fired = []
    for occurrence in range(5):
        [claimed] = await svc.dispatch_event(
            db_session,
            tenant_id="default",
            source="biffo.orchestrator",
            detail_type="orchestrator.tick",
            idempotency_key=f"orchestrator.tick:occurrence-{occurrence}",
            event={},
        )
        fired.append(claimed)

    assert all(c.created for c in fired)
    assert len({c.run_id for c in fired}) == 5
    assert await _count(db_session, WorkflowRun) == 5


# ── Stale-run sweep (tabsii-platform#808, mirrors agent_runs.reap_stale_runs) ─


async def _age(session, run: WorkflowRun, *, seconds_ago: int) -> None:
    run.updated_at = datetime.now(UTC) - timedelta(seconds=seconds_ago)
    await session.flush()


async def test_reap_fails_a_pending_run_past_the_threshold(db_session):
    await _make_definition(db_session)
    [claimed] = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )
    run = (
        await db_session.execute(select(WorkflowRun).where(WorkflowRun.id == claimed.run_id))
    ).scalar_one()
    await _age(db_session, run, seconds_ago=2000)

    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)

    assert [r.id for r in reaped] == [claimed.run_id]
    assert reaped[0].status == "failed"
    log = (await db_session.execute(select(ActionLog))).scalar_one()
    assert log.run_id == claimed.run_id
    assert log.status == "failed"
    assert "Reaped" in log.error


async def test_reap_leaves_a_fresh_pending_run_alone(db_session):
    await _make_definition(db_session)
    await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )

    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)

    assert reaped == []
    run = (await db_session.execute(select(WorkflowRun))).scalar_one()
    assert run.status == "pending"


async def test_reap_ignores_a_scheduled_run_no_matter_how_old(db_session):
    """A `scheduled` run may legitimately wait days or weeks
    (docs/implementation/0002-scheduled-workflow-actions) — being old is its
    normal state, not evidence of abandonment, so the sweep must not touch it."""
    definition = await _make_definition(
        db_session, schedule_config={"type": "fixed_delay", "delay_seconds": 3600}
    )
    [claimed] = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )
    run = (
        await db_session.execute(select(WorkflowRun).where(WorkflowRun.id == claimed.run_id))
    ).scalar_one()
    assert run.status == "scheduled"
    await _age(db_session, run, seconds_ago=10_000_000)  # weeks old

    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)

    assert reaped == []
    await db_session.refresh(run)
    assert run.status == "scheduled"
    assert definition.schedule_config is not None  # sanity: still the delayed definition


async def test_reap_fails_a_dispatching_run_aged_from_its_own_transition(db_session):
    """`fire_scheduled_run`'s conditional UPDATE now stamps `updated_at`
    explicitly (a raw Core-style UPDATE bypasses the column's `onupdate`) —
    this proves the reaper actually uses that stamp: a run created long ago as
    `scheduled` but only just claimed into `dispatching` must NOT be reaped,
    and one that has sat in `dispatching` past the threshold must be."""
    await _make_definition(db_session, schedule_config={"type": "fixed_delay", "delay_seconds": 1})
    [claimed] = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )
    run = (
        await db_session.execute(select(WorkflowRun).where(WorkflowRun.id == claimed.run_id))
    ).scalar_one()
    # Backdate creation deep into the past — if the reaper used created_at
    # instead of updated_at, this alone would make it look stale.
    run.created_at = datetime.now(UTC) - timedelta(days=30)
    await db_session.flush()

    fired = await svc.fire_scheduled_run(db_session, tenant_id="default", run_id=claimed.run_id)
    assert fired is not None
    await db_session.refresh(run)
    assert run.status == "dispatching"

    # Just claimed — nowhere near stale by its real (updated_at) age.
    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)
    assert reaped == []

    # Age the *transition*, not the creation, then it is reaped.
    await _age(db_session, run, seconds_ago=2000)
    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)
    assert [r.id for r in reaped] == [claimed.run_id]
    assert reaped[0].status == "failed"


async def test_reap_does_not_overwrite_a_result_that_lands_first(db_session):
    """The race precedent from `_claim_run`/`fire_scheduled_run`: the reaper's
    SELECT is a snapshot, so a genuine result recorded between that read and
    its conditional UPDATE must win — the reap must not clobber it."""
    await _make_definition(db_session)
    [claimed] = await svc.dispatch_event(
        db_session,
        tenant_id="default",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )
    run = (
        await db_session.execute(select(WorkflowRun).where(WorkflowRun.id == claimed.run_id))
    ).scalar_one()
    await _age(db_session, run, seconds_ago=2000)

    # The real result lands first.
    await svc.record_result(
        db_session,
        tenant_id="default",
        run_id=claimed.run_id,
        action_type="email",
        status="succeeded",
        response={"message_id": "ses-1"},
    )

    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)

    assert reaped == []
    await db_session.refresh(run)
    assert run.status == "succeeded"


async def test_reap_is_tenant_scoped(db_session):
    await _make_definition(db_session, tenant_id="other-tenant")
    [claimed] = await svc.dispatch_event(
        db_session,
        tenant_id="other-tenant",
        source="biffo.core",
        detail_type="demo.requested",
        idempotency_key="demo-1",
        event={},
    )
    run = (
        await db_session.execute(select(WorkflowRun).where(WorkflowRun.id == claimed.run_id))
    ).scalar_one()
    await _age(db_session, run, seconds_ago=2000)

    reaped = await svc.reap_stale_runs(db_session, tenant_id="default", stale_after_seconds=1800)

    assert reaped == []
