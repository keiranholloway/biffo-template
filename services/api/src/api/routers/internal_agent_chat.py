"""The internal service chat endpoint (ADR-0017 §3, seam #3) — dual-authenticated.

``POST /api/v1/internal/agent-chat/{agent_key}`` — a plugin's own Lambda drives a
buffered chat turn **on behalf of a founder**. This is how a marketplace module
(which runs in its own Lambda, never inside Core) rents the chat spine. Two
independent checks must BOTH pass:

1. **SigV4 service principal** (``require_service_principal``, ADR-0009) — a known
   Biffo service is calling, proven by IAM, not by anything in the request body.
2. **The founder's Cognito token, forwarded and re-verified here.** The plugin
   forwards the founder's access token in the ``X-Biffo-User-Token`` header; Core
   re-verifies it with the shared verifier (``packages/cognito-auth``, #492). So
   **Core, not the plugin, is the authority on who the user is** — the plugin
   cannot assert an identity it has not been given a valid token for. The run's
   ``run_as_user_id`` is that verified subject.

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
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials
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
from ..middleware.auth import AuthenticatedUser, identity_from_token
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..schemas.agent_chat import AgentChatRequest, AgentChatResponse

logger = Logger()

#: The header the plugin forwards the founder's Cognito access token in. Distinct
#: from ``Authorization`` (which carries the caller's SigV4 signature on this route).
FORWARDED_USER_HEADER = "X-Biffo-User-Token"

router = APIRouter(prefix="/internal/agent-chat", tags=["internal:agents"])


def require_forwarded_user(
    forwarded_token: str | None = Header(default=None, alias=FORWARDED_USER_HEADER),
) -> AuthenticatedUser:
    """Resolve the founder from the forwarded, re-verified Cognito token.

    A 401 when the header is absent or the token fails verification — Core is the
    authority on the user's identity, so a plugin cannot act for a founder without
    a token that verifies here.
    """
    if not forwarded_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"A forwarded user token ({FORWARDED_USER_HEADER}) is required.",
        )
    # Reuses Core's own token->identity mapping; verification failures raise 401.
    return identity_from_token(
        HTTPAuthorizationCredentials(scheme="Bearer", credentials=forwarded_token)
    )


@router.post("/{agent_key}", response_model=AgentChatResponse)
async def internal_agent_chat(
    agent_key: str,
    body: AgentChatRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    founder: AuthenticatedUser = Depends(require_forwarded_user),
    invoker: RuntimeInvoker = Depends(_get_runtime_invoker),
    db: AsyncSession = Depends(get_db),
) -> AgentChatResponse | JSONResponse:
    """Run one buffered turn for ``agent_key`` on behalf of the forwarded founder."""
    try:
        agent = get_chat_agent(agent_key)
    except UnknownChatAgentError as exc:
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
