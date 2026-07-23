"""The synchronous chat-turn path and its dispatch (ADR-0016, buffered amendment).

Covers, per the ADR's Phase-1 acceptance surface:

- the turn path reuses ``complete()`` (buffered), not the dormant ``stream()``;
- the turn is hard-bounded — output tokens and wall clock, clamped downward;
- a provider error / bad payload becomes a clean ``{"ok": False}`` result;
- ``handler`` routes a direct chat-invoke to the turn path and an EventBridge
  event to the (unchanged) worker path, in both directions.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from agent_runtime import main
from agent_runtime.chat_turn import (
    CHAT_TURN_KIND,
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_TIMEOUT_CEILING,
    is_chat_turn,
    run_chat_turn,
)
from agent_runtime.openrouter import LLMResponse
from agent_runtime_fakes import FakeLLM, llm_error

_MESSAGES = [
    {"role": "system", "content": "You are the prompt assistant."},
    {"role": "user", "content": "<untrusted-context>\nHelp me write a goal.\n</untrusted-context>"},
]


def _turn_event(**extra: Any) -> dict[str, Any]:
    return {
        "kind": CHAT_TURN_KIND,
        "model": "anthropic/claude-sonnet-4",
        "messages": _MESSAGES,
        **extra,
    }


# ── discrimination ───────────────────────────────────────────────────────────


def test_is_chat_turn_recognises_the_marker():
    assert is_chat_turn(_turn_event()) is True


def test_is_chat_turn_rejects_an_eventbridge_event():
    # The shape EventBridge delivers to the worker path — no chat-turn marker.
    eventbridge = {
        "source": "biffo.core",
        "detail-type": "agent.run.requested",
        "detail": {"schema_version": "1.0", "tenant_id": "default", "payload": {"run_id": "r1"}},
    }
    assert is_chat_turn(eventbridge) is False


# ── the turn itself ────────────────────────────────────────────────────────────


async def test_a_successful_turn_returns_the_buffered_reply():
    llm = FakeLLM(
        LLMResponse(
            content="Here is a draft goal.",
            model="anthropic/claude-sonnet-4",
            finish_reason="stop",
            input_tokens=42,
            output_tokens=11,
            cost_usd=0.0009,
        )
    )

    result = await run_chat_turn(_turn_event(), llm=llm)

    assert result == {
        "ok": True,
        "content": "Here is a draft goal.",
        "model": "anthropic/claude-sonnet-4",
        "finish_reason": "stop",
        "input_tokens": 42,
        "output_tokens": 11,
        "cost_usd": 0.0009,
    }
    # It used the buffered complete() with the assembled messages passed through.
    assert len(llm.calls) == 1
    assert llm.calls[0]["messages"] == _MESSAGES
    assert llm.calls[0]["tools"] is None


async def test_output_tokens_are_bounded_downward():
    llm = FakeLLM()

    # Ask for far more than the ceiling; the runtime clamps it.
    await run_chat_turn(_turn_event(max_output_tokens=1_000_000), llm=llm)
    assert llm.calls[0]["max_tokens"] == DEFAULT_MAX_OUTPUT_TOKENS

    # Ask for less; the smaller request is honoured.
    await run_chat_turn(_turn_event(max_output_tokens=16), llm=llm)
    assert llm.calls[1]["max_tokens"] == 16


async def test_wall_clock_is_bounded_downward_and_passed_to_the_provider():
    llm = FakeLLM()

    await run_chat_turn(_turn_event(timeout_seconds=9999), llm=llm)
    assert llm.calls[0]["timeout"] == DEFAULT_TIMEOUT_CEILING


async def test_the_wall_clock_is_a_hard_stop():
    class SlowLLM:
        async def complete(self, **_: Any) -> LLMResponse:
            await asyncio.sleep(10)
            raise AssertionError("should have been cancelled by the wall clock")

    # Ask for a tiny budget so the test doesn't actually wait.
    result = await run_chat_turn(_turn_event(timeout_seconds=0.01), llm=SlowLLM())
    assert result["ok"] is False
    assert "wall clock" in result["error"]


async def test_a_provider_error_is_a_clean_failure_not_a_crash():
    result = await run_chat_turn(_turn_event(), llm=FakeLLM(error=llm_error("provider exploded")))
    assert result["ok"] is False
    assert "provider exploded" in result["error"]


async def test_missing_model_and_messages_fail_cleanly():
    no_model = await run_chat_turn({"kind": CHAT_TURN_KIND, "messages": _MESSAGES}, llm=FakeLLM())
    no_messages = await run_chat_turn({"kind": CHAT_TURN_KIND, "model": "m"}, llm=FakeLLM())
    assert no_model["ok"] is False
    assert no_messages["ok"] is False


# ── dispatch through the Lambda handler ─────────────────────────────────────────


class _RecordingPlugin:
    """Stands in for AgentRuntimePlugin, recording dispatched worker events."""

    def __init__(self) -> None:
        self.dispatched: list[Any] = []
        recorder = self

        class _Events:
            async def dispatch(self, event: Any) -> None:
                recorder.dispatched.append(event)

        self.events = _Events()


def _ctx() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="agent-runtime",
        function_version="$LATEST",
        invoked_function_arn="arn:aws:lambda:eu-west-2:123456789012:function:agent-runtime",
        memory_limit_in_mb=1024,
        aws_request_id="req-1",
    )


def test_handler_routes_a_chat_invoke_to_the_turn_path(monkeypatch):
    llm = FakeLLM(
        LLMResponse(content="drafted", model="m", finish_reason="stop"),
    )
    plugin = _RecordingPlugin()
    monkeypatch.setattr(main, "_get_llm", lambda: llm)
    monkeypatch.setattr(main, "_get_plugin", lambda: plugin)

    out = main.handler(_turn_event(), _ctx())

    assert out == {
        "ok": True,
        "content": "drafted",
        "model": "m",
        "finish_reason": "stop",
        "input_tokens": None,
        "output_tokens": None,
        "cost_usd": None,
    }
    # The worker path was never touched.
    assert plugin.dispatched == []
    assert len(llm.calls) == 1


def test_handler_routes_an_eventbridge_event_to_the_unchanged_worker_path(monkeypatch):
    llm = FakeLLM()
    plugin = _RecordingPlugin()
    monkeypatch.setattr(main, "_get_llm", lambda: llm)
    monkeypatch.setattr(main, "_get_plugin", lambda: plugin)

    eventbridge = {
        "source": "biffo.core",
        "detail-type": "agent.run.requested",
        "detail": {"schema_version": "1.0", "tenant_id": "default", "payload": {"run_id": "r1"}},
    }
    out = main.handler(eventbridge, _ctx())

    # Unchanged worker contract: dispatched through the subscriber, statusCode 200,
    # and the chat-turn LLM client never called.
    assert out == {"statusCode": 200}
    assert len(plugin.dispatched) == 1
    assert plugin.dispatched[0].detail_type == "agent.run.requested"
    assert plugin.dispatched[0].payload == {"run_id": "r1"}
    assert llm.calls == []
