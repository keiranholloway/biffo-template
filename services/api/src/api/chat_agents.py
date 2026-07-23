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

from collections.abc import Callable
from dataclasses import dataclass


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
