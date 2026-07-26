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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.orchestration import WorkflowDefinition, WorkflowRun
from ..orchestration import dispatch_event, fire_scheduled_run, record_result
from ..schemas.orchestration import (
    ClaimedRun,
    DispatchEventRequest,
    DispatchEventResponse,
    FireScheduledRunResponse,
    RecordResultRequest,
    WorkflowRunResponse,
)

logger = Logger()

router = APIRouter(prefix="/internal/orchestration", tags=["internal:orchestration"])


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
