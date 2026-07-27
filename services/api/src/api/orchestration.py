"""Orchestration domain logic (transport-agnostic).

Pure async functions over an ``AsyncSession`` that the internal orchestration
router (ADR-0009) exposes to the engine, and that a future editing UI or tests
can call directly. All queries are tenant-scoped (ADR-0001).

The engine flow is two steps:

1. ``dispatch_event`` — given an incoming event, find the enabled definitions
   that match its (source, detail_type) and **idempotently claim** one run per
   definition. A replayed event re-claims the same runs (``created=False``) so
   the engine never fires an action twice.
2. ``record_result`` — write the outcome of an action to the audit log and move
   the run to its terminal state.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from aws_lambda_powertools import Logger
from sqlalchemy import CursorResult, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .events.emit import is_declared
from .models.orchestration import (
    ActionLog,
    TriggerCatalog,
    WorkflowDefinition,
    WorkflowRun,
)
from .scope_resolvers import resolve_scope_chain, scope_matches_chain

logger = Logger()


@dataclass(frozen=True)
class ClaimedRun:
    """A run the engine should act on (or skip when it was already claimed)."""

    run_id: str
    definition_id: str
    action_type: str
    action_config: dict[str, Any]
    created: bool
    # Set when the claiming definition carries a ``schedule_config`` — the
    # engine must create a future one-time schedule for this instant rather
    # than execute now (docs/implementation/0002-scheduled-workflow-actions).
    scheduled_for: datetime | None = None
    # Only populated by ``fire_scheduled_run``: the *original* triggering
    # event's payload, stored on the run at claim time. The immediate-dispatch
    # path doesn't need this — the engine already holds the live event it just
    # received — but the fire-time callback has nothing but a ``run_id`` days
    # or weeks later, and template rendering (``{field}`` in subject/body/to)
    # needs the same payload the trigger originally carried.
    trigger_event: dict[str, Any] | None = None


def _scheduled_for(schedule_config: dict[str, Any] | None) -> datetime | None:
    """The UTC instant a definition's delay resolves to, or ``None`` for
    immediate dispatch. Only ``fixed_delay`` exists today (validated at
    authoring time in ``schemas.orchestration._validate_schedule_config``)."""
    if schedule_config is None:
        return None
    delay_seconds = schedule_config["delay_seconds"]
    return datetime.now(UTC) + timedelta(seconds=delay_seconds)


def _dedupe_key(definition_id: str, idempotency_key: str) -> str:
    """One run per (definition, event). Scoping the key by definition lets two
    definitions triggered by the same event each run exactly once."""
    return f"{definition_id}:{idempotency_key}"


async def _claim_run(
    db: AsyncSession,
    *,
    tenant_id: str,
    definition: WorkflowDefinition,
    idempotency_key: str,
    event: dict[str, Any],
) -> ClaimedRun:
    """Create-or-get a run for (definition, event), atomically.

    Inserts inside a SAVEPOINT so a duplicate (unique ``dedupe_key``) rolls back
    only the insert, not the caller's transaction; the existing run is then
    fetched and returned with ``created=False``.
    """
    dedupe_key = _dedupe_key(definition.id, idempotency_key)
    scheduled_for = _scheduled_for(definition.schedule_config)
    run = WorkflowRun(
        tenant_id=tenant_id,
        definition_id=definition.id,
        dedupe_key=dedupe_key,
        trigger_event=event,
        status="scheduled" if scheduled_for is not None else "pending",
        scheduled_for=scheduled_for,
    )
    try:
        async with db.begin_nested():
            db.add(run)
            await db.flush()
    except IntegrityError:
        existing = await db.execute(
            select(WorkflowRun).where(
                WorkflowRun.tenant_id == tenant_id,
                WorkflowRun.dedupe_key == dedupe_key,
            )
        )
        run = existing.scalar_one()
        return ClaimedRun(
            run_id=run.id,
            definition_id=definition.id,
            action_type=definition.action_type,
            action_config=definition.action_config,
            created=False,
            scheduled_for=run.scheduled_for,
        )
    return ClaimedRun(
        run_id=run.id,
        definition_id=definition.id,
        action_type=definition.action_type,
        action_config=definition.action_config,
        created=True,
        scheduled_for=run.scheduled_for,
    )


async def dispatch_event(
    db: AsyncSession,
    *,
    tenant_id: str,
    source: str,
    detail_type: str,
    idempotency_key: str,
    event: dict[str, Any],
) -> list[ClaimedRun]:
    """Match an event to enabled definitions and claim one run per match."""
    # Record the event type so the builder can offer it as a trigger even if the
    # code registry doesn't name it (self-building catalog, ADR-0010). Best-effort
    # and isolated in a SAVEPOINT so it never disturbs the dispatch itself.
    await observe_trigger(db, tenant_id=tenant_id, source=source, detail_type=detail_type)

    result = await db.execute(
        select(WorkflowDefinition).where(
            WorkflowDefinition.tenant_id == tenant_id,
            WorkflowDefinition.trigger_source == source,
            WorkflowDefinition.trigger_detail_type == detail_type,
            WorkflowDefinition.enabled.is_(True),
        )
    )
    definitions = list(result.scalars().all())

    # Resolved lazily and cached: most events match no scoped definition at
    # all (Phase 1 ships with nothing scoped yet), so paying for a resolver
    # call — potentially a database lookup, e.g. a unit's region/brand — only
    # when a candidate definition actually carries a `scope` keeps the common
    # case free. The chain is the same for every definition once computed
    # (docs/implementation/0003-hierarchy-scoped-workflows).
    scope_chain: Mapping[str, str | None] | None = None

    claimed: list[ClaimedRun] = []
    for definition in definitions:
        # An optional payload filter refines a coarse (source, detail_type) match —
        # e.g. leads.updated only when status == "won" (#226). No filter → always.
        if not _matches_trigger_filter(definition.trigger_filter, event):
            continue
        if definition.scope is not None:
            if scope_chain is None:
                scope_chain = await resolve_scope_chain(db, source, detail_type, event)
            if not scope_matches_chain(definition.scope, scope_chain):
                continue
        claimed.append(
            await _claim_run(
                db,
                tenant_id=tenant_id,
                definition=definition,
                idempotency_key=idempotency_key,
                event=event,
            )
        )
    return claimed


async def fire_scheduled_run(db: AsyncSession, *, tenant_id: str, run_id: str) -> ClaimedRun | None:
    """Atomically claim a scheduled run for execution at its fire time.

    Guards EventBridge Scheduler's at-least-once delivery: a conditional UPDATE
    only transitions a run still ``"scheduled"`` to ``"dispatching"`` — a
    second (duplicate) callback for the same run sees ``rowcount == 0`` and
    backs off, exactly like ``_claim_run``'s SAVEPOINT guards a replayed event,
    but as a row-count check rather than a unique-constraint race (there is
    only one row to win here, not an insert that might collide).

    Also re-checks the owning definition is still enabled and not deleted —
    it may have been claimed weeks earlier, so "valid at claim time" cannot be
    assumed valid now. Returns ``None`` when there is nothing to execute: the
    run already fired, or the definition was disabled/deleted since (the run
    is marked ``"skipped"`` in that case, not left stuck on ``"dispatching"``).
    """
    # CursorResult, not Result: `rowcount` is only defined for DML, and it is
    # the entire verdict here (see agent_runs.claim_run for the same pattern) —
    # the cast asserts what the statement is, not a nuisance silence.
    updated = cast(
        CursorResult[Any],
        await db.execute(
            update(WorkflowRun)
            .where(
                WorkflowRun.tenant_id == tenant_id,
                WorkflowRun.id == run_id,
                WorkflowRun.status == "scheduled",
            )
            .values(status="dispatching")
        ),
    )
    if updated.rowcount != 1:
        return None

    result = await db.execute(
        select(WorkflowRun).where(
            WorkflowRun.tenant_id == tenant_id,
            WorkflowRun.id == run_id,
        )
    )
    run = result.scalar_one()

    definition = await get_definition(db, tenant_id=tenant_id, definition_id=run.definition_id)
    if definition is None or not definition.enabled:
        run.status = "skipped"
        await db.flush()
        return None

    return ClaimedRun(
        run_id=run.id,
        definition_id=run.definition_id,
        action_type=definition.action_type,
        action_config=definition.action_config,
        created=True,
        scheduled_for=run.scheduled_for,
        trigger_event=run.trigger_event,
    )


def _matches_trigger_filter(trigger_filter: dict[str, Any] | None, event: dict[str, Any]) -> bool:
    """A definition's ``trigger_filter`` (reserved JSON column, #226) is an all-of
    exact-match predicate over the event payload: ``{"field": value}`` fires the
    workflow only when the payload's ``field`` equals ``value``. An empty/None
    filter matches every event — this is how ``leads.updated`` becomes a precise
    trigger (e.g. reached a stage / became listed) without a new event type."""
    if not trigger_filter:
        return True
    return all(event.get(key) == expected for key, expected in trigger_filter.items())


async def observe_trigger(
    db: AsyncSession, *, tenant_id: str, source: str, detail_type: str
) -> None:
    """Upsert an observed (source, detail_type) into the trigger catalog.

    Insert-if-new (touch ``last_seen`` otherwise), the insert isolated in a
    SAVEPOINT so a concurrent duplicate rolls back only the insert — mirroring
    ``_claim_run`` — and never poisons the caller's transaction.

    Compliance monitor (ADR-0002/#222): every event should be defined in code, so
    an observed event that isn't declared is an anomaly — log it. It's still
    recorded so the anomaly is visible in the catalog rather than hidden.
    """
    if not is_declared(source, detail_type):
        logger.warning(
            "Observed an undeclared event on the bus (not defined in code)",
            extra={"source": source, "detail_type": detail_type},
        )
    touch = (
        update(TriggerCatalog)
        .where(
            TriggerCatalog.tenant_id == tenant_id,
            TriggerCatalog.source == source,
            TriggerCatalog.detail_type == detail_type,
        )
        .values(updated_at=func.now())
    )
    exists = await db.execute(
        select(TriggerCatalog.id).where(
            TriggerCatalog.tenant_id == tenant_id,
            TriggerCatalog.source == source,
            TriggerCatalog.detail_type == detail_type,
        )
    )
    if exists.scalar_one_or_none() is not None:
        await db.execute(touch)
        return
    try:
        async with db.begin_nested():
            db.add(TriggerCatalog(tenant_id=tenant_id, source=source, detail_type=detail_type))
            await db.flush()
    except IntegrityError:
        await db.execute(touch)  # lost an insert race — the row now exists


async def list_observed_triggers(db: AsyncSession, *, tenant_id: str) -> list[TriggerCatalog]:
    """Every event type this tenant has been seen dispatching, newest-seen first."""
    result = await db.execute(
        select(TriggerCatalog)
        .where(TriggerCatalog.tenant_id == tenant_id)
        .order_by(TriggerCatalog.updated_at.desc())
    )
    return list(result.scalars().all())


async def is_known_trigger(
    db: AsyncSession, *, tenant_id: str, source: str, detail_type: str
) -> bool:
    """Whether (source, detail_type) is a declared (registry) or observed trigger.

    The builder restricts picks to known events; a declared event is valid for
    every tenant, an observed one only for the tenant that has seen it.
    """
    if is_declared(source, detail_type):
        return True
    result = await db.execute(
        select(TriggerCatalog.id).where(
            TriggerCatalog.tenant_id == tenant_id,
            TriggerCatalog.source == source,
            TriggerCatalog.detail_type == detail_type,
        )
    )
    return result.scalar_one_or_none() is not None


async def record_result(
    db: AsyncSession,
    *,
    tenant_id: str,
    run_id: str,
    action_type: str,
    status: str,
    request: dict[str, Any] | None = None,
    response: dict[str, Any] | None = None,
    error: str | None = None,
) -> WorkflowRun | None:
    """Record an action outcome to the audit log and set the run's terminal state.

    Returns the updated run, or ``None`` if no such run exists for this tenant
    (the router maps that to 404).
    """
    result = await db.execute(
        select(WorkflowRun).where(
            WorkflowRun.tenant_id == tenant_id,
            WorkflowRun.id == run_id,
        )
    )
    run = result.scalar_one_or_none()
    if run is None:
        return None

    run.status = status
    db.add(
        ActionLog(
            tenant_id=tenant_id,
            run_id=run_id,
            action_type=action_type,
            status=status,
            request=request,
            response=response,
            error=error,
        )
    )
    await db.flush()
    # onupdate/server_default columns (updated_at) are expired after the flush;
    # refresh within the async context so response serialization (which runs
    # sync in a threadpool) doesn't trigger lazy IO — MissingGreenlet otherwise.
    await db.refresh(run)
    return run


# ── Run history (user-facing, read-only) ─────────────────────────────────────


@dataclass(frozen=True)
class RunWithLogs:
    """A run, its definition's name, and the action outcomes recorded for it."""

    run: WorkflowRun
    definition_name: str | None
    logs: list[ActionLog]


async def list_runs(
    db: AsyncSession,
    *,
    tenant_id: str,
    definition_id: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> list[RunWithLogs]:
    """Most-recent-first run history, each run carrying its action log.

    The definition name is **outer**-joined: a run whose definition was since
    deleted still appears, because the run is the audit record of what fired and
    outlives the rule that caused it.
    """
    query = (
        select(WorkflowRun, WorkflowDefinition.name)
        .outerjoin(
            WorkflowDefinition,
            (WorkflowDefinition.id == WorkflowRun.definition_id)
            & (WorkflowDefinition.tenant_id == WorkflowRun.tenant_id),
        )
        .where(WorkflowRun.tenant_id == tenant_id)
        # id breaks ties: created_at has second granularity on some backends, and
        # two runs claimed from one event share it.
        .order_by(WorkflowRun.created_at.desc(), WorkflowRun.id.desc())
        .limit(limit)
    )
    if definition_id is not None:
        query = query.where(WorkflowRun.definition_id == definition_id)
    if status is not None:
        query = query.where(WorkflowRun.status == status)

    rows = list((await db.execute(query)).all())

    # One follow-up query for every log on the page, rather than one per run.
    logs_by_run: dict[str, list[ActionLog]] = {}
    run_ids = [run.id for run, _ in rows]
    if run_ids:
        result = await db.execute(
            select(ActionLog)
            .where(ActionLog.tenant_id == tenant_id, ActionLog.run_id.in_(run_ids))
            .order_by(ActionLog.created_at)
        )
        for log in result.scalars().all():
            logs_by_run.setdefault(log.run_id, []).append(log)

    return [
        RunWithLogs(run=run, definition_name=name, logs=logs_by_run.get(run.id, []))
        for run, name in rows
    ]


# ── Workflow-definition CRUD (user-facing, the portal builder) ───────────────
# All tenant-scoped (ADR-0001). Each returns the ORM row after refreshing so the
# response_model can serialize server-default columns without lazy IO.


async def list_definitions(db: AsyncSession, *, tenant_id: str) -> list[WorkflowDefinition]:
    result = await db.execute(
        select(WorkflowDefinition)
        .where(WorkflowDefinition.tenant_id == tenant_id)
        .order_by(WorkflowDefinition.created_at)
    )
    return list(result.scalars().all())


#: The ``action_type`` that binds a trigger to an agentic worker (ADR-0014 §4).
#: The value the workflow builder's "Run an agent" action stores (see
#: ``schemas.orchestration.WORKFLOW_ACTIONS``).
AGENT_ACTION_TYPE = "agent"


async def list_agent_definitions(db: AsyncSession, *, tenant_id: str) -> list[WorkflowDefinition]:
    """The tenant's agent-worker definitions — the ``action_type == "agent"`` subset.

    The same tenant-scoped definition query as :func:`list_definitions`, narrowed
    to agentic workers at the database. This is the reusable read the prompt
    assistant folds into its library-aware context (ADR-0016 §5): the existing
    agents an author might suggest reusing or building on.
    """
    result = await db.execute(
        select(WorkflowDefinition)
        .where(
            WorkflowDefinition.tenant_id == tenant_id,
            WorkflowDefinition.action_type == AGENT_ACTION_TYPE,
        )
        .order_by(WorkflowDefinition.created_at)
    )
    return list(result.scalars().all())


async def get_definition(
    db: AsyncSession, *, tenant_id: str, definition_id: str
) -> WorkflowDefinition | None:
    result = await db.execute(
        select(WorkflowDefinition).where(
            WorkflowDefinition.tenant_id == tenant_id,
            WorkflowDefinition.id == definition_id,
        )
    )
    return result.scalar_one_or_none()


def _stamp_run_as(definition: WorkflowDefinition, run_as_user_id: str | None) -> None:
    """Re-bind a definition's run-as principal to whoever is saving it (ADR-0027 §2).

    Called from update and enable, not only create: authority follows the last
    person to exercise it, so an editor cannot leave a definition running under
    someone else's permissions — and the UI's "Runs as …" is always the person
    who most recently vouched for the rule as it now stands.

    A caller with no ``user_id`` (a machine identity, or an instance whose
    identity provider resolves none) leaves the existing principal alone rather
    than clearing it. Silently unbinding would demote a definition to
    unrunnable-for-write-back on an unrelated edit, which is a confusing failure
    a long way from its cause.
    """
    if run_as_user_id:
        definition.run_as_user_id = run_as_user_id
        definition.run_as_kind = "user"


async def create_definition(
    db: AsyncSession,
    *,
    tenant_id: str,
    name: str,
    trigger_source: str,
    trigger_detail_type: str,
    action_type: str,
    action_config: dict[str, Any],
    enabled: bool,
    trigger_filter: dict[str, Any] | None = None,
    schedule_config: dict[str, Any] | None = None,
    scope: dict[str, Any] | None = None,
    run_as_user_id: str | None = None,
) -> WorkflowDefinition:
    definition = WorkflowDefinition(
        tenant_id=tenant_id,
        name=name,
        trigger_source=trigger_source,
        trigger_detail_type=trigger_detail_type,
        trigger_filter=trigger_filter,
        action_type=action_type,
        action_config=action_config,
        enabled=enabled,
        schedule_config=schedule_config,
        scope=scope,
        run_as_user_id=run_as_user_id,
        run_as_kind="user" if run_as_user_id else "system",
    )
    db.add(definition)
    await db.flush()
    await db.refresh(definition)
    return definition


async def update_definition(
    db: AsyncSession,
    *,
    tenant_id: str,
    definition_id: str,
    name: str,
    trigger_source: str,
    trigger_detail_type: str,
    action_type: str,
    action_config: dict[str, Any],
    enabled: bool,
    trigger_filter: dict[str, Any] | None = None,
    schedule_config: dict[str, Any] | None = None,
    scope: dict[str, Any] | None = None,
    run_as_user_id: str | None = None,
) -> WorkflowDefinition | None:
    definition = await get_definition(db, tenant_id=tenant_id, definition_id=definition_id)
    if definition is None:
        return None
    definition.name = name
    definition.trigger_source = trigger_source
    definition.trigger_detail_type = trigger_detail_type
    definition.trigger_filter = trigger_filter
    definition.action_type = action_type
    definition.action_config = action_config
    definition.enabled = enabled
    definition.schedule_config = schedule_config
    definition.scope = scope
    _stamp_run_as(definition, run_as_user_id)
    await db.flush()
    await db.refresh(definition)
    return definition


async def set_definition_enabled(
    db: AsyncSession,
    *,
    tenant_id: str,
    definition_id: str,
    enabled: bool,
    run_as_user_id: str | None = None,
) -> WorkflowDefinition | None:
    definition = await get_definition(db, tenant_id=tenant_id, definition_id=definition_id)
    if definition is None:
        return None
    definition.enabled = enabled
    _stamp_run_as(definition, run_as_user_id)
    await db.flush()
    await db.refresh(definition)
    return definition


async def delete_definition(
    db: AsyncSession, *, tenant_id: str, definition_id: str
) -> WorkflowDefinition | None:
    """Delete the definition, returning the (now-deleted) row so the caller can
    emit its state-change payload, or ``None`` if it didn't exist. The returned
    instance's attributes stay readable until the surrounding commit expires it."""
    definition = await get_definition(db, tenant_id=tenant_id, definition_id=definition_id)
    if definition is None:
        return None
    await db.delete(definition)
    await db.flush()
    return definition
