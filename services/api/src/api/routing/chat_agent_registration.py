"""Register a plugin's chat agents from its manifest (ADR-0017 seam #1, ADR-0021).

The chat-agent registry (:mod:`api.chat_agents`) resolves a buffered chat turn's
trusted configuration — its system prompt, model, and the group that may drive it —
from an ``agent_key`` the request carries, NEVER from prompt text in the request
(ADR-0016 §1). For Core's own admin prompt-assistant that config is registered in
code; for a *plugin's* chat agent the config lives in the plugin's manifest — the
install-vetted record :mod:`api.chat_agents` anticipates. This module reads
``chat_agents`` from each installed manifest and registers one builder per agent, so
``/api/v1/internal/agent-chat/<key>`` resolves it.

A manifest declaring an invalid ``chat_agents`` entry is skipped with a warning
(one broken plugin must not break registration for the rest), matching
:mod:`api.routing.owner_data_router`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from aws_lambda_powertools import Logger
from pydantic import BaseModel, ConfigDict, Field

from ..chat_agents import ChatAgent, register_chat_agent
from ..plugins import discover_plugin_manifests

logger = Logger()


class PluginChatAgentDef(BaseModel):
    """One chat agent declared by a plugin manifest's ``chat_agents`` list.

    The bounds default to the same values Core's prompt assistant uses, so a plugin
    declares only the essentials (key, prompt, model, group). ``extra="forbid"`` so
    a typo'd field is a validation error, not a silently ignored one.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    #: The run's ``agent_name`` (the handle the admin run inspector groups under).
    #: Defaults to ``key`` when omitted.
    agent_name: str | None = None
    #: The trusted instruction channel (ADR-0016 §1) — install-vetted, never from a
    #: request. Required and non-empty.
    system_prompt: str = Field(min_length=1)
    model: str = Field(min_length=1)
    #: The Cognito group a caller must be in to drive this agent (ADR-0017 §3).
    required_group: str = Field(min_length=1)
    max_history_messages: int = Field(default=40, gt=0)
    max_output_tokens: int = Field(default=1024, gt=0)
    timeout_seconds: float = Field(default=20.0, gt=0)

    def to_chat_agent(self) -> ChatAgent:
        return ChatAgent(
            agent_key=self.key,
            agent_name=self.agent_name or self.key,
            system_prompt=self.system_prompt,
            model=self.model,
            required_group=self.required_group,
            max_history_messages=self.max_history_messages,
            max_output_tokens=self.max_output_tokens,
            timeout_seconds=self.timeout_seconds,
        )


def register_plugin_chat_agents(manifests: Sequence[dict[str, Any]] | None = None) -> list[str]:
    """Register every chat agent declared across the installed plugin manifests.

    Defaults to :func:`discover_plugin_manifests`; tests pass an explicit list.
    Returns the keys registered (for logging/tests). Idempotent by key — a
    re-registration replaces the builder, matching :func:`register_chat_agent`.
    """
    discovered = discover_plugin_manifests() if manifests is None else manifests
    registered: list[str] = []
    for manifest in discovered:
        name = manifest.get("name")
        raw_agents = manifest.get("chat_agents")
        if not raw_agents:
            continue
        if not isinstance(raw_agents, list):
            logger.warning(f"Skipping chat_agents for plugin {name!r}: not a list.")
            continue
        for raw in raw_agents:
            try:
                agent_def = PluginChatAgentDef.model_validate(raw)
            except (ValueError, TypeError) as exc:
                logger.warning(f"Skipping a chat agent for plugin {name!r}: invalid: {exc}")
                continue
            # Bind agent_def per iteration (default-arg capture) so each builder
            # returns its OWN agent, not the loop's last one.
            register_chat_agent(agent_def.key, lambda d=agent_def: d.to_chat_agent())
            registered.append(agent_def.key)
    return registered
