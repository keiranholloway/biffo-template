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

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.orchestration import WorkflowRun
from ..orchestration import dispatch_event, record_result
from ..schemas.orchestration import (
    ClaimedRun,
    DispatchEventRequest,
    DispatchEventResponse,
    RecordResultRequest,
    WorkflowRunResponse,
)

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
    return DispatchEventResponse(
        runs=[
            ClaimedRun(
                run_id=c.run_id,
                definition_id=c.definition_id,
                action_type=c.action_type,
                action_config=c.action_config,
                created=c.created,
            )
            for c in claimed
        ]
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
