"""The shared buffered chat-turn endpoint logic (ADR-0016; ADR-0017 §2/§3).

Both the admin prompt-assistant route (``/admin/agent-chat``) and the generic,
group-gated route (``/agent-chat/{agent_key}``) run a turn identically — resolve
the thread, create a ``run_as:user`` run, assemble the context via the generic
engine, synchronously invoke the runtime, and persist the turn. That common body
lives here so the two ingresses differ only in *how they authenticate the caller*
and *which agent they resolve*, never in how a turn runs.

The Core->runtime invoke is a seam (``RuntimeInvoker``) so the routes stay testable
without boto3 or a live Lambda; the real sync invoke is only exercisable on a
deployed stack.
"""

from __future__ import annotations

import uuid

from aws_lambda_powertools import Logger
from fastapi import HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .agent_runs import complete_run, create_run, list_thread_runs
from .chat_agents import ChatAgent, TurnContext
from .chat_engine import (
    LambdaRuntimeInvoker,
    RuntimeInvocationError,
    RuntimeInvoker,
    assemble_turn,
)
from .config import settings
from .schemas.agent_chat import AgentChatResponse

logger = Logger()


def _get_runtime_invoker() -> RuntimeInvoker:
    """The default Core->runtime invoke seam, shared by both chat routes.

    503 when no runtime is wired (empty ``agent_runtime_function_name``): the chat
    spine is not provisioned on this deployment, exactly as the endpoint-control
    plane returns 501 when the PR-signer is absent. Overridable in tests via
    ``dependency_overrides``.
    """
    if not settings.agent_runtime_function_name:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The chat spine is not configured on this deployment.",
        )
    return LambdaRuntimeInvoker(settings.agent_runtime_function_name)


async def run_chat_turn(
    db: AsyncSession,
    *,
    agent: ChatAgent,
    tenant_id: str,
    run_as_user_id: str,
    message: str,
    thread_id: str | None,
    invoker: RuntimeInvoker,
    context: TurnContext,
) -> AgentChatResponse | JSONResponse:
    """Run one buffered turn for ``agent`` and return the reply (or a 502 on runtime
    failure). ``thread_id`` is ``None`` for a new chat (Core mints one) or the id of
    an ongoing one to continue (ADR-0016 §2). ``context`` is the agent's optional
    first-party context (empty for a plain turn)."""
    # Continue the given thread, or mint a new one. History is the prior runs'
    # conversational messages, tenant-scoped (ADR-0016 §2).
    continuing = thread_id is not None
    thread_id = thread_id or str(uuid.uuid4())
    prior_messages: list[dict] = []
    if continuing:
        prior_runs = await list_thread_runs(db, tenant_id=tenant_id, thread_id=thread_id)
        for run in prior_runs:
            prior_messages.extend(run.messages or [])

    definition_snapshot = {
        "agent_name": agent.agent_name,
        "instructions": f"(built-in system prompt for chat agent '{agent.agent_key}')",
        "model": agent.model,
    }
    # A user-invoked run in a thread (ADR-0014 §6). No workflow, no event: the
    # synchronous path is request -> run, so this does not emit agent.run.requested.
    # No idempotency key: this is the synchronous path, one run per user turn.
    run, _ = await create_run(
        db,
        tenant_id=tenant_id,
        agent_name=agent.agent_name,
        definition_snapshot=definition_snapshot,
        input_payload={"message": message},
        max_depth=settings.agent_max_run_depth,
        thread_id=thread_id,
        run_as_kind="user",
        run_as_user_id=run_as_user_id,
    )

    messages = assemble_turn(
        agent.system_prompt,
        prior_messages,
        message,
        limit=agent.max_history_messages,
        context_message=context.message,
        drop=context.drop,
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
            tenant_id=tenant_id,
            run_id=run.id,
            status="failed",
            messages=messages,
            error=str(exc)[:2000],
        )
        logger.warning("Chat turn failed", extra={"run_id": run.id, "error": str(exc)})
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": "The chat agent could not complete this turn."},
        )

    transcript = [*messages, {"role": "assistant", "content": turn.content}]
    await complete_run(
        db,
        tenant_id=tenant_id,
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
