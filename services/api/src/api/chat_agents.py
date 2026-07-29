"""The chat-agent registry (ADR-0017 seam #1).

A **registered chat agent** pins everything the turn engine needs to run a buffered
chat: its trusted system prompt, model, the Cognito group that may use it, and the
turn's bounds. A chat-turn request carries the agent's **key, never prompt text** —
so the instruction channel is resolved server-side and can never be user-supplied
(ADR-0016 §1). The trust in a plugin-authored prompt comes from the install-time
review that registers it, not from the prompt being built in.

Phase 1 has one registered agent: the prompt assistant (``prompt-assistant``,
registered in :mod:`api.agent_assistant`). Registration is by *builder* rather than
a static record so an agent whose config lives in settings (the prompt assistant)
resolves it live, and a future plugin agent whose config lives in an install-time
record can resolve *that* — both behind the same :func:`get_chat_agent` seam.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

Message = dict[str, Any]


@dataclass(frozen=True)
class TurnContext:
    """An agent's optional first-party context for one turn (ADR-0016 §5).

    ``message`` is an extra message placed between the system prompt and the
    conversation (e.g. the prompt assistant's library-reference block), or ``None``.
    ``drop`` marks messages the agent re-derives each turn so a *stale* copy in the
    replayed history is not sent again (e.g. an old library block). An agent with no
    special context uses the default empty context and the engine runs a plain turn.
    """

    message: Message | None = None
    drop: Callable[[Message], bool] | None = None


#: An agent's context assembler: resolves its :class:`TurnContext` under the caller's
#: authority for one turn. Async and DB-taking (the prompt assistant reads the
#: library); an agent without one just gets the empty context.
ContextAssembler = Callable[..., Awaitable[TurnContext]]


@dataclass(frozen=True)
class ChatAgent:
    """A resolved chat agent — the turn engine's whole configuration for one turn."""

    agent_key: str
    #: The run's ``agent_name`` — the handle the admin run inspector groups under.
    agent_name: str
    #: The trusted instruction channel (ADR-0016 §1). Resolved here, never from the
    #: request.
    system_prompt: str
    model: str
    #: The Cognito group a caller must be in to drive this agent (ADR-0017 §3).
    required_group: str
    max_history_messages: int
    max_output_tokens: int
    timeout_seconds: float
    #: The registry row id when resolved from PluginChatAgent, None for static agents.
    #: Used to record which prompt version produced an agent run.
    id: str | None = None


class UnknownChatAgentError(KeyError):
    """No chat agent is registered under the requested key."""


_BUILDERS: dict[str, Callable[[], ChatAgent]] = {}


def register_chat_agent(agent_key: str, builder: Callable[[], ChatAgent]) -> None:
    """Register a chat agent under ``agent_key``. ``builder`` resolves the agent's
    current config when the agent is next requested (so settings/records read live).
    Idempotent by key — re-registering replaces the builder."""
    _BUILDERS[agent_key] = builder


def get_chat_agent(agent_key: str) -> ChatAgent:
    """Resolve the registered chat agent for ``agent_key``.

    Raises :class:`UnknownChatAgentError` for an unknown key — the ingress maps that
    to a 404, so an attacker cannot probe which agents exist by prompt content.
    """
    builder = _BUILDERS.get(agent_key)
    if builder is None:
        raise UnknownChatAgentError(agent_key)
    return builder()


def registered_agent_keys() -> frozenset[str]:
    """The keys currently registered — for diagnostics and tests."""
    return frozenset(_BUILDERS)


_CONTEXT_ASSEMBLERS: dict[str, ContextAssembler] = {}


def register_chat_context(agent_key: str, assembler: ContextAssembler) -> None:
    """Register an optional first-party context assembler for ``agent_key`` (e.g.
    the prompt assistant's library reference). An agent without one runs a plain
    turn. Idempotent by key."""
    _CONTEXT_ASSEMBLERS[agent_key] = assembler


def get_chat_context(agent_key: str) -> ContextAssembler | None:
    """The registered context assembler for ``agent_key``, or ``None``."""
    return _CONTEXT_ASSEMBLERS.get(agent_key)


async def get_dynamic_chat_agent(
    db: AsyncSession, *, tenant_id: str, agent_key: str
) -> ChatAgent | None:
    """Resolve a live, admin-editable chat agent by key (any plugin's), scoped
    to the caller's tenant and only if active. Returns None if not found —
    callers map that the same way as UnknownChatAgentError from the static
    registry (ADR-0017 seam #1 extension: the fallback for a plugin that opted
    into chat_agents_dynamic, including agent keys created after cold-start
    that the static _BUILDERS dict never saw)."""
    from .models.plugin_chat_agent import PluginChatAgent

    row = await db.scalar(
        select(PluginChatAgent).where(
            PluginChatAgent.tenant_id == tenant_id,
            PluginChatAgent.agent_key == agent_key,
            PluginChatAgent.active.is_(True),
        )
    )
    if row is None:
        return None
    return ChatAgent(
        agent_key=row.agent_key,
        agent_name=row.agent_name,
        system_prompt=row.system_prompt,
        model=row.model,
        required_group=row.required_group,
        max_history_messages=row.max_history_messages,
        max_output_tokens=row.max_output_tokens,
        timeout_seconds=row.timeout_seconds,
        id=row.id,
    )
