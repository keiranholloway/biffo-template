"""Internal agent-run API for the agent runtime (ADR-0009 service auth, ADR-0014).

Service-only routes under ``/api/v1/internal/agent-runs`` — reachable only by an
allowlisted IAM principal (the agent-runtime plugin's Lambda role), never by a
user. Four steps matching the run lifecycle, plus a scheduled sweep:

1. ``POST /agent-runs`` — record a requested run and emit ``agent.run.requested``.
   The §8 depth ceiling is enforced here: a chain past the maximum is refused
   with 409, loudly, because each iteration has an invoice attached.
2. ``GET /agent-runs/{id}`` — the runtime reads the resolved definition and the
   input it must execute. This route exists because the event carries only a
   **reference** (§5); the payload never travels on the bus.
3. ``POST /agent-runs/{id}/claim`` — take ownership of a ``pending`` run before
   any model call. 409 when someone else already has it. EventBridge is
   at-least-once, so without this two deliveries both execute and both are
   billed (§5).
4. ``POST /agent-runs/{id}/complete`` — the terminal report, emitting
   ``agent.run.completed`` for failures as well as successes so a subscriber can
   distinguish "failed" from "still running".
5. ``POST /agent-runs/reap`` — scheduled sweep that fails runs a dead runtime
   left in ``running``, emitting the same completion event so whatever was
   waiting on them is released (§5, issue #402).
6. ``GET /agent-runs?causation_id=`` — the runs of one chain, as summaries. How a
   fan-in discovers the siblings of the run that just completed and decides
   whether the rest are done (§8, issue #656).

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

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent_runs import (
    DepthLimitExceededError,
    RunAlreadyTerminalError,
    RunNotClaimableError,
    claim_run,
    complete_run,
    create_run,
    get_run,
    list_runs,
    list_thread_runs,
    reap_stale_runs,
    run_reference_payload,
)
from ..config import settings
from ..database import get_db
from ..events import emit_event
from ..events.registry import AGENT_RUN_COMPLETED, AGENT_RUN_REQUESTED
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.agent_run import AgentRun
from ..prompt_parts import PromptPartsError
from ..schemas.agent_run import (
    AgentRunResponse,
    AgentRunSummary,
    CompleteAgentRunRequest,
    CreateAgentRunRequest,
    ThreadMessagesResponse,
)
from ..writeback_targets import apply_writeback_output_tool

logger = Logger()

router = APIRouter(prefix="/internal/agent-runs", tags=["internal:agents"])


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

    Refuses with 422 when the snapshot's prompt parts cannot be resolved — a
    referenced component was since deleted, or a required variable is unsupplied
    (ADR-0015 §6). The run is aborted rather than created with a broken or
    half-substituted prompt, the same fail-loud posture as the depth ceiling.
    """
    # The result contract for a write-back run is Core's to state, generated from
    # the registered target rather than accepted from the caller (ADR-0027 §6) —
    # so the model is required to return typed columns, and is never offered a
    # field outside the ceiling. A snapshot with no write-back is untouched.
    snapshot = apply_writeback_output_tool(body.definition_snapshot)

    try:
        run = await create_run(
            db,
            tenant_id=principal.tenant_id,
            agent_name=body.agent_name,
            definition_snapshot=snapshot,
            input_payload=body.input_payload,
            causation_id=body.causation_id,
            depth=body.depth,
            max_depth=settings.agent_max_run_depth,
            workflow_run_id=body.workflow_run_id,
            thread_id=body.thread_id,
        )
    except DepthLimitExceededError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except PromptPartsError as exc:
        logger.warning(
            "Agent run creation aborted: unresolvable prompt (ADR-0015 §6)",
            extra={"agent": body.agent_name, "error": str(exc)},
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc

    emit_event(db, AGENT_RUN_REQUESTED, run_reference_payload(run), tenant_id=principal.tenant_id)
    return AgentRunResponse.model_validate(run)


@router.get("", response_model=list[AgentRunSummary])
async def list_agent_runs(
    causation_id: str = Query(
        ...,
        description="Only runs in this causation chain (ADR-0014 §8).",
    ),
    agent_name: str | None = Query(None, description="Only runs of this agent."),
    limit: int = Query(50, ge=1, le=200),
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[AgentRunSummary]:
    """The runs in one causation chain — how a fan-in discovers its siblings.

    ``causation_id`` is **required**, not optional. This is a service-only route,
    and the only reason a service has to list runs is to reason about a chain it
    is already part of; an unfiltered list here would be an
    every-run-in-the-tenant read for any allowlisted principal, which the admin
    surface (``/admin/agent-runs``, human-gated) already covers.

    Summaries only — never ``messages``/``result``/``input_payload``. A fan-in
    needs statuses to decide whether to fire, then fetches the transcripts it
    actually wants from ``GET /internal/agent-runs/{run_id}``. Returning
    unbounded transcripts from a list is what this endpoint's ``load_only``
    discipline exists to prevent.
    """
    runs = await list_runs(
        db,
        tenant_id=principal.tenant_id,
        agent_name=agent_name,
        causation_id=causation_id,
        limit=limit,
    )
    return [_summary(run) for run in runs]


def _summary(run: AgentRun) -> AgentRunSummary:
    """Shape a run into the list summary, lifting ``model`` out of the snapshot.

    Reads only the columns ``list_runs`` loaded; the heavy columns stay deferred
    and untouched, so this does no lazy IO. Mirrors ``routers/admin/agent_runs``'s
    ``_summary`` — same shape, different audience.
    """
    model = run.definition_snapshot.get("model") if run.definition_snapshot else None
    return AgentRunSummary(
        id=run.id,
        tenant_id=run.tenant_id,
        created_at=run.created_at,
        updated_at=run.updated_at,
        agent_name=run.agent_name,
        status=run.status,
        model=model if isinstance(model, str) else None,
        input_tokens=run.input_tokens,
        output_tokens=run.output_tokens,
        cost_usd=run.cost_usd,
        started_at=run.started_at,
        completed_at=run.completed_at,
    )


_CONVERSATION_ROLES = ("user", "assistant")


# Declared before /{run_id}: a three-segment path cannot collide with a single
# segment, but keeping the more specific route first makes the intent obvious.
@router.get("/threads/{thread_id}/messages", response_model=ThreadMessagesResponse)
async def read_thread_messages(
    thread_id: str,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> ThreadMessagesResponse:
    """A thread's conversation — the ordered user/assistant messages across every
    run sharing ``thread_id`` (ADR-0016 §2), tenant-scoped.

    The consumer is a module driving an **async** run over a chat it held on the
    synchronous spine: the buffered chat assembles history in-process, but a
    separate async run (e.g. the Ideation analyst) builds from its ``input_payload``
    and so must be handed the conversation to reason over. System/tool messages are
    per-run machinery, not conversation, and are excluded. An unknown thread is an
    empty conversation, not a 404."""
    runs = await list_thread_runs(db, tenant_id=principal.tenant_id, thread_id=thread_id)
    messages = [
        message
        for run in runs
        for message in (run.messages or [])
        if isinstance(message, dict) and message.get("role") in _CONVERSATION_ROLES
    ]
    return ThreadMessagesResponse(thread_id=thread_id, messages=messages)


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


@router.post("/{run_id}/claim", response_model=AgentRunResponse)
async def claim_agent_run(
    run_id: str,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> AgentRunResponse:
    """Take ownership of a ``pending`` run before spending anything on it.

    409 when the run is not ``pending``: another invocation owns it, or it has
    already finished. The runtime must treat that as "not mine" and exit
    **without calling the model** — at-least-once delivery otherwise buys the
    same tokens twice (ADR-0014 §5).

    Deliberately emits no event. A claim is a lease on work already announced by
    ``agent.run.requested``, not a new fact about the world, and an event per
    claim would put a message on the bus for every duplicate delivery — which is
    the thing being suppressed.
    """
    try:
        run = await claim_run(db, tenant_id=principal.tenant_id, run_id=run_id)
    except RunNotClaimableError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
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

    **A dry run is recorded but not announced** (issue #726). The orchestrator is
    the only subscriber to this event, and it is what fires the write-back and any
    chained agent — so withholding it here is the whole of "a preview causes
    nothing", enforced once rather than re-checked by every action. The row is
    still written, so the portal polling the run sees it terminate normally.
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

    if not run.dry_run:
        emit_event(
            db, AGENT_RUN_COMPLETED, run_reference_payload(run), tenant_id=principal.tenant_id
        )
    return AgentRunResponse.model_validate(run)


@router.post("/reap", response_model=list[AgentRunResponse])
async def reap_stale_agent_runs(
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[AgentRunResponse]:
    """Fail runs a dead runtime left in ``running``, and announce each one.

    Called on a schedule, so it must be safe to call when there is nothing to do
    — and it is: with nothing stale it reaps nothing and emits nothing.

    Each reaped run emits ``agent.run.completed`` with ``status="failed"``,
    because that is the entire point. §5 exists so a subscriber can tell
    "failed" from "still running"; a stranded run says neither, and anything
    waiting on it waits for ever.

    Dry runs are reaped but not announced, for the same reason the completion
    endpoint withholds the event (issue #726). This is the easier one to miss:
    a stranded *preview* would otherwise announce a failure, and the orchestrator
    subscribes to failures as well as successes — so a timed-out preview could
    advance a workflow that the successful preview deliberately did not.
    """
    reaped = await reap_stale_runs(
        db,
        tenant_id=principal.tenant_id,
        stale_after_seconds=settings.agent_run_stale_after_seconds,
    )
    for run in reaped:
        if run.dry_run:
            continue
        emit_event(
            db, AGENT_RUN_COMPLETED, run_reference_payload(run), tenant_id=principal.tenant_id
        )
    if reaped:
        logger.warning(
            "Reaped stale agent runs",
            extra={"count": len(reaped), "run_ids": [r.id for r in reaped]},
        )
    return [AgentRunResponse.model_validate(run) for run in reaped]


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent run not found")
