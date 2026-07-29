"""Internal, SigV4-only read for a plugin's own admin-set config (ADR-0009).

GET /api/v1/internal/plugins/me/config/{role} — a plugin reads one of its own
plugin_chat_agents rows (by role, e.g. "analyst"), scoped to its own verified
identity (ServicePrincipal.logical_names), not a caller-supplied plugin name —
that would let any allowlisted service read another plugin's config. No
forwarded founder token: this data isn't founder-owned, and the whole point is
that a plugin's founder-triggered backend code has no way to obtain one (every
outbound Core call it makes is SigV4-signed, which cannot also carry a real
bearer JWT — see issue #621 for the general gap this is one instance of).

GET /api/v1/internal/plugins/me/config — the list counterpart: every one of the
caller's own active rows (optionally filtered by ?role=), for a founder-facing
picker (e.g. "which challenger personas are active") that needs more than one
row, not a single by-role lookup. Same identity/auth scoping as above.

Single-tenant deployment (ADR-0001): tenant_id is hardcoded "default", matching
ServicePrincipal's own default — not a generic multi-tenant lookup.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.plugin_chat_agent import PluginChatAgent
from ..schemas.plugin_chat_agent import (
    PluginChatAgentResponse,
    SeedPluginChatAgentRequest,
    SeedPluginChatAgentResponse,
)

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


@router.get("", response_model=list[PluginChatAgentResponse])
async def list_own_config(
    role: str | None = Query(default=None),
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[PluginChatAgentResponse]:
    """Every one of the caller's own active rows, optionally filtered to one
    role — ordered by agent_key for a stable list."""
    plugin_name = _own_plugin_name(principal)
    conditions = [
        PluginChatAgent.tenant_id == principal.tenant_id,
        PluginChatAgent.plugin_name == plugin_name,
        PluginChatAgent.active.is_(True),
    ]
    if role is not None:
        conditions.append(PluginChatAgent.role == role)
    rows = await db.scalars(
        select(PluginChatAgent).where(*conditions).order_by(PluginChatAgent.agent_key)
    )
    return [PluginChatAgentResponse.model_validate(r) for r in rows]


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


@router.post("/seed", response_model=list[SeedPluginChatAgentResponse])
async def seed_config(
    definitions: list[SeedPluginChatAgentRequest],
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[SeedPluginChatAgentResponse]:
    """Seed plugin chat agent configs for the caller's own plugin.

    Inserts any role definitions that do not already exist (determined by the
    unique constraint on tenant_id + plugin_name + agent_key). Existing rows
    are never overwritten, regardless of differences in their stored values.

    This is the critical property that enables plugins to guarantee their configs
    exist at startup without destroying admin-edited rows on every cold start.
    An existing row means an admin has (or previously had) control of that agent;
    those values are preserved exactly, even when the caller supplies different
    values. Admin edits are the normal case — they reflect the *current* state
    the operator chose, not the built-in constant the plugin was born with.

    Runs on every plugin cold start. Idempotent: calling it twice produces the
    same result and changes nothing on the second call.

    Does not create PluginChatAgentHistory rows. History records *admin edits*;
    a seed-created row is the row's origin, not a change to it.

    Args:
        definitions: List of role definitions to seed. Each must include all
            required fields. Empty list is valid and creates nothing.
        principal: Verified service identity (resolved from ARN; never caller-supplied).
        db: Database session.

    Returns:
        List of results, one per input definition, reporting whether each was
        created or already existed.
    """
    if not definitions:
        return []

    plugin_name = _own_plugin_name(principal)

    # Fetch all existing agent_keys for this plugin in this tenant, in one query.
    existing = await db.scalars(
        select(PluginChatAgent.agent_key).where(
            PluginChatAgent.tenant_id == principal.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
        )
    )
    existing_keys = set(existing)

    results: list[SeedPluginChatAgentResponse] = []

    for definition in definitions:
        already_exists = definition.agent_key in existing_keys

        if not already_exists:
            # Insert only if it doesn't exist.
            agent = PluginChatAgent(
                tenant_id=principal.tenant_id,
                plugin_name=plugin_name,
                agent_key=definition.agent_key,
                agent_name=definition.agent_name,
                role=definition.role,
                system_prompt=definition.system_prompt,
                model=definition.model,
                required_group=definition.required_group,
                active=definition.active,
                max_history_messages=definition.max_history_messages,
                max_output_tokens=definition.max_output_tokens,
                timeout_seconds=definition.timeout_seconds,
            )
            db.add(agent)

        results.append(
            SeedPluginChatAgentResponse(role=definition.role, created=not already_exists)
        )

    await db.flush()
    return results
