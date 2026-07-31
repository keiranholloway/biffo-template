"""The no-side-effect workflow dry-run (issue #527, Phase 2; async since #726).

"Test workflow" in the builder: given a draft agent-action config and a sample
event, run the agent and show the output for preview — causing nothing.

**This used to run the turn synchronously and return its output.** It could not:
a dry run is a *preview of a real agent*, and a real agent takes as long as it
takes — a research agent legitimately runs for minutes. The synchronous shape
bounded it at ``agent_assistant_timeout_seconds`` (20s), and that bound could not
simply be raised, because every API Gateway integration here is capped at 29s and
this is an HTTP API, where 30s is a hard AWS ceiling rather than a quota. Raising
it would only have moved the failure from an honest 502 to a 504 with the Lambda
still burning.

So the dry-run now does what everything else that does real work already did:

    create_run(dry_run=True)  ->  agent.run.requested  ->  the runtime claims it
                              ->  POST /agent-runs/{id}/complete
                              ->  (no agent.run.completed, because it is a dry run)

and the caller polls the run. The runtime is untouched and does not know the
difference, which is the point — a preview that took its own path through the
code would not be previewing anything.

**What "no side effect" now means.** It used to mean "synchronous, so nothing is
persisted". It now means *nothing downstream reacts*: the orchestrator is the
sole subscriber to ``agent.run.completed``, and that event is what fires the
write-back and any chained agent, so withholding it (``routers/internal_agents``)
is the entire side-effect surface. A run row and one ``agent.run.requested`` are
persisted and emitted — a deliberate trade, and an improvement: the transcript
becomes visible in the Agent Runs view, which is what you want when testing an
agent.

**What this gained by moving.** The old path assembled its own message array via
``build_worker_messages``, parallel to what a real run does. The snapshot handed
to ``create_run`` is now the same shape a real agent action builds, so the
preview exercises the real assembly, the real tool wiring and the real turn loop
— including ``max_turns``, which the synchronous single-turn MVP never ran.

**The snapshot must carry the whole contract, not the prompt half of it (#749).**
It used to be hand-rolled from four keys, so a workflow with a write-back was
previewed *without* one: the model was offered no ``submit_<table>_record``, it
answered in prose, and a plain-completion result is exactly what ``writeback``'s
``_submitted_values`` reads as no columns — the shape a live run refuses to write
and records a refusal for. "Test passed" therefore proved nothing about the very
thing the author was about to enable, and the builder's "Would write" panel
showed run metadata as though it were the columns. So the snapshot now carries
``tools`` and ``writeback`` too, and goes through the same
``apply_writeback_output_tool`` the live path calls, rather than a subset that
drifts every time the action gains a field.
"""

from __future__ import annotations

from typing import Any

from aws_lambda_powertools import Logger
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from .agent_runs import DepthLimitExceededError, create_run, run_reference_payload
from .config import settings
from .events import emit_event
from .events.registry import AGENT_RUN_REQUESTED
from .prompt_parts import PromptPartsError
from .schemas.agent_dryrun import WorkflowDryRunAccepted, WorkflowDryRunRequest
from .writeback_targets import apply_writeback_output_tool

logger = Logger()


async def start_dry_run(
    db: AsyncSession,
    *,
    tenant_id: str,
    request: WorkflowDryRunRequest,
) -> WorkflowDryRunAccepted:
    """Queue a previewed agent run and return its id for polling.

    The snapshot is built to the same contract a saved agent action uses, so the
    runtime reads ``instructions``/``goals``/``model``/``max_turns`` exactly as it
    would for a real run. Prompt-library parts are resolved inside ``create_run``
    (ADR-0015 §3/§4) — the same resolution a real run gets, rather than a second
    implementation of it here.

    The sample event travels as ``input_payload``, where the runtime fences it as
    untrusted data (ADR-0014 §5), identically to a real trigger payload.

    Raises:
        HTTPException(422): the draft's prompt parts do not resolve against this
            tenant's library — a referenced component is missing, or a required
            variable is unsupplied. The same verdict a save would give, surfaced
            before enabling. Also when a declared write-back yields no result
            contract, see below.

    A dry run is always ``depth=0`` with no ``causation_id``: it is a preview
    requested by a person, not a link in a causation chain, so it can neither be
    blamed for a loop nor extend one.
    """
    snapshot: dict[str, Any] = {
        "instructions": request.instructions,
        "model": request.model or settings.agent_assistant_model,
    }
    if request.goals is not None:
        snapshot["goals"] = request.goals
    if request.max_turns is not None:
        snapshot["max_turns"] = request.max_turns
    if request.tools:
        snapshot["tools"] = request.tools
    if request.writeback:
        snapshot["writeback"] = request.writeback

    # The same call the live path makes on the way in (``routers/internal_agents``):
    # a write-back's result contract is Core's to state, generated from the
    # registered target (ADR-0027 §6). Applying it here is the whole of #749 —
    # without it the previewed model is offered no ``submit_<table>_record``, so
    # it answers in prose, and prose is precisely the shape ``writeback``'s
    # ``_submitted_values`` reads as *no columns*. The preview then "passed"
    # while demonstrating the one outcome that writes nothing.
    snapshot = apply_writeback_output_tool(snapshot)
    if request.writeback and not snapshot.get("output_tools"):
        # Declared a write-back, and no contract could be generated for it: this
        # deployment registers no such target, or none of the chosen columns are
        # writeable. A live run would be handed no submit tool and would write
        # nothing, so refusing is the honest verdict — the alternative is the
        # green test this issue is about.
        table = request.writeback.get("table")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"No write-back contract could be generated for table {table!r}: this "
                "deployment does not permit an agent to write there, or none of the "
                "chosen columns are writeable. A live run would write nothing."
            ),
        )

    try:
        # No idempotency key: a preview is explicitly requested each time, so a
        # second request is a second preview, not a duplicate to collapse.
        run, _ = await create_run(
            db,
            tenant_id=tenant_id,
            agent_name=request.agent_name,
            definition_snapshot=snapshot,
            input_payload=request.sample_event,
            max_depth=settings.agent_max_run_depth,
            dry_run=True,
        )
    except PromptPartsError as exc:
        logger.warning(
            "Workflow dry-run aborted: unresolvable prompt (ADR-0015 §6)",
            extra={"agent": request.agent_name, "error": str(exc)},
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    except DepthLimitExceededError as exc:  # pragma: no cover - depth is always 0
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    # The same reference payload a real request emits. A dry run is not announced
    # as one: the runtime must treat it identically, and nothing else is listening
    # to `requested` — the side-effecting subscriber is on `completed`, which this
    # run will never emit.
    emit_event(db, AGENT_RUN_REQUESTED, run_reference_payload(run), tenant_id=tenant_id)
    return WorkflowDryRunAccepted(run_id=run.id, status=run.status)
