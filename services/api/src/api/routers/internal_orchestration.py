"""Internal orchestration API for the engine (ADR-0009 service auth).

Service-only routes under ``/api/v1/internal/orchestration`` — reachable only by
an allowlisted IAM principal (the engine plugin's Lambda role), never by a user.
The engine posts an incoming event and gets back the runs to act on (already
idempotently claimed), then posts each action's outcome.

These are deliberately separate from any user-facing surface: they carry no
Cognito identity and are gated by ``require_service_principal``, not
``require_auth``.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.orchestration import WorkflowDefinition, WorkflowRun
from ..orchestration import dispatch_event, fire_scheduled_run, reap_stale_runs, record_result
from ..schemas.orchestration import (
    ClaimedRun,
    DispatchEventRequest,
    DispatchEventResponse,
    FireScheduledRunResponse,
    RecordResultRequest,
    WorkflowRunResponse,
)
from ..writeback import WriteBackNotFoundError, execute_writeback

logger = Logger()

router = APIRouter(prefix="/internal/orchestration", tags=["internal:orchestration"])


class WriteBackRequest(BaseModel):
    """Everything the engine may say about a write-back: which run finished.

    Deliberately nothing else (ADR-0027 §1). Target table, operation, columns,
    values, row selection and the principal to act as are all resolved by Core
    from stored state, so a buggy or compromised plugin cannot name a table,
    choose a column, supply a value or pick an identity.
    """

    agent_run_id: str = Field(min_length=1, max_length=36)


class WriteBackResponse(BaseModel):
    status: str
    run_id: str | None = None
    row_id: str | None = None
    reason: str | None = None


@router.post("/writeback", response_model=WriteBackResponse)
async def record_writeback(
    body: WriteBackRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> WriteBackResponse:
    """Record a completed agent run's result into the table its workflow declared.

    Answers **404** for a run that does not exist *and* for a target this
    principal was never named on — the two must be indistinguishable, so one
    plugin cannot probe what another may write (ADR-0004 §4).

    Every other outcome is a 200 carrying its status: ``written``, ``duplicate``
    (a redelivered completion event — the claim already exists, so nothing is
    written twice), ``skipped`` (no write-back declared, or the run did not
    succeed), or ``denied``. A denial is a normal, recorded result rather than an
    error status, because the caller cannot do anything about it and the audit
    log is where it needs to land.
    """
    try:
        outcome = await execute_writeback(
            db,
            tenant_id=principal.tenant_id,
            agent_run_id=body.agent_run_id,
            principal_names=principal.logical_names,
        )
    except WriteBackNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from exc
    return WriteBackResponse(
        status=outcome.status,
        run_id=outcome.run_id,
        row_id=outcome.row_id,
        reason=outcome.reason,
    )


@router.post("/events", response_model=DispatchEventResponse)
async def dispatch_incoming_event(
    body: DispatchEventRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> DispatchEventResponse:
    """Match an event to enabled definitions and claim one run per match.

    Idempotent: a replayed event returns the same runs with ``created=False`` so
    the engine skips re-executing them.
    """
    claimed = await dispatch_event(
        db,
        tenant_id=principal.tenant_id,
        source=body.source,
        detail_type=body.detail_type,
        idempotency_key=body.idempotency_key,
        event=body.event,
    )
    # #418: a workflow disabled by accident silently drops every matching event —
    # no run, no error, no log, only an absence you have to notice. When nothing
    # was claimed, distinguish "a definition exists for this trigger but none
    # enabled matched (disabled, or excluded by trigger_filter)" from the normal
    # "no definition for this trigger at all" (most events have no workflow —
    # logging those would be pure noise). Only the former is a signal; log it at
    # WARNING so the received-but-dropped event becomes visible. This extra count
    # query runs *only* in the zero-match branch, so the happy path pays nothing.
    if not claimed:
        dropped = (
            await db.execute(
                select(func.count())
                .select_from(WorkflowDefinition)
                .where(
                    WorkflowDefinition.tenant_id == principal.tenant_id,
                    WorkflowDefinition.trigger_source == body.source,
                    WorkflowDefinition.trigger_detail_type == body.detail_type,
                )
            )
        ).scalar_one()
        if dropped:
            logger.warning(
                "Orchestration event received but no enabled definition ran it "
                "(matching definitions are disabled or filtered out)",
                extra={
                    "source": body.source,
                    "detail_type": body.detail_type,
                    "definitions_not_dispatched": dropped,
                },
            )
    return DispatchEventResponse(
        runs=[
            ClaimedRun(
                run_id=c.run_id,
                definition_id=c.definition_id,
                action_type=c.action_type,
                action_config=c.action_config,
                created=c.created,
                scheduled_for=c.scheduled_for,
            )
            for c in claimed
        ]
    )


@router.post("/runs/{run_id}/fire", response_model=FireScheduledRunResponse)
async def fire_run(
    run_id: str,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> FireScheduledRunResponse:
    """The fire-time callback for a scheduled run (docs/implementation/
    0002-scheduled-workflow-actions): the engine's EventBridge Scheduler
    one-time schedule invokes this at the run's ``scheduled_for`` instant.

    ``claimed=False`` means don't execute — the run already fired (a
    duplicate Scheduler delivery) or its definition was disabled/deleted
    since it was scheduled.
    """
    claimed = await fire_scheduled_run(db, tenant_id=principal.tenant_id, run_id=run_id)
    if claimed is None:
        return FireScheduledRunResponse(claimed=False, run_id=run_id)
    return FireScheduledRunResponse(
        claimed=True,
        run_id=claimed.run_id,
        definition_id=claimed.definition_id,
        action_type=claimed.action_type,
        action_config=claimed.action_config,
        trigger_event=claimed.trigger_event,
    )


@router.post("/runs/{run_id}/result", response_model=WorkflowRunResponse)
async def record_run_result(
    run_id: str,
    body: RecordResultRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> WorkflowRun:
    """Record an action's outcome and move the run to its terminal state."""
    run = await record_result(
        db,
        tenant_id=principal.tenant_id,
        run_id=run_id,
        action_type=body.action_type,
        status=body.status,
        request=body.request,
        response=body.response,
        error=body.error,
    )
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    return run


@router.post("/reap", response_model=list[WorkflowRunResponse])
async def reap_stale_orchestration_runs(
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowRun]:
    """Fail runs a dead engine invocation left claimed (tabsii-platform#808).

    Mirrors ``POST /internal/agent-runs/reap`` exactly (ADR-0014 section 5,
    issue #402): a run reaches ``pending``/``dispatching`` only by being
    claimed, and one still there long after any invocation could possibly have
    finished is a runtime that died holding it. Safe to call on a schedule —
    with nothing stale it reaps nothing.

    This does not, by itself, make a wedged tick-driven workflow fire again:
    the dedupe_key it was claimed under stays taken regardless of the run's
    status (see ``orchestration.reap_stale_runs``'s docstring). That failure
    mode is fixed at its source — the orchestrator plugin's idempotency-key
    generation no longer collapses every occurrence of a payload-less
    recurring event onto one key. This sweep's job is narrower: make a
    genuinely abandoned run visible as failed rather than perpetually
    "in-flight" in the run history.
    """
    reaped = await reap_stale_runs(
        db,
        tenant_id=principal.tenant_id,
        stale_after_seconds=settings.orchestration_run_stale_after_seconds,
    )
    if reaped:
        logger.warning(
            "Reaped stale orchestration runs",
            extra={"count": len(reaped), "run_ids": [r.id for r in reaped]},
        )
    return reaped
