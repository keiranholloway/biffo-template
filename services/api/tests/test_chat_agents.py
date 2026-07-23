"""The chat-agent registry (api.chat_agents, ADR-0017 §1).

Importing api.agent_assistant registers the prompt assistant as the first chat
agent; these tests pin that registration and the resolve/unknown-key seam.
"""

# Import for its registration side effect (the prompt assistant registers on import).
import api.agent_assistant  # noqa: F401
import pytest
from api.agent_assistant import ASSISTANT_AGENT_KEY, ASSISTANT_SYSTEM_PROMPT
from api.chat_agents import (
    ChatAgent,
    UnknownChatAgentError,
    get_chat_agent,
    register_chat_agent,
    registered_agent_keys,
)
from api.config import settings


def test_prompt_assistant_is_registered() -> None:
    assert ASSISTANT_AGENT_KEY in registered_agent_keys()


def test_resolves_the_prompt_assistant_agent() -> None:
    agent = get_chat_agent(ASSISTANT_AGENT_KEY)
    assert agent.agent_key == ASSISTANT_AGENT_KEY
    assert agent.agent_name == "prompt-assistant"
    assert agent.system_prompt == ASSISTANT_SYSTEM_PROMPT
    assert agent.required_group == "admin"  # admin-gated (ADR-0017 §3)
    # config resolves live from settings, not captured at import
    assert agent.model == settings.agent_assistant_model
    assert agent.max_history_messages == settings.agent_assistant_max_history_messages


def test_the_request_never_carries_the_prompt_only_the_key() -> None:
    # The system prompt is resolved server-side from the key — a caller cannot
    # supply or override it (ADR-0016 §1 / ADR-0017 §1). The agent is keyed data,
    # not request data.
    agent = get_chat_agent(ASSISTANT_AGENT_KEY)
    assert isinstance(agent, ChatAgent)
    assert agent.system_prompt  # comes from the registry, not from any request


def test_an_unknown_key_raises() -> None:
    with pytest.raises(UnknownChatAgentError):
        get_chat_agent("no-such-agent")


def test_a_builder_resolves_config_at_request_time() -> None:
    calls: list[int] = []

    def _builder() -> ChatAgent:
        calls.append(1)
        return ChatAgent(
            agent_key="ephemeral",
            agent_name="ephemeral",
            system_prompt="p",
            model="m",
            required_group="founder",
            max_history_messages=10,
            max_output_tokens=100,
            timeout_seconds=5.0,
        )

    register_chat_agent("ephemeral", _builder)
    assert calls == []  # registration does not build
    get_chat_agent("ephemeral")
    get_chat_agent("ephemeral")
    assert len(calls) == 2  # built fresh on each resolve
