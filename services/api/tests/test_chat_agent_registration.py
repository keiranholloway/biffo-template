"""Manifest-driven chat-agent registration (ADR-0017 seam #1, ADR-0021)."""

from __future__ import annotations

import pytest
from api.chat_agents import UnknownChatAgentError, get_chat_agent
from api.routing.chat_agent_registration import (
    PluginChatAgentDef,
    register_plugin_chat_agents,
)

_CHALLENGER = {
    "key": "ideation-challenger",
    "agent_name": "ideation-challenger",
    "system_prompt": "You are a constructively skeptical co-founder. Ask one question.",
    "model": "anthropic/claude-sonnet-4",
    "required_group": "founder",
}


def _manifest(**over):
    return {"name": "ideation", "chat_agents": [{**_CHALLENGER, **over}]}


def test_registers_a_declared_chat_agent_resolvable_by_key():
    keys = register_plugin_chat_agents([_manifest()])
    assert keys == ["ideation-challenger"]
    agent = get_chat_agent("ideation-challenger")
    assert agent.system_prompt == _CHALLENGER["system_prompt"]
    assert agent.model == "anthropic/claude-sonnet-4"
    assert agent.required_group == "founder"
    assert agent.agent_name == "ideation-challenger"
    # Defaults for the omitted bounds match Core's assistant values.
    assert agent.max_history_messages == 40
    assert agent.max_output_tokens == 1024
    assert agent.timeout_seconds == 20.0


def test_agent_name_defaults_to_key():
    register_plugin_chat_agents([_manifest(agent_name=None)])
    assert get_chat_agent("ideation-challenger").agent_name == "ideation-challenger"


def test_manifest_without_chat_agents_registers_nothing():
    assert register_plugin_chat_agents([{"name": "rbac"}]) == []


def test_each_agent_builder_returns_its_own_agent_not_the_loop_last():
    """The default-arg capture must bind each agent, not the loop variable."""
    two = {
        "name": "multi",
        "chat_agents": [
            {**_CHALLENGER, "key": "agent-a", "system_prompt": "A"},
            {**_CHALLENGER, "key": "agent-b", "system_prompt": "B"},
        ],
    }
    register_plugin_chat_agents([two])
    assert get_chat_agent("agent-a").system_prompt == "A"
    assert get_chat_agent("agent-b").system_prompt == "B"


def test_invalid_agent_is_skipped_not_fatal():
    """A malformed entry is skipped with a warning; valid siblings still register."""
    manifest = {
        "name": "mixed",
        "chat_agents": [
            {"key": "BadKey", "system_prompt": "x", "model": "m", "required_group": "g"},  # bad key
            {**_CHALLENGER, "key": "good-agent"},
        ],
    }
    keys = register_plugin_chat_agents([manifest])
    assert keys == ["good-agent"]
    with pytest.raises(UnknownChatAgentError):
        get_chat_agent("BadKey")


def test_missing_required_field_is_rejected_by_the_model():
    with pytest.raises(ValueError):
        PluginChatAgentDef.model_validate({"key": "x", "model": "m", "required_group": "g"})


def test_empty_system_prompt_is_rejected():
    with pytest.raises(ValueError):
        PluginChatAgentDef.model_validate({**_CHALLENGER, "system_prompt": ""})
