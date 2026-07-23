"""The prompt-assistant chat endpoint (ADR-0016, buffered amendment).

``POST /api/v1/admin/agent-chat`` — the synchronous chat spine's ingress. Cognito-
authenticated and admin-gated (authoring is an admin activity, consistent with the
other authoring surfaces: ``admin/prompt-components``, orchestration definition
CRUD), tenant-scoped (ADR-0001).

The flow for one turn:

1. Resolve the caller (``require_admin``) — this is the run's ``run_as_user_id``.
2. Create/continue a run in a thread: ``run_as_kind="user"``, the caller's id, and
   a ``thread_id`` (minted for a new chat, reused to continue one). Reuses the
   ``agent_runs`` model/table — a chat is a *thread of runs* (ADR-0014 §6.4).
3. Assemble the turn: the built-in system prompt (trusted instruction channel) +
   a *library-aware reference block* (the tenant's existing prompt components and
   agent definitions, summarised — ADR-0016 §5, Phase 2) + the thread's prior
   conversational messages (history) + the new user message *fenced as untrusted*
   (ADR-0014 §5). The library block is first-party reference data, delineated and
   kept OUT of the instruction channel (ADR-0016 §1).
4. Synchronously invoke the runtime (IAM, RequestResponse) for the buffered LLM
   turn. The runtime touches no database (ADR-0002) and is not a public surface —
   it receives the assembled context and is unchanged from Phase 1.
5. Persist the turn onto the run and return the reply.

``run_as: user`` here means the authority for the library reads is the caller's:
Core performs them under the admin caller's own permissions (the endpoint is
``require_admin``, and components/definitions are admin authoring resources), so
being library-aware needs no §452 generic read route (ADR-0016 §5).

The Core->runtime invoke is a seam (``RuntimeInvoker``) so this route is testable
without boto3 or a live Lambda; the real sync invoke is only exercisable on a
deployed stack.
"""

from __future__ import annotations

import uuid

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ...agent_assistant import (
    ASSISTANT_AGENT_KEY,
    LambdaRuntimeInvoker,
    RuntimeInvocationError,
    RuntimeInvoker,
    assemble_messages,
    library_reference_message,
)
from ...agent_runs import complete_run, create_run, list_thread_runs
from ...chat_agents import get_chat_agent
from ...config import settings
from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...orchestration import list_agent_definitions
from ...prompt_library import list_components
from ...schemas.agent_chat import AgentChatRequest, AgentChatResponse

logger = Logger()

router = APIRouter(prefix="/admin/agent-chat", tags=["admin"])


def _get_runtime_invoker() -> RuntimeInvoker:
    """The default Core->runtime invoke seam.

    503 when no runtime is wired (empty ``agent_runtime_function_name``): the
    assistant is not provisioned on this deployment, exactly as the endpoint-control
    plane returns 501 when the PR-signer is absent. Overridable in tests via
    ``dependency_overrides``.
    """
    if not settings.agent_runtime_function_name:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The prompt assistant is not configured on this deployment.",
        )
    return LambdaRuntimeInvoker(settings.agent_runtime_function_name)


@router.post("", response_model=AgentChatResponse)
async def prompt_assistant_chat(
    body: AgentChatRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    invoker: RuntimeInvoker = Depends(_get_runtime_invoker),
    db: AsyncSession = Depends(get_db),
) -> AgentChatResponse | JSONResponse:
    """Run one prompt-assistant turn and return the buffered reply."""
    # Whose authority the run records (§6.2). Identity/audit only in Phase 1. The
    # deployment's canonical id when known, else the verified Cognito subject.
    run_as_user_id = caller.user_id or caller.sub

    # Resolve this endpoint's chat agent from the registry (ADR-0017 §1): its system
    # prompt, model, and turn bounds. The prompt assistant is registered under
    # ``prompt-assistant``; the endpoint stays admin-gated (Phase 1 — the agent's
    # required_group drives the generic ingress in Phase 2).
    agent = get_chat_agent(ASSISTANT_AGENT_KEY)

    # Continue the given thread, or mint a new one. History is the prior runs'
    # conversational messages, tenant-scoped (ADR-0016 §2).
    thread_id = body.thread_id or str(uuid.uuid4())
    prior_messages: list[dict] = []
    if body.thread_id:
        prior_runs = await list_thread_runs(
            db, tenant_id=caller.tenant_id, thread_id=body.thread_id
        )
        for run in prior_runs:
            prior_messages.extend(run.messages or [])

    definition_snapshot = {
        "agent_name": agent.agent_name,
        "instructions": "(built-in prompt-assistant system prompt — see api.agent_assistant)",
        "model": agent.model,
    }
    # A user-invoked run in a thread (ADR-0014 §6). No workflow, no event: the
    # synchronous path is request -> run, so this does not emit agent.run.requested.
    run = await create_run(
        db,
        tenant_id=caller.tenant_id,
        agent_name=agent.agent_name,
        definition_snapshot=definition_snapshot,
        input_payload={"message": body.message},
        max_depth=settings.agent_max_run_depth,
        thread_id=thread_id,
        run_as_kind="user",
        run_as_user_id=run_as_user_id,
    )

    # Library-aware context (ADR-0016 §5, Phase 2). Read the tenant's existing prompt
    # components and agent definitions under the admin caller's own authority — the
    # endpoint is already require_admin and these are admin authoring resources, so no
    # §452 generic read route and no new permission plumbing is needed. Both reads are
    # tenant-scoped (ADR-0001). Core folds a *bounded summary* of them into the turn as
    # delineated reference data — never the instruction channel (ADR-0016 §1) — so the
    # assistant can suggest reusing what already exists.
    components = await list_components(db, tenant_id=caller.tenant_id)
    agent_definitions = await list_agent_definitions(db, tenant_id=caller.tenant_id)
    library_message = library_reference_message(
        components,
        agent_definitions,
        max_items=settings.agent_assistant_max_library_items,
    )

    messages = assemble_messages(
        prior_messages,
        body.message,
        limit=agent.max_history_messages,
        library_message=library_message,
    )

    try:
        turn = invoker.invoke_chat_turn(
            model=agent.model,
            messages=messages,
            max_output_tokens=agent.max_output_tokens,
            timeout_seconds=agent.timeout_seconds,
        )
    except RuntimeInvocationError as exc:
        # Record the failed run (the transcript so far travels with it) so the run
        # inspector can tell it apart from one still running (ADR-0014 §5), then
        # return 502. Deliberately a JSONResponse rather than `raise`: get_db rolls
        # back the whole transaction on any raised exception, which would discard
        # the very failed-run write we just made. Returning commits it.
        await complete_run(
            db,
            tenant_id=caller.tenant_id,
            run_id=run.id,
            status="failed",
            messages=messages,
            error=str(exc)[:2000],
        )
        logger.warning("Prompt-assistant turn failed", extra={"run_id": run.id, "error": str(exc)})
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": "The prompt assistant could not complete this turn."},
        )

    transcript = [*messages, {"role": "assistant", "content": turn.content}]
    await complete_run(
        db,
        tenant_id=caller.tenant_id,
        run_id=run.id,
        status="completed",
        messages=transcript,
        result={"output": turn.content, "model": turn.model, "finish_reason": turn.finish_reason},
        input_tokens=turn.input_tokens,
        output_tokens=turn.output_tokens,
        cost_usd=turn.cost_usd,
    )

    return AgentChatResponse(
        thread_id=thread_id,
        run_id=run.id,
        reply=turn.content,
        model=turn.model,
        input_tokens=turn.input_tokens,
        output_tokens=turn.output_tokens,
        cost_usd=turn.cost_usd,
    )
