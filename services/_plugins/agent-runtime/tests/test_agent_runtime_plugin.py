"""End to end over the fakes: claim -> turn loop -> completion POST."""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from agent_runtime.loop import AgentLoop
from agent_runtime.openrouter import LLMResponse
from agent_runtime.plugin import AGENT_RUN_REQUESTED, AGENT_RUNS_REAP_DUE, AgentRuntimePlugin
from agent_runtime.redaction import EMAIL_PLACEHOLDER
from agent_runtime_fakes import FakeClock, FakeCore, FakeLLM, llm_error, make_run
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
    # Read, then CLAIM, then report. The claim sits before the model call so a
    # duplicate delivery loses before it can spend anything (issue #371).
    assert methods_and_paths == [
        ("GET", "/api/v1/internal/agent-runs/run-1"),
        ("POST", "/api/v1/internal/agent-runs/run-1/claim"),
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


async def test_goals_from_the_snapshot_reach_the_system_message():
    # goals is read from the SAME snapshot source as instructions and folded into
    # the system prompt (ADR-0014). A snapshot that predates the field carries none.
    core = FakeCore(make_run(goals="A confidence-rated verdict per dimension."))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    system = llm.calls[0]["messages"][0]["content"]
    assert "A confidence-rated verdict per dimension." in system
    assert "Success criteria:" in system


async def test_a_snapshot_without_goals_omits_the_goals_section():
    core = FakeCore(make_run())  # no goals key at all — the backward-compat path
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert "Success criteria:" not in llm.calls[0]["messages"][0]["content"]


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


async def test_a_lost_claim_makes_no_provider_call_at_all():
    """The #371 case, and the only one that costs money to get wrong.

    Two concurrent deliveries both read ``pending`` — the local status check
    cannot separate them. Core's claim does, and the loser must stop *before*
    the model call: `llm.calls == []` is the assertion that money was not spent.
    """
    core = FakeCore(claim_status=409)
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    # It tried to claim (so it is genuinely the loser, not a run it skipped
    # earlier), and it reported nothing — the winner owns the completion.
    assert core.claims() == ["/api/v1/internal/agent-runs/run-1/claim"]
    assert core.completions() == []


async def test_a_claim_that_fails_for_any_other_reason_also_spends_nothing():
    # An unclaimed run is one a duplicate delivery can still pick up. Executing
    # anyway on a 500 would reinstate the double-spend this exists to prevent.
    core = FakeCore(claim_status=503)
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    assert core.completions() == []


async def test_the_winner_executes_using_the_post_claim_record():
    # Core's claim response is the authority: it carries `running`, so the run
    # the loop executes is the claimed one, not the stale pre-claim read.
    core = FakeCore()
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert len(llm.calls) == 1
    assert core.completions()[0]["status"] == "completed"


async def test_a_snapshot_without_instructions_fails_the_run_without_calling_the_model():
    core = FakeCore(make_run(instructions=""))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    assert core.completions()[0]["status"] == "failed"
    assert "instructions" in core.completions()[0]["error"]


async def test_a_declared_tool_this_build_does_not_register_fails_before_any_spend():
    """§7's loud failure, and the reason it is loud.

    Silently dropping the tool produces a run that looks exactly like a model
    choosing not to call one — same transcript, same status, same cost — so the
    definition stays wrong indefinitely. Failing costs nothing: the check runs
    before the first model call, which ``llm.calls == []`` is what proves.
    """
    core = FakeCore(make_run(tools=["read_database"]))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert llm.calls == []
    assert core.completions()[0]["status"] == "failed"
    error = core.completions()[0]["error"]
    assert "read_database" in error
    assert "web_search" in error  # names what this build does register


async def test_a_declared_tool_that_is_not_configured_still_runs_the_worker(monkeypatch):
    # The other half of the pair: a missing credential is an operational state,
    # not a broken definition, so the run proceeds with one fewer capability.
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY_PARAMETER", raising=False)
    core = FakeCore(make_run(tools=["web_search"]))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert core.completions()[0]["status"] == "completed"
    assert llm.calls[0]["tools"] is None


async def test_a_configured_declared_tool_is_offered_to_the_model(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "not-a-real-brave-key")
    core = FakeCore(make_run(tools=["web_search"], max_turns=2))
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    offered = llm.calls[0]["tools"]
    assert [entry["function"]["name"] for entry in offered] == ["web_search"]


async def test_a_worker_declaring_nothing_is_offered_nothing(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "not-a-real-brave-key")
    core = FakeCore(make_run())
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    # Configured is not the same as offered — the worker never asked for it (§7).
    assert llm.calls[0]["tools"] is None


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


async def test_receipt_is_logged_with_run_id_before_any_claim_attempt(caplog):
    # biffo-template#1017: this line is the runtime's half of localising an
    # undelivered agent.run.requested. It must be independently greppable by
    # run_id — not only present inside a raw event dump — and must appear
    # even when the claim that follows loses the race, since a reader
    # diagnosing "never claimed" needs to know the event at least arrived.
    core = FakeCore(complete_status=409)  # claim path is irrelevant here

    with caplog.at_level(logging.INFO):
        await _plugin(core, FakeLLM()).events.dispatch(_event(run_id="run-42"))

    received = [r for r in caplog.records if r.getMessage() == "agent.run.requested received"]
    assert len(received) == 1
    assert received[0].__dict__["run_id"] == "run-42"


async def test_receipt_is_logged_even_when_the_claim_is_lost_to_a_duplicate(caplog):
    # The receipt log must not be contingent on winning the claim race — it is
    # evidence the EVENT arrived, independent of what happens to the run. A
    # 409 here means another invocation already owns the run (§5); the receipt
    # line must still have fired before that was known.
    core = FakeCore(claim_status=409)

    with caplog.at_level(logging.INFO):
        await _plugin(core, FakeLLM()).events.dispatch(_event(run_id="run-42"))

    received = [r for r in caplog.records if r.getMessage() == "agent.run.requested received"]
    assert len(received) == 1
    assert received[0].__dict__["run_id"] == "run-42"


async def test_a_failed_completion_post_does_not_raise_into_the_lambda():
    # Core refusing the completion (409, already terminal) leaves the run
    # stranded — §5's second divergence point. It is logged, not crashed on:
    # crashing would make EventBridge redeliver and re-run the model.
    core = FakeCore(complete_status=409)

    await _plugin(core, FakeLLM()).events.dispatch(_event())

    assert len(core.completions()) == 1


# ── Stale-run sweep (ADR-0014 §5, issue #402) ────────────────────────────────


def _reap_event() -> BiffoEvent:
    """The schedule tick, as this plugin's own EventBridge rule synthesises it."""
    return BiffoEvent(detail_type=AGENT_RUNS_REAP_DUE, payload={})


async def test_the_schedule_tick_asks_core_to_sweep():
    core = FakeCore(reaped=[make_run("run-9", status="failed")])
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_reap_event())

    assert core.reaps() == ["/api/v1/internal/agent-runs/reap"]
    # The sweep is Core's work: the runtime decides nothing about staleness and
    # must never call the model on this path.
    assert llm.calls == []
    assert core.completions() == []


async def test_a_sweep_with_nothing_stale_is_harmless():
    core = FakeCore(reaped=[])
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_reap_event())

    assert core.reaps() == ["/api/v1/internal/agent-runs/reap"]
    assert llm.calls == []


async def test_a_failed_sweep_is_swallowed_not_raised():
    """One missed pass costs nothing; the next tick sweeps again.

    Raising would fail the Lambda invocation and earn an EventBridge retry
    storm against a Core that is evidently already unwell.
    """
    core = FakeCore(reap_status=503)
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_reap_event())

    assert llm.calls == []


async def test_a_run_request_does_not_trigger_a_sweep():
    # The two triggers are independent; execution must not do bookkeeping.
    core = FakeCore()
    llm = FakeLLM()

    await _plugin(core, llm).events.dispatch(_event())

    assert core.reaps() == []


# ── The wall-clock margin (issue #937) ───────────────────────────────────────
#
# A synthesis worker ran between 44% and 98% of the default 120s wall clock for
# eleven consecutive runs and then timed out. Every one of those runs reported
# "completed" and a duration; none reported the duration *against the limit*, so
# the drift toward the ceiling was invisible until it was a failure. The runtime
# now says the margin out loud on every terminated run.


def _timed_plugin(core: FakeCore, llm: FakeLLM, *, step: float) -> AgentRuntimePlugin:
    """A plugin whose loop uses a clock advancing ``step`` seconds per read."""
    return AgentRuntimePlugin(
        api=core.client(), llm=llm, loop=AgentLoop(llm, clock=FakeClock(step))
    )


def _wall_clock_logs(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """Every log line carrying the margin, as its flat structured fields."""
    return [dict(r.__dict__) for r in caplog.records if "wall_clock_share" in r.__dict__]


async def test_a_run_near_its_wall_clock_ceiling_is_reported_as_a_warning(caplog):
    core = FakeCore()
    llm = FakeLLM()
    # Two clock reads at 50s each land the run at 100s of the default 120s.
    plugin = _timed_plugin(core, llm, step=50.0)

    with caplog.at_level(logging.INFO):
        await plugin.events.dispatch(_event())

    records = _wall_clock_logs(caplog)
    assert len(records) == 1
    record = records[0]
    assert record["levelno"] == logging.WARNING
    assert record["wall_clock_share"] == pytest.approx(0.8333, abs=1e-3)
    assert record["wall_clock_pct"] == pytest.approx(83.3, abs=0.1)
    assert record["near_wall_clock_limit"] is True
    assert (record["elapsed_seconds"], record["timeout_seconds"]) == (100.0, 120.0)
    # Named so "which class of worker runs near its ceiling" is answerable.
    assert record["agent_name"] == "demo-enricher"
    assert record["run_id"] == "run-1"


async def test_a_run_with_headroom_reports_the_margin_without_crying_wolf(caplog):
    core = FakeCore()
    llm = FakeLLM()
    plugin = _timed_plugin(core, llm, step=6.0)

    with caplog.at_level(logging.INFO):
        await plugin.events.dispatch(_event())

    records = _wall_clock_logs(caplog)
    assert len(records) == 1
    assert records[0]["levelno"] == logging.INFO
    assert records[0]["wall_clock_share"] == pytest.approx(0.1, abs=1e-4)
    assert records[0]["near_wall_clock_limit"] is False


async def test_a_run_raising_its_timeout_stops_being_flagged(caplog):
    """The margin follows the limit, not the duration.

    The same 100-second run that is a warning against the default 120s is
    unremarkable against the 240s a worker can ask for — which is exactly the
    fix an operator applies after seeing the warning, and it must show up.
    """
    core = FakeCore(make_run(timeout_seconds=240))
    llm = FakeLLM()
    plugin = _timed_plugin(core, llm, step=50.0)

    with caplog.at_level(logging.INFO):
        await plugin.events.dispatch(_event())

    record = _wall_clock_logs(caplog)[0]
    assert (record["elapsed_seconds"], record["timeout_seconds"]) == (100.0, 240.0)
    assert record["levelno"] == logging.INFO
    assert record["near_wall_clock_limit"] is False


async def test_a_run_that_failed_still_reports_its_margin(caplog):
    core = FakeCore()
    llm = FakeLLM(error=llm_error("502 from provider"))
    plugin = _timed_plugin(core, llm, step=10.0)

    with caplog.at_level(logging.INFO):
        await plugin.events.dispatch(_event())

    record = _wall_clock_logs(caplog)[0]
    assert record["status"] == "failed"
    assert record["elapsed_seconds"] == 20.0
