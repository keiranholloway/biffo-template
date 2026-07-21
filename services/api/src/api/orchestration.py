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

from dataclasses import dataclass
from typing import Any

from aws_lambda_powertools import Logger
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .events.emit import is_declared
from .models.orchestration import (
    ActionLog,
    TriggerCatalog,
    WorkflowDefinition,
    WorkflowRun,
)

logger = Logger()


@dataclass(frozen=True)
class ClaimedRun:
    """A run the engine should act on (or skip when it was already claimed)."""

    run_id: str
    definition_id: str
    action_type: str
    action_config: dict[str, Any]
    created: bool


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
    run = WorkflowRun(
        tenant_id=tenant_id,
        definition_id=definition.id,
        dedupe_key=dedupe_key,
        trigger_event=event,
        status="pending",
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
        )
    return ClaimedRun(
        run_id=run.id,
        definition_id=definition.id,
        action_type=definition.action_type,
        action_config=definition.action_config,
        created=True,
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

    claimed: list[ClaimedRun] = []
    for definition in definitions:
        # An optional payload filter refines a coarse (source, detail_type) match —
        # e.g. leads.updated only when status == "won" (#226). No filter → always.
        if not _matches_trigger_filter(definition.trigger_filter, event):
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
    await db.flush()
    await db.refresh(definition)
    return definition


async def set_definition_enabled(
    db: AsyncSession, *, tenant_id: str, definition_id: str, enabled: bool
) -> WorkflowDefinition | None:
    definition = await get_definition(db, tenant_id=tenant_id, definition_id=definition_id)
    if definition is None:
        return None
    definition.enabled = enabled
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
