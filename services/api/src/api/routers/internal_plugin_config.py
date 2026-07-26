"""Internal, SigV4-only read for a plugin's own admin-set config (ADR-0009).

GET /api/v1/internal/plugins/me/config/{role} — a plugin reads one of its own
plugin_chat_agents rows (by role, e.g. "analyst"), scoped to its own verified
identity (ServicePrincipal.logical_names), not a caller-supplied plugin name —
that would let any allowlisted service read another plugin's config. No
forwarded founder token: this data isn't founder-owned, and the whole point is
that a plugin's founder-triggered backend code has no way to obtain one (every
outbound Core call it makes is SigV4-signed, which cannot also carry a real
bearer JWT — see issue #621 for the general gap this is one instance of).

Single-tenant deployment (ADR-0001): tenant_id is hardcoded "default", matching
ServicePrincipal's own default — not a generic multi-tenant lookup.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.plugin_chat_agent import PluginChatAgent
from ..schemas.plugin_chat_agent import PluginChatAgentResponse

router = APIRouter(prefix="/internal/plugins/me/config", tags=["internal:plugins"])


def _own_plugin_name(principal: ServicePrincipal) -> str:
    names = principal.logical_names
    if len(names) != 1:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not resolve a single plugin identity for this caller.",
        )
    (name,) = names
    return name.removeprefix("system:")


@router.get("/{role}", response_model=PluginChatAgentResponse)
async def get_own_config_by_role(
    role: str,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> PluginChatAgentResponse:
    plugin_name = _own_plugin_name(principal)
    row = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == principal.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
            PluginChatAgent.role == role,
            PluginChatAgent.active.is_(True),
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return PluginChatAgentResponse.model_validate(row)
