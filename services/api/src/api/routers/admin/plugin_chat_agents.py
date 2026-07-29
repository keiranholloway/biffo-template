"""Admin CRUD for live-editable plugin chat agents (ADR-0017 seam #1 extension).

Cognito-authenticated, admin-gated, tenant-scoped (ADR-0001/ADR-0004). This is
the runtime-editing surface for chat agents in opted-in plugins: create/read/
list/update/delete of ``PluginChatAgent``. Unlike the static manifest-based
registration (which happens at Lambda cold-start), these rows are editable at
runtime without a redeploy — the fallback path in internal_agent_chat.py queries
this table when an agent_key is not found in the static registry, so an admin can
add entirely new agent keys the registry never saw.

Every query is scoped to the caller's verified ``tenant_id``: an agent in another
tenant is a 404, never visible.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...models.plugin_chat_agent import PluginChatAgent
from ...models.plugin_chat_agent_history import PluginChatAgentHistory
from ...schemas.plugin_chat_agent import (
    CreatePluginChatAgentRequest,
    PluginChatAgentHistoryResponse,
    PluginChatAgentResponse,
    UpdatePluginChatAgentRequest,
)

router = APIRouter(tags=["admin"])


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Plugin chat agent not found"
    )


def _duplicate(plugin_name: str, agent_key: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"Chat agent {agent_key!r} already exists for plugin {plugin_name!r}.",
    )


@router.get(
    "/admin/plugins/{plugin_name}/chat-agents", response_model=list[PluginChatAgentResponse]
)
async def list_plugin_chat_agents(
    plugin_name: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[PluginChatAgentResponse]:
    """List all chat agents for a plugin, tenant-scoped and ordered by agent_key."""
    rows = await db.scalars(
        select(PluginChatAgent)
        .where(
            PluginChatAgent.tenant_id == caller.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
        )
        .order_by(PluginChatAgent.agent_key)
    )
    return [PluginChatAgentResponse.model_validate(r) for r in rows]


@router.post(
    "/admin/plugins/{plugin_name}/chat-agents",
    response_model=PluginChatAgentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_plugin_chat_agent(
    plugin_name: str,
    body: CreatePluginChatAgentRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PluginChatAgentResponse:
    """Create a new live-editable chat agent for a plugin."""
    # Check for duplicates before insert
    existing = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == caller.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
            PluginChatAgent.agent_key == body.agent_key,
        )
    )
    if existing is not None:
        raise _duplicate(plugin_name, body.agent_key)

    agent = PluginChatAgent(
        tenant_id=caller.tenant_id,
        plugin_name=plugin_name,
        agent_key=body.agent_key,
        agent_name=body.agent_name,
        role=body.role,
        system_prompt=body.system_prompt,
        model=body.model,
        required_group=body.required_group,
        active=body.active,
        max_history_messages=body.max_history_messages,
        max_output_tokens=body.max_output_tokens,
        timeout_seconds=body.timeout_seconds,
    )
    db.add(agent)
    await db.flush()
    await db.refresh(agent)
    return PluginChatAgentResponse.model_validate(agent)


@router.get(
    "/admin/plugins/{plugin_name}/chat-agents/{agent_key}",
    response_model=PluginChatAgentResponse,
)
async def get_plugin_chat_agent(
    plugin_name: str,
    agent_key: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PluginChatAgentResponse:
    """Retrieve a single chat agent by plugin and key."""
    row = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == caller.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
            PluginChatAgent.agent_key == agent_key,
        )
    )
    if row is None:
        raise _not_found()
    return PluginChatAgentResponse.model_validate(row)


@router.put(
    "/admin/plugins/{plugin_name}/chat-agents/{agent_key}",
    response_model=PluginChatAgentResponse,
)
async def update_plugin_chat_agent(
    plugin_name: str,
    agent_key: str,
    body: UpdatePluginChatAgentRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PluginChatAgentResponse:
    """Update a chat agent (full replace of mutable fields; agent_key/plugin_name cannot change)."""
    row = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == caller.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
            PluginChatAgent.agent_key == agent_key,
        )
    )
    if row is None:
        raise _not_found()

    # Check if anything actually changed before writing history.
    changed = (
        row.agent_name != body.agent_name
        or row.role != body.role
        or row.system_prompt != body.system_prompt
        or row.model != body.model
        or row.required_group != body.required_group
        or row.active != body.active
        or row.max_history_messages != body.max_history_messages
        or row.max_output_tokens != body.max_output_tokens
        or row.timeout_seconds != body.timeout_seconds
    )

    if changed:
        # Determine the next version number for this agent.
        max_version_result = await db.scalar(
            select(func.max(PluginChatAgentHistory.version)).where(
                PluginChatAgentHistory.tenant_id == caller.tenant_id,
                PluginChatAgentHistory.plugin_chat_agent_id == row.id,
            )
        )
        next_version = (max_version_result or 0) + 1

        # Record the previous values in history before mutating the row.
        changed_by = caller.email if caller.email else caller.sub
        history = PluginChatAgentHistory(
            tenant_id=caller.tenant_id,
            plugin_chat_agent_id=row.id,
            plugin_name=row.plugin_name,
            agent_key=row.agent_key,
            version=next_version,
            agent_name=row.agent_name,
            role=row.role,
            system_prompt=row.system_prompt,
            model=row.model,
            required_group=row.required_group,
            active=row.active,
            max_history_messages=row.max_history_messages,
            max_output_tokens=row.max_output_tokens,
            timeout_seconds=row.timeout_seconds,
            changed_by=changed_by,
        )
        db.add(history)

    # Update the row with new values.
    row.agent_name = body.agent_name
    row.role = body.role
    row.system_prompt = body.system_prompt
    row.model = body.model
    row.required_group = body.required_group
    row.active = body.active
    row.max_history_messages = body.max_history_messages
    row.max_output_tokens = body.max_output_tokens
    row.timeout_seconds = body.timeout_seconds
    await db.flush()
    await db.refresh(row)
    return PluginChatAgentResponse.model_validate(row)


@router.get(
    "/admin/plugins/{plugin_name}/chat-agents/{agent_key}/history",
    response_model=list[PluginChatAgentHistoryResponse],
)
async def list_plugin_chat_agent_history(
    plugin_name: str,
    agent_key: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[PluginChatAgentHistoryResponse]:
    """List edit history for a chat agent, newest first. Tenant-scoped."""
    # Check that the agent exists (so a missing agent is 404, not empty list).
    agent = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == caller.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
            PluginChatAgent.agent_key == agent_key,
        )
    )
    if agent is None:
        raise _not_found()

    # Fetch the history, newest first.
    rows = await db.scalars(
        select(PluginChatAgentHistory)
        .where(
            PluginChatAgentHistory.tenant_id == caller.tenant_id,
            PluginChatAgentHistory.plugin_chat_agent_id == agent.id,
        )
        .order_by(PluginChatAgentHistory.version.desc())
    )
    return [PluginChatAgentHistoryResponse.model_validate(r) for r in rows]


@router.delete(
    "/admin/plugins/{plugin_name}/chat-agents/{agent_key}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_plugin_chat_agent(
    plugin_name: str,
    agent_key: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Hard delete a chat agent."""
    row = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == caller.tenant_id,
            PluginChatAgent.plugin_name == plugin_name,
            PluginChatAgent.agent_key == agent_key,
        )
    )
    if row is None:
        raise _not_found()
    await db.delete(row)
