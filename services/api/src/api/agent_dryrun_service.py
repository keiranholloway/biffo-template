"""The no-side-effect workflow dry-run (issue #527, Phase 2).

"Test workflow" in the builder: given a draft agent-action config and a sample
event, run one agent turn and return the output for preview — writing nothing.
The dry-run is, deliberately, the real-run machinery with its two side-effecting
ends removed:

    prompt-library resolution  +  worker-style message assembly
                               +  the ADR-0016 synchronous invoke transport
                               −  create_run / complete_run (no run persisted)
                               −  emit_event               (no event on the bus)
                               −  any delivery/notify action

so the preview is faithful without a run row, an ``agent.run.requested`` event, or
a downstream action ever happening. Because nothing is persisted, a runtime
failure is just a returned 502 — there is no failed-run row to preserve (contrast
:func:`api.agent_chat_service.run_chat_turn`, which records the failed run).

**MVP scope — a single buffered turn.** This runs exactly one turn (the worker's
opening message array) and returns it; ``max_turns`` and the full tool loop are
*not* exercised. A full-loop dry-run — replaying tool calls without executing
them, or against a sandbox — is a deliberate follow-up, not silently pretended
here.

This is read-only-ish: it reads the prompt library (tenant-scoped) to resolve
parts, and invokes the runtime. It does not touch the worker path, the real-run
lifecycle, or the runtime plugin.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .chat_engine import RuntimeInvocationError, RuntimeInvoker
from .config import settings
from .prompt_library import resolve_prompt_field
from .prompt_parts import PromptPartsError
from .schemas.agent_dryrun import WorkflowDryRunRequest, WorkflowDryRunResponse
from .worker_messages import build_worker_messages

logger = Logger()


async def run_dry_run(
    db: AsyncSession,
    *,
    tenant_id: str,
    request: WorkflowDryRunRequest,
    invoker: RuntimeInvoker,
) -> WorkflowDryRunResponse | JSONResponse:
    """Run one previewed agent turn for ``request`` and return its output.

    Resolves ``instructions``/``goals`` through the prompt library exactly as a
    real run would (tenant-scoped, ADR-0015 §3/§4), assembles the worker-way
    message array, and invokes the runtime through the buffered sync transport.
    Persists nothing and emits nothing.

    Raises:
        HTTPException(422): the draft's prompt parts do not resolve against this
            tenant's library (malformed shape, missing component, or a value that
            doesn't match a component's declared variables). Same verdict a save
            would give, surfaced before enabling.

    Returns a 502 ``JSONResponse`` (not a raise) when the runtime turn fails —
    the shape :mod:`api.agent_chat_service` uses, minus the failed-run write.
    """
    try:
        instructions = await resolve_prompt_field(
            db, tenant_id=tenant_id, raw=request.instructions, field="instructions"
        )
        goals = (
            await resolve_prompt_field(db, tenant_id=tenant_id, raw=request.goals, field="goals")
            if request.goals is not None
            else None
        )
    except PromptPartsError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc

    messages = build_worker_messages(instructions, request.sample_event, goals or None)
    model = request.model or settings.agent_assistant_model

    try:
        turn = invoker.invoke_chat_turn(
            model=model,
            messages=messages,
            max_output_tokens=settings.agent_assistant_max_output_tokens,
            timeout_seconds=settings.agent_assistant_timeout_seconds,
        )
    except RuntimeInvocationError as exc:
        # Nothing was written, so a failure needs no failed-run row to be told
        # apart from a running one — it is simply a returned error (ADR-0014 §5
        # does not apply where no run exists). Deliberately a JSONResponse, not a
        # raise, to match the chat endpoint's 502 shape.
        logger.warning("Workflow dry-run turn failed", extra={"error": str(exc)})
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": "The agent could not complete the dry-run turn."},
        )

    return WorkflowDryRunResponse(
        output=turn.content,
        model=turn.model,
        input_tokens=turn.input_tokens,
        output_tokens=turn.output_tokens,
        cost_usd=turn.cost_usd,
        finish_reason=turn.finish_reason,
    )
