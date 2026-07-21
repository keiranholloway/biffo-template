"""The turn loop: incremental events, and the §8 hard stops."""

from __future__ import annotations

from agent_runtime.loop import (
    LAMBDA_MAX_SECONDS,
    MAX_TURNS_CEILING_ENV,
    MESSAGE,
    RUN_FINISHED,
    RUN_STARTED,
    TIMEOUT_CEILING_ENV,
    TURN_COMPLETED,
    TURN_STARTED,
    AgentLoop,
    RunLimits,
    collect,
)
from agent_runtime.openrouter import LLMResponse
from agent_runtime.state import COMPLETED, FAILED
from agent_runtime_fakes import FakeClock, FakeLLM, llm_error


def _limits(max_turns: int = 1, timeout: float = 60.0) -> RunLimits:
    return RunLimits(max_turns=max_turns, timeout_seconds=timeout)


async def _stream(loop: AgentLoop, **kwargs):
    defaults = {
        "model": "anthropic/claude-opus-4-8",
        "instructions": "Enrich this lead.",
        "input_payload": {"company": "Acme"},
        "limits": _limits(),
    }
    return [event async for event in loop.stream(**{**defaults, **kwargs})]


async def test_a_successful_run_emits_events_as_it_goes():
    # §6.3: the loop is internally incremental. It reports each step as it
    # happens, so streaming later attaches a different consumer rather than
    # rewriting this loop.
    events = await _stream(AgentLoop(FakeLLM()))

    kinds = [event.kind for event in events]
    assert kinds == [
        RUN_STARTED,
        MESSAGE,  # system
        MESSAGE,  # untrusted context
        TURN_STARTED,
        MESSAGE,  # assistant
        TURN_COMPLETED,
        RUN_FINISHED,
    ]
    assert events[-1].data["status"] == COMPLETED


async def test_collect_folds_the_stream_into_one_outcome():
    loop = AgentLoop(FakeLLM())

    outcome = await collect(
        loop.stream(
            model="anthropic/claude-opus-4-8",
            instructions="Enrich this lead.",
            input_payload={"company": "Acme"},
            limits=_limits(),
        )
    )

    assert outcome.status == COMPLETED
    assert [m["role"] for m in outcome.messages] == ["system", "user", "assistant"]
    assert outcome.result == {
        "output": "done",
        "model": "anthropic/claude-opus-4-8",
        "turns": 1,
        "finish_reason": "stop",
    }
    assert (outcome.input_tokens, outcome.output_tokens, outcome.cost_usd) == (10, 4, 0.002)
    assert outcome.error is None


async def test_the_whole_message_array_is_sent_on_each_turn():
    llm = FakeLLM()

    await _stream(AgentLoop(llm))

    assert [m["role"] for m in llm.calls[0]["messages"]] == ["system", "user"]


async def test_max_turns_is_a_hard_stop_and_fails_the_run():
    # A model that keeps asking for another turn is stopped at the limit, and
    # the run terminates *failed* — §5 requires a subscriber to tell a finished
    # run from a curtailed one.
    always_more = LLMResponse(content="thinking", model="m", finish_reason="tool_calls")
    llm = FakeLLM(always_more)

    outcome = await collect(
        AgentLoop(llm).stream(
            model="m",
            instructions="Go",
            input_payload={},
            limits=_limits(max_turns=3),
        )
    )

    assert len(llm.calls) == 3
    assert outcome.status == FAILED
    assert "max_turns" in (outcome.error or "")
    # The transcript survives the stop: three assistant turns plus the opening two.
    assert len(outcome.messages) == 5


async def test_wall_clock_is_a_hard_stop_between_turns():
    always_more = LLMResponse(content="thinking", model="m", finish_reason="tool_calls")
    llm = FakeLLM(always_more)
    # Each clock read advances 40s; the loop reads it once per turn check.
    loop = AgentLoop(llm, clock=FakeClock(step=40.0))

    outcome = await collect(
        loop.stream(
            model="m",
            instructions="Go",
            input_payload={},
            limits=_limits(max_turns=10, timeout=100.0),
        )
    )

    assert outcome.status == FAILED
    assert "Wall-clock limit" in (outcome.error or "")
    assert len(llm.calls) < 10


async def test_an_llm_failure_terminates_the_run_rather_than_hanging():
    outcome = await collect(
        AgentLoop(FakeLLM(error=llm_error("502 from provider"))).stream(
            model="m", instructions="Go", input_payload={}, limits=_limits()
        )
    )

    assert outcome.status == FAILED
    assert "502 from provider" in (outcome.error or "")


async def test_limits_come_from_the_snapshot():
    limits = RunLimits.from_snapshot({"max_turns": 4, "timeout_seconds": 30})

    assert (limits.max_turns, limits.timeout_seconds) == (4, 30.0)


async def test_limits_default_when_the_snapshot_is_silent_or_nonsense():
    assert RunLimits.from_snapshot({}).max_turns == 1
    assert RunLimits.from_snapshot({"max_turns": 0}).max_turns == 1
    assert RunLimits.from_snapshot({"max_turns": "lots"}).max_turns == 1
    assert RunLimits.from_snapshot({"timeout_seconds": -5}).timeout_seconds == 120.0


async def test_a_worker_can_only_narrow_the_deployment_ceilings(monkeypatch):
    monkeypatch.setenv(MAX_TURNS_CEILING_ENV, "3")
    monkeypatch.setenv(TIMEOUT_CEILING_ENV, "60")

    limits = RunLimits.from_snapshot({"max_turns": 99, "timeout_seconds": 9999})

    assert limits.max_turns == 3
    assert limits.timeout_seconds == 60.0


async def test_the_platform_ceiling_wins_over_a_misconfigured_deployment(monkeypatch):
    # §8: a per-worker wall clock must sit inside the 15-minute Lambda cap, not
    # merely inside a cost budget.
    monkeypatch.setenv(TIMEOUT_CEILING_ENV, "100000")

    assert RunLimits.from_snapshot({"timeout_seconds": 99999}).timeout_seconds == float(
        LAMBDA_MAX_SECONDS
    )
