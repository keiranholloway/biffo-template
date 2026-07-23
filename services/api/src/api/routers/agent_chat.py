"""The generic chat endpoint (ADR-0017 §3): ``POST /api/v1/agent-chat/{agent_key}``.

The buffered chat spine's user-facing ingress for *any* registered chat agent, not
just the prompt assistant. Cognito-authenticated and gated by the **agent's own
``required_group``** (resolved from the registry, ADR-0017 §1) rather than a fixed
role — so an admin agent needs ``admin`` and a founder-facing one needs ``founder``,
without a per-agent route. Tenant-scoped (ADR-0001).

The turn itself runs through the shared :func:`run_chat_turn`; this module only
resolves the agent, enforces the gate, and assembles the agent's optional
first-party context. An unknown ``agent_key`` is a 404 — a caller cannot enumerate
agents, and prompt text never appears in the request (only the key).
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent_chat_service import _get_runtime_invoker, run_chat_turn
from ..chat_agents import (
    TurnContext,
    UnknownChatAgentError,
    get_chat_agent,
    get_chat_context,
)
from ..chat_engine import RuntimeInvoker
from ..database import get_db
from ..middleware.auth import AuthenticatedUser, require_auth
from ..schemas.agent_chat import AgentChatRequest, AgentChatResponse

logger = Logger()

router = APIRouter(prefix="/agent-chat", tags=["agents"])


@router.post("/{agent_key}", response_model=AgentChatResponse)
async def agent_chat(
    agent_key: str,
    body: AgentChatRequest,
    caller: AuthenticatedUser = Depends(require_auth),
    invoker: RuntimeInvoker = Depends(_get_runtime_invoker),
    db: AsyncSession = Depends(get_db),
) -> AgentChatResponse | JSONResponse:
    """Run one buffered turn for the registered agent ``agent_key`` and return the reply."""
    try:
        agent = get_chat_agent(agent_key)
    except UnknownChatAgentError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such chat agent."
        ) from exc

    # Gate by the agent's own required group (ADR-0017 §3). Membership comes from the
    # verified cognito:groups claim (ADR-0004), so a removed member loses access the
    # moment their token expires.
    if agent.required_group not in caller.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access to this assistant requires the '{agent.required_group}' group.",
        )

    # The agent's optional first-party context (e.g. the prompt assistant's library
    # block), assembled under the caller's authority; a plain agent has none.
    assembler = get_chat_context(agent_key)
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
