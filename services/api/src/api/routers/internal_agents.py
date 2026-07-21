"""Internal agent-run API for the agent runtime (ADR-0009 service auth, ADR-0014).

Service-only routes under ``/api/v1/internal/agent-runs`` — reachable only by an
allowlisted IAM principal (the agent-runtime plugin's Lambda role), never by a
user. Three steps, matching the run lifecycle:

1. ``POST /agent-runs`` — record a requested run and emit ``agent.run.requested``.
   The §8 depth ceiling is enforced here: a chain past the maximum is refused
   with 409, loudly, because each iteration has an invoice attached.
2. ``GET /agent-runs/{id}`` — the runtime reads the resolved definition and the
   input it must execute. This route exists because the event carries only a
   **reference** (§5); the payload never travels on the bus.
3. ``POST /agent-runs/{id}/complete`` — the terminal report, emitting
   ``agent.run.completed`` for failures as well as successes so a subscriber can
   distinguish "failed" from "still running".

Both emits go through ``emit_event``, never the publisher directly: the event is
buffered on the request's session and published by ``get_db`` only after the
commit succeeds, so a rolled-back transaction cannot produce a phantom run event
(ADR-0014 §5, epic #222).

Like ``internal_orchestration``, these carry no Cognito identity and are gated by
``require_service_principal``, not ``require_auth``. The completion route is
hand-written rather than generic CRUD deliberately: ADR-0014 §7 gives the agent
principal no write surface beyond finishing its own run.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent_runs import (
    DepthLimitExceededError,
    RunAlreadyTerminalError,
    complete_run,
    create_run,
    get_run,
)
from ..config import settings
from ..database import get_db
from ..events import emit_event
from ..events.registry import AGENT_RUN_COMPLETED, AGENT_RUN_REQUESTED
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.agent_run import AgentRun
from ..schemas.agent_run import (
    AgentRunResponse,
    CompleteAgentRunRequest,
    CreateAgentRunRequest,
)

router = APIRouter(prefix="/internal/agent-runs", tags=["internal:agents"])


def _reference_payload(run: AgentRun) -> dict[str, object]:
    """The event payload for a run: a **reference**, never the result (§5).

    The transcript and the run's output are LLM content derived from
    attacker-influenceable input, so they stay behind the authenticated fetch
    above rather than being broadcast to every subscriber.
    """
    return {
        "run_id": run.id,
        "agent": run.agent_name,
        "status": run.status,
        "causation_id": run.causation_id,
        "depth": run.depth,
    }


@router.post("", response_model=AgentRunResponse, status_code=status.HTTP_201_CREATED)
async def request_agent_run(
    body: CreateAgentRunRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> AgentRunResponse:
    """Create a ``pending`` run and announce it on the bus.

    Refuses with 409 past the configured depth ceiling — the one point in the
    cycle ``run -> event -> run`` where an unbounded loop can still be stopped
    before it spends anything (ADR-0014 §8).
    """
    try:
        run = await create_run(
            db,
            tenant_id=principal.tenant_id,
            agent_name=body.agent_name,
            definition_snapshot=body.definition_snapshot,
            input_payload=body.input_payload,
            causation_id=body.causation_id,
            depth=body.depth,
            max_depth=settings.agent_max_run_depth,
            workflow_run_id=body.workflow_run_id,
            thread_id=body.thread_id,
        )
    except DepthLimitExceededError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    emit_event(db, AGENT_RUN_REQUESTED, _reference_payload(run), tenant_id=principal.tenant_id)
    return AgentRunResponse.model_validate(run)


@router.get("/{run_id}", response_model=AgentRunResponse)
async def read_agent_run(
    run_id: str,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> AgentRunResponse:
    """The full run record — the definition and input the runtime executes."""
    run = await get_run(db, tenant_id=principal.tenant_id, run_id=run_id)
    if run is None:
        raise _not_found()
    return AgentRunResponse.model_validate(run)


@router.post("/{run_id}/complete", response_model=AgentRunResponse)
async def complete_agent_run(
    run_id: str,
    body: CompleteAgentRunRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> AgentRunResponse:
    """Record a run's outcome and emit ``agent.run.completed``.

    Failures emit too, with ``status`` in the payload. A run that has already
    terminated is refused with 409: the runtime's POST is retryable, and a
    replayed completion must not overwrite a finished run's result.
    """
    try:
        run = await complete_run(
            db,
            tenant_id=principal.tenant_id,
            run_id=run_id,
            status=body.status,
            messages=body.messages,
            result=body.result,
            error=body.error,
            input_tokens=body.input_tokens,
            output_tokens=body.output_tokens,
            cost_usd=body.cost_usd,
        )
    except RunAlreadyTerminalError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if run is None:
        raise _not_found()

    emit_event(db, AGENT_RUN_COMPLETED, _reference_payload(run), tenant_id=principal.tenant_id)
    return AgentRunResponse.model_validate(run)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent run not found")
