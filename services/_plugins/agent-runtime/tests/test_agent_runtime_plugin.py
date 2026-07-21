"""End to end over the fakes: claim -> turn loop -> completion POST."""

from __future__ import annotations

import json

from agent_runtime.openrouter import LLMResponse
from agent_runtime.plugin import AGENT_RUN_REQUESTED, AgentRuntimePlugin
from agent_runtime.redaction import EMAIL_PLACEHOLDER
from agent_runtime_fakes import FakeCore, FakeLLM, llm_error, make_run
from biffo_plugin_sdk import BiffoEvent


def _event(run_id: str = "run-1") -> BiffoEvent:
    """The reference payload Core emits — a run id, never the run's content (§5)."""
    return BiffoEvent(
        detail_type=AGENT_RUN_REQUESTED,
        payload={
            "run_id": run_id,
            "agent": "demo-enricher",
            "status": "pending",
            "causation_id": None,
            "depth": 0,
        },
    )


def _plugin(core: FakeCore, llm: FakeLLM) -> AgentRuntimePlugin:
    return AgentRuntimePlugin(api=core.client(), llm=llm)


async def test_manifest_declares_one_trigger_and_owns_no_data():
    manifest = _plugin(FakeCore(), FakeLLM()).manifest

    assert manifest.name == "agent-runtime"
    # ADR-0002: all state is Core's. This plugin has no tables and no routes.
    assert manifest.tables == []
    assert manifest.api_routes == []


async def test_a_successful_run_completes_and_posts_the_right_body():
    core = FakeCore()
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    methods_and_paths = [(m, p) for m, p, _ in core.requests]
    assert methods_and_paths == [
        ("GET", "/api/v1/internal/agent-runs/run-1"),
        ("POST", "/api/v1/internal/agent-runs/run-1/complete"),
    ]
    body = core.completions()[0]
    assert body["status"] == "completed"
    assert [m["role"] for m in body["messages"]] == ["system", "user", "assistant"]
    assert body["result"]["output"] == "done"
    assert body["error"] is None
    assert (body["input_tokens"], body["output_tokens"], body["cost_usd"]) == (10, 4, 0.002)


async def test_the_model_comes_from_the_run_snapshot():
    core = FakeCore(make_run(model="openai/gpt-5"))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls[0]["model"] == "openai/gpt-5"


async def test_an_llm_failure_completes_the_run_as_failed_rather_than_abandoning_it():
    # ADR-0014 §5: a subscriber must be able to tell "failed" from "still
    # running". A silently abandoned run is the stranding gap the ADR records.
    core = FakeCore()
    llm = FakeLLM(error=llm_error("provider 503"))

    await _plugin(core, llm).events.dispatch(_event())

    body = core.completions()[0]
    assert body["status"] == "failed"
    assert "provider 503" in body["error"]
    assert body["result"] is None


async def test_emails_are_redacted_before_the_payload_reaches_the_llm():
    core = FakeCore(make_run(input_payload={"company": "Acme", "email": "lead@acme.com"}))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    sent = json.dumps(llm.calls[0]["messages"])
    assert "lead@acme.com" not in sent
    assert EMAIL_PLACEHOLDER in sent
    # ...and the transcript Core persists carries the redacted form too.
    assert "lead@acme.com" not in json.dumps(core.completions()[0]["messages"])


async def test_max_turns_from_the_snapshot_bounds_the_run():
    core = FakeCore(make_run(max_turns=2))
    # A model that always asks for another turn — M1 sends no tools, so this is
    # only reachable with a fake, which is the point: the limit is real.
    llm = FakeLLM(LLMResponse(content="thinking", model="m", finish_reason="tool_calls"))

    await _plugin(core, llm).events.dispatch(_event())

    assert len(llm.calls) == 2
    assert core.completions()[0]["status"] == "failed"


async def test_a_run_that_is_not_pending_is_skipped_not_re_executed():
    # A replayed EventBridge delivery must not buy the same tokens twice.
    core = FakeCore(make_run(status="completed"))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    assert core.completions() == []


async def test_a_snapshot_without_instructions_fails_the_run_without_calling_the_model():
    core = FakeCore(make_run(instructions=""))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    assert core.completions()[0]["status"] == "failed"
    assert "instructions" in core.completions()[0]["error"]


async def test_a_snapshot_without_a_model_fails_the_run():
    core = FakeCore(make_run(model=""))

    await _plugin(core, FakeLLM()).events.dispatch(_event())

    assert core.completions()[0]["status"] == "failed"
    assert "model" in core.completions()[0]["error"]


async def test_an_unreadable_run_is_not_completed_by_guesswork():
    core = FakeCore(get_status=404)
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    assert core.completions() == []


async def test_an_event_without_a_run_id_is_ignored():
    core = FakeCore()

    await _plugin(core, FakeLLM()).events.dispatch(
        BiffoEvent(detail_type=AGENT_RUN_REQUESTED, payload={})
    )

    assert core.requests == []


async def test_a_failed_completion_post_does_not_raise_into_the_lambda():
    # Core refusing the completion (409, already terminal) leaves the run
    # stranded — §5's second divergence point. It is logged, not crashed on:
    # crashing would make EventBridge redeliver and re-run the model.
    core = FakeCore(complete_status=409)

    await _plugin(core, FakeLLM()).events.dispatch(_event())

    assert len(core.completions()) == 1
