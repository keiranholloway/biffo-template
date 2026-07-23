"""The prompt-assistant chat endpoint (ADR-0016; ADR-0017 §3).

``POST /api/v1/admin/agent-chat`` — the prompt assistant's dedicated, admin-gated
ingress, kept for the authoring UI. Since ADR-0017 Phase 2 the turn runs through the
shared machinery: this route resolves the ``prompt-assistant`` agent and its
library-aware context from the registry and delegates to :func:`run_chat_turn`. It
is behaviourally identical to the generic ``POST /agent-chat/prompt-assistant`` (the
prompt assistant declares ``required_group: "admin"``); it exists so the admin UI
keeps a stable URL and an explicit ``require_admin`` gate.

``_get_runtime_invoker`` is re-exported from the shared service so existing tests
that override it on this module keep working.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ...agent_assistant import ASSISTANT_AGENT_KEY
from ...agent_chat_service import _get_runtime_invoker, run_chat_turn
from ...chat_agents import TurnContext, get_chat_agent, get_chat_context
from ...chat_engine import RuntimeInvoker
from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...schemas.agent_chat import AgentChatRequest, AgentChatResponse

logger = Logger()

router = APIRouter(prefix="/admin/agent-chat", tags=["admin"])

# Re-exported so tests that override the invoke seam on this module keep working
# (it is the same object the shared service and the generic route use).
__all__ = ["_get_runtime_invoker", "router"]


@router.post("", response_model=AgentChatResponse)
async def prompt_assistant_chat(
    body: AgentChatRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    invoker: RuntimeInvoker = Depends(_get_runtime_invoker),
    db: AsyncSession = Depends(get_db),
) -> AgentChatResponse | JSONResponse:
    """Run one prompt-assistant turn and return the buffered reply."""
    agent = get_chat_agent(ASSISTANT_AGENT_KEY)
    assembler = get_chat_context(ASSISTANT_AGENT_KEY)
    context = (
        await assembler(db, tenant_id=caller.tenant_id) if assembler is not None else TurnContext()
    )
    return await run_chat_turn(
        db,
        agent=agent,
        tenant_id=caller.tenant_id,
        run_as_user_id=caller.user_id or caller.sub,
        message=body.message,
        thread_id=body.thread_id,
        invoker=invoker,
        context=context,
    )
