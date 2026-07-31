"""The internal service chat endpoint (ADR-0017 §3, seam #3) — dual-authenticated.

``POST /api/v1/internal/agent-chat/{agent_key}`` — a plugin's own Lambda drives a
buffered chat turn **on behalf of a founder**. This is how a marketplace module
(which runs in its own Lambda, never inside Core) rents the chat spine. Two
independent checks must BOTH pass:

1. **SigV4 service principal** (ADR-0009) — a known Biffo service is calling,
   proven by IAM, not by anything in the request body.
2. **The founder's Cognito token, forwarded and re-verified here.** The plugin
   forwards the founder's access token in the ``X-Biffo-User-Token`` header; Core
   re-verifies it with the shared verifier (``packages/cognito-auth``, #492). So
   **Core, not the plugin, is the authority on who the user is** — the plugin
   cannot assert an identity it has not been given a valid token for. The run's
   ``run_as_user_id`` is that verified subject.

Both arrive as one :class:`~api.middleware.principal.Principal` from
``require_signed_principal`` (#621) — one authorization model over two transports,
so the forwarded token runs the same post-verification checks (deactivation,
platform-admin sync, permissions) as a browser's bearer token.

The verified founder must be in the agent's ``required_group`` (403 otherwise); an
unknown ``agent_key`` is a 404. The turn itself runs through the shared
:func:`run_chat_turn`, identical to the browser-facing route — only the
authentication differs.

Note (follow-up): ADR-0017 also envisages binding a *specific* service principal to
the ``agent_key`` it may drive. That binding is populated by the install flow
(ADR-0003) which does not exist yet, so it is deliberately not enforced here; the
enforceable controls today are the SigV4 gate (trusted infra) and the
forwarded-user group gate.
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
    get_dynamic_chat_agent,
)
from ..chat_engine import RuntimeInvoker
from ..database import get_db
from ..middleware.forwarded_user import FORWARDED_USER_HEADER  # re-exported for callers
from ..middleware.principal import Principal, require_signed_principal
from ..schemas.agent_chat import AgentChatRequest, AgentChatResponse

logger = Logger()

__all__ = ["FORWARDED_USER_HEADER", "router"]

router = APIRouter(prefix="/internal/agent-chat", tags=["internal:agents"])


@router.post("/{agent_key}", response_model=AgentChatResponse)
async def internal_agent_chat(
    agent_key: str,
    body: AgentChatRequest,
    caller: Principal = Depends(require_signed_principal),
    invoker: RuntimeInvoker = Depends(_get_runtime_invoker),
    db: AsyncSession = Depends(get_db),
) -> AgentChatResponse | JSONResponse:
    """Run one buffered turn for ``agent_key`` on behalf of the forwarded founder."""
    founder = caller.user
    try:
        agent = get_chat_agent(agent_key)
    except UnknownChatAgentError as exc:
        # Fallback to live DB resolution for opted-in dynamic plugins.
        agent = await get_dynamic_chat_agent(db, tenant_id=founder.tenant_id, agent_key=agent_key)
        if agent is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="No such chat agent."
            ) from exc

    if agent.required_group not in founder.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access to this assistant requires the '{agent.required_group}' group.",
        )

    assembler = get_chat_context(agent_key)
    context = (
        await assembler(db, tenant_id=founder.tenant_id) if assembler is not None else TurnContext()
    )

    return await run_chat_turn(
        db,
        agent=agent,
        tenant_id=founder.tenant_id,
        run_as_user_id=founder.user_id or founder.sub,
        message=body.message,
        thread_id=body.thread_id,
        invoker=invoker,
        context=context,
    )
