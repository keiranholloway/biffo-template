"""Tests for OrchestratorPlugin.process_event — the engine flow end to end
(Core internal API + SES both faked)."""

from __future__ import annotations

import json
from typing import Any

from biffo_plugin_sdk import BiffoEvent
from orchestrator import plugin as plugin_module
from orchestrator.actions import WhatsAppSettings
from orchestrator.email_branding import EmailBranding
from orchestrator.plugin import OrchestratorPlugin
from orchestrator_fakes import (
    FakeCore,
    FakeHttp,
    FakeScheduler,
    FakeSes,
    FlakyHttp,
    FlakySes,
)


async def _no_sleep(_seconds: float) -> None:
    """Stand-in for asyncio.sleep so the retry tests don't pay the backoff."""
    return None


def _chat_run() -> dict[str, Any]:
    return {
        "run_id": "run-gc",
        "definition_id": "def-gc",
        "action_type": "google_chat",
        "action_config": {
            "webhook_url": "https://chat.googleapis.com/v1/spaces/A/messages?key=k",
            "message": "Demo from {company}",
        },
        "created": True,
    }


def _agent_run(**config: Any) -> dict[str, Any]:
    return {
        "run_id": "run-agent",
        "definition_id": "def-agent",
        "action_type": "agent",
        "action_config": {"agent_name": "looper", "instructions": "go", **config},
        "created": True,
    }


def _event(payload: dict[str, Any] | None = None) -> BiffoEvent:
    return BiffoEvent(
        source="biffo.core",
        detail_type="demo.requested",
        payload=payload or {"demo_request_id": "d1", "company": "Acme", "email": "lead@acme.com"},
    )


def _email_run(created: bool, **over: Any) -> dict[str, Any]:
    run = {
        "run_id": "run-1",
        "definition_id": "def-1",
        "action_type": "email",
        "action_config": {
            "from": "no-reply@example.com",
            "to": "sales@example.com",
            "subject": "Demo from {company}",
        },
        "created": created,
    }
    run.update(over)
    return run


async def test_process_event_executes_created_run():
    core = FakeCore([_email_run(created=True)])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    # The action fired exactly once.
    assert len(ses.calls) == 1
    assert ses.calls[0]["Content"]["Simple"]["Subject"]["Data"] == "Demo from Acme"
    # The outcome was recorded as succeeded with the SES message id.
    results = core.result_posts()
    assert len(results) == 1
    assert results[0]["status"] == "succeeded"
    assert results[0]["response"] == {"message_id": "ses-message-1", "attempts": 1}
    # The event was posted with the explicit idempotency key from the payload.
    assert core.event_posts()[0]["idempotency_key"] == "d1"


async def test_process_event_email_uses_configured_branding():
    core = FakeCore([_email_run(created=True)])
    ses = FakeSes()
    branding = EmailBranding(company_name="Acme Co", subject_prefix="[Acme] ")
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses, branding=branding)

    await plugin.process_event(_event())

    call = ses.calls[0]
    assert call["Content"]["Simple"]["Subject"]["Data"] == "[Acme] Demo from Acme"
    assert "Acme Co" in call["Content"]["Simple"]["Body"]["Html"]["Data"]


async def test_plugin_defaults_branding_when_not_passed():
    core = FakeCore([_email_run(created=True)])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    assert plugin._branding == EmailBranding()


async def test_process_event_dispatches_google_chat_via_http():
    run = {
        "run_id": "run-gc",
        "definition_id": "def-gc",
        "action_type": "google_chat",
        "action_config": {
            "webhook_url": "https://chat.googleapis.com/v1/spaces/A/messages?key=k",
            "message": "Demo from {company}",
        },
        "created": True,
    }
    core = FakeCore([run])
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.process_event(_event())

    assert len(http.calls) == 1
    assert http.calls[0]["json"] == {"text": "Demo from Acme"}
    results = core.result_posts()
    assert results[0]["status"] == "succeeded"
    assert results[0]["response"] == {"status_code": 200, "attempts": 1}


async def test_process_event_dispatches_whatsapp():
    run = {
        "run_id": "run-wa",
        "definition_id": "def-wa",
        "action_type": "whatsapp",
        "action_config": {"to": "+15551234567", "message": "Hi {company}"},
        "created": True,
    }
    core = FakeCore([run])
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "wamid.X"}]})
    plugin = OrchestratorPlugin(
        api=core.client(),
        ses_client=FakeSes(),
        http_client=http,
        whatsapp=WhatsAppSettings(access_token="tok", phone_number_id="pn"),
    )

    await plugin.process_event(_event())

    assert http.calls[0]["url"].endswith("/pn/messages")
    assert http.calls[0]["json"]["text"] == {"body": "Hi Acme"}
    assert core.result_posts()[0]["response"] == {"message_id": "wamid.X", "attempts": 1}


async def test_process_event_skips_already_claimed_run():
    core = FakeCore([_email_run(created=False)])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    assert ses.calls == []
    assert core.result_posts() == []


async def test_unknown_action_type_records_failure():
    core = FakeCore([_email_run(created=True, action_type="carrier-pigeon")])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    assert ses.calls == []
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "Unknown action_type" in result["error"]


async def test_action_failure_records_failure():
    # action_config missing 'to' -> ActionError inside send_email.
    core = FakeCore([_email_run(created=True, action_config={"from": "no-reply@example.com"})])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    assert ses.calls == []
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "missing required key" in result["error"]


async def test_idempotency_key_falls_back_to_content_hash():
    core = FakeCore([])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event(payload={"company": "NoId"}))

    key = core.event_posts()[0]["idempotency_key"]
    assert key.startswith("demo.requested:")


async def test_forwards_any_event_via_catch_all_subscription():
    # The engine is a generic forwarder (subscribe_all): an arbitrary event —
    # not just demo.requested — is dispatched to Core, which decides what runs.
    core = FakeCore([])
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    event = BiffoEvent(
        source="biffo.core",
        detail_type="brand.approved",
        payload={"id": "b1"},
    )
    await plugin.events.dispatch(event)

    posted = core.event_posts()
    assert len(posted) == 1
    assert posted[0]["source"] == "biffo.core"
    assert posted[0]["detail_type"] == "brand.approved"
    assert posted[0]["idempotency_key"] == "b1"


async def test_process_event_dispatches_the_agent_action_to_core():
    """An `agent` workflow creates a run in Core and records it — the async
    handler is awaited by the dispatcher, and no agent is executed here."""
    run = {
        "run_id": "run-agent",
        "definition_id": "def-agent",
        "action_type": "agent",
        "action_config": {
            "agent_name": "demo-enricher",
            "instructions": "Enrich {company}.",
            "model": "anthropic/claude-opus-4-8",
        },
        "created": True,
    }
    core = FakeCore([run])
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.process_event(_event())

    posted = core.agent_run_posts()
    assert len(posted) == 1
    assert posted[0]["agent_name"] == "demo-enricher"
    assert posted[0]["input_payload"]["company"] == "Acme"
    assert posted[0]["depth"] == 0

    results = core.result_posts()
    assert results[0]["status"] == "succeeded"
    assert results[0]["response"] == {
        "run_id": "agent-run-1",
        "status": "requested",
        "depth": 0,
        "attempts": 1,
    }


async def test_agent_run_refused_by_core_is_recorded_as_a_failed_run():
    run = {
        "run_id": "run-agent",
        "definition_id": "def-agent",
        "action_type": "agent",
        "action_config": {"agent_name": "looper", "instructions": "go"},
        "created": True,
    }
    core = FakeCore([run], agent_run_status=409, agent_run_detail="exceeds the maximum chain depth")
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.process_event(_event())

    results = core.result_posts()
    assert results[0]["status"] == "failed"
    assert "Core refused the agent run" in results[0]["error"]


# ── Retrying transient failures ──────────────────────────────────────────────
#
# The run is claimed in Core *before* the action runs, so a redelivered event
# comes back created=False and is skipped: EventBridge retry and the DLQ only
# ever covered the Core call. In-process retry is therefore the only thing
# between a transient 503 and a permanently failed run.


async def test_retries_a_throttled_ses_send_then_succeeds(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_email_run(created=True)])
    ses = FlakySes(failures=2)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    assert ses.attempts == 3
    result = core.result_posts()[0]
    assert result["status"] == "succeeded"
    # The attempt count is recorded, so a flaky channel is visible in history.
    assert result["response"]["attempts"] == 3


async def test_gives_up_after_the_attempt_limit(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_email_run(created=True)])
    ses = FlakySes(failures=99)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    assert ses.attempts == 3
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "after 3 attempts" in result["error"]
    # Exactly one outcome is recorded, however many attempts it took.
    assert len(core.result_posts()) == 1


async def test_does_not_retry_a_permanent_ses_rejection(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_email_run(created=True)])
    ses = FlakySes(failures=99, code="MessageRejected")
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    # A rejected recipient is rejected every time — one attempt, then recorded.
    assert ses.attempts == 1
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "MessageRejected" in result["error"]


async def test_does_not_retry_a_missing_config_key(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_email_run(created=True, action_config={"from": "no-reply@example.com"})])
    ses = FlakySes(failures=0)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.process_event(_event())

    # A definition missing `to` is missing it on every attempt — never sent.
    assert ses.attempts == 0
    assert core.result_posts()[0]["status"] == "failed"


async def test_retries_a_503_from_a_webhook(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_chat_run()])
    http = FlakyHttp(failures=1, status_code=503)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.process_event(_event())

    assert len(http.calls) == 2
    assert core.result_posts()[0]["status"] == "succeeded"


async def test_retries_a_429_from_a_webhook(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_chat_run()])
    http = FlakyHttp(failures=1, status_code=429)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.process_event(_event())

    assert len(http.calls) == 2
    assert core.result_posts()[0]["status"] == "succeeded"


async def test_retries_a_connection_failure(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_chat_run()])
    http = FlakyHttp(failures=1, mode="raise")
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.process_event(_event())

    assert len(http.calls) == 2
    assert core.result_posts()[0]["status"] == "succeeded"


async def test_does_not_retry_a_4xx_from_a_webhook(monkeypatch):
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_chat_run()])
    # 403: the webhook URL is wrong or revoked — retrying cannot fix it.
    http = FlakyHttp(failures=99, status_code=403)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.process_event(_event())

    assert len(http.calls) == 1
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "403" in result["error"]


async def test_does_not_retry_the_agent_depth_ceiling(monkeypatch):
    """A 409 from Core is the ADR-0014 §8 loop guard refusing a runaway chain.

    Retrying it is precisely the runaway the ceiling exists to stop, so the
    action must fail on the first attempt.
    """
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore(
        [_agent_run()], agent_run_status=409, agent_run_detail="exceeds the maximum chain depth"
    )
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.process_event(_event())

    assert len(core.agent_run_posts()) == 1
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "Core refused the agent run" in result["error"]
    assert "attempts" not in result["error"]


async def test_retries_a_5xx_from_core_on_the_agent_action(monkeypatch):
    """Core being briefly unwell is the one agent-action failure worth retrying."""
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([_agent_run()], agent_run_status=503, agent_run_detail="unavailable")
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.process_event(_event())

    assert len(core.agent_run_posts()) == 3
    result = core.result_posts()[0]
    assert result["status"] == "failed"
    assert "after 3 attempts" in result["error"]


# ── Deliver an agent's result on completion (ADR-0020, #527) ─────────────────
#
# The engine reacts to `agent.run.completed` for a *succeeded* run whose fetched
# definition_snapshot carries a `delivery` sub-config: it renders {output} into the
# destination and invokes the matching executor. The completion event is a
# reference only (§5), so the run — output + delivery snapshot — is fetched over
# the internal API. A failed run, or one with no delivery, delivers nothing.


def _completed_event(status: str = "completed", run_id: str = "agent-run-9") -> BiffoEvent:
    return BiffoEvent(
        source="biffo.core",
        detail_type="agent.run.completed",
        payload={"run_id": run_id, "agent": "demo-enricher", "status": status, "depth": 0},
    )


def _run_record(
    *, status: str = "completed", delivery: dict | None = None, output: str = "the verdict"
) -> dict:
    snapshot: dict = {"model": "m", "instructions": "go"}
    if delivery is not None:
        snapshot["delivery"] = delivery
    return {
        "id": "agent-run-9",
        "agent_name": "demo-enricher",
        "status": status,
        "result": {"output": output},
        "definition_snapshot": snapshot,
    }


_SLACK_DELIVERY = {
    "type": "slack",
    "config": {
        "webhook_url": "https://hooks.slack.com/services/T/B/x",
        "message": "Result: {output}",
    },
}


async def test_succeeded_run_with_delivery_invokes_the_executor():
    core = FakeCore([], agent_run_record=_run_record(delivery=_SLACK_DELIVERY))
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.events.dispatch(_completed_event())

    # The run was fetched (the completion event carries only a reference)…
    assert core.agent_run_gets() == ["agent-run-9"]
    # …and the Slack webhook was posted with {output} rendered from the run result.
    assert len(http.calls) == 1
    assert http.calls[0]["url"] == "https://hooks.slack.com/services/T/B/x"
    assert http.calls[0]["json"] == {"text": "Result: the verdict"}


async def test_delivery_defaults_body_to_raw_output_when_no_template():
    delivery = {"type": "slack", "config": {"webhook_url": "https://hooks.slack.com/x"}}
    core = FakeCore([], agent_run_record=_run_record(delivery=delivery, output="just this"))
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.deliver_on_completion(_completed_event())

    assert http.calls[0]["json"] == {"text": "just this"}


async def test_no_delivery_config_delivers_nothing():
    core = FakeCore([], agent_run_record=_run_record(delivery=None))
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.deliver_on_completion(_completed_event())

    # The run is still fetched, but nothing is dispatched.
    assert core.agent_run_gets() == ["agent-run-9"]
    assert http.calls == []


async def test_failed_run_delivers_nothing():
    """MVP delivers only on a succeeded run — the failure-notify seam is deferred."""
    core = FakeCore([], agent_run_record=_run_record(status="failed", delivery=_SLACK_DELIVERY))
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.deliver_on_completion(_completed_event(status="failed"))

    # A failed run is not even fetched — the status gate short-circuits first.
    assert core.agent_run_gets() == []
    assert http.calls == []


async def test_delivery_email_uses_ses():
    delivery = {
        "type": "email",
        "config": {
            "from": "no-reply@example.com",
            "to": "sales@example.com",
            "subject": "Agent result",
            "body": "Outcome: {output}",
        },
    }
    core = FakeCore([], agent_run_record=_run_record(delivery=delivery, output="shipped"))
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses, http_client=FakeHttp())

    await plugin.deliver_on_completion(_completed_event())

    assert len(ses.calls) == 1
    assert ses.calls[0]["Content"]["Simple"]["Body"]["Text"]["Data"] == "Outcome: shipped"


async def test_delivery_permanent_failure_does_not_raise(monkeypatch):
    """A bad webhook is logged, not retried, and never crashes the invocation —
    there is no workflow run to record the outcome against."""
    monkeypatch.setattr(plugin_module.asyncio, "sleep", _no_sleep)
    core = FakeCore([], agent_run_record=_run_record(delivery=_SLACK_DELIVERY))
    http = FakeHttp(status_code=403, text="revoked")
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.deliver_on_completion(_completed_event())

    # 403 is permanent — one attempt, no retry, no exception out.
    assert len(http.calls) == 1


async def test_completed_event_reaches_delivery_through_dispatch():
    """The `agent.run.completed` subscription is wired: dispatching the event runs
    the delivery handler (alongside the wildcard forwarder, which posts to Core)."""
    core = FakeCore([], agent_run_record=_run_record(delivery=_SLACK_DELIVERY))
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.events.dispatch(_completed_event())

    # Delivery fired (the specific handler) …
    assert len(http.calls) == 1
    # … and the wildcard forwarder still posted the event to Core for workflow
    # matching (agent chaining), unchanged.
    assert core.event_posts()[0]["detail_type"] == "agent.run.completed"


# ── Scheduled workflow actions (docs/implementation/0002-scheduled-workflow-actions) ──


async def test_process_event_schedules_a_delayed_run_instead_of_executing(monkeypatch):
    monkeypatch.setenv("BIFFO_SCHEDULE_GROUP_NAME", "wf-group")
    monkeypatch.setenv(
        "BIFFO_FUNCTION_ARN", "arn:aws:lambda:eu-west-1:123456789012:function:orchestrator"
    )
    monkeypatch.setenv(
        "BIFFO_SCHEDULER_ROLE_ARN", "arn:aws:iam::123456789012:role/scheduler-invoke"
    )
    core = FakeCore([_email_run(created=True, scheduled_for="2026-08-09T12:00:00+00:00")])
    ses = FakeSes()
    scheduler = FakeScheduler()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses, scheduler_client=scheduler)

    await plugin.process_event(_event())

    # Not executed now — only scheduled.
    assert len(ses.calls) == 0
    assert len(scheduler.calls) == 1
    call = scheduler.calls[0]
    assert call["Name"] == "wf-run-run-1"
    assert call["GroupName"] == "wf-group"
    assert call["ScheduleExpression"] == "at(2026-08-09T12:00:00)"
    assert call["FlexibleTimeWindow"] == {"Mode": "OFF"}
    assert call["Target"]["Arn"] == "arn:aws:lambda:eu-west-1:123456789012:function:orchestrator"
    assert call["Target"]["RoleArn"] == "arn:aws:iam::123456789012:role/scheduler-invoke"
    assert json.loads(call["Target"]["Input"]) == {"biffo_scheduled_run_id": "run-1"}
    assert call["ActionAfterCompletion"] == "DELETE"


async def test_process_event_still_executes_immediately_when_not_scheduled():
    """No regression: a run with no scheduled_for still dispatches now."""
    core = FakeCore([_email_run(created=True)])
    ses = FakeSes()
    scheduler = FakeScheduler()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses, scheduler_client=scheduler)

    await plugin.process_event(_event())

    assert len(ses.calls) == 1
    assert len(scheduler.calls) == 0


async def test_fire_scheduled_run_executes_the_claimed_action():
    trigger_event = {"demo_request_id": "d1", "company": "Acme", "email": "lead@acme.com"}
    core = FakeCore(
        [],
        fire_response={
            "claimed": True,
            "run_id": "run-1",
            "action_type": "email",
            "action_config": {
                "from": "no-reply@example.com",
                "to": "sales@example.com",
                "subject": "Demo from {company}",
            },
            "trigger_event": trigger_event,
        },
    )
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.fire_scheduled_run("run-1")

    assert len(ses.calls) == 1
    assert ses.calls[0]["Content"]["Simple"]["Subject"]["Data"] == "Demo from Acme"
    assert core.fire_posts() == ["run-1"]
    results = core.result_posts()
    assert len(results) == 1
    assert results[0]["status"] == "succeeded"


async def test_fire_scheduled_run_not_claimed_does_nothing():
    """The run already fired (duplicate Scheduler delivery), or its
    definition was disabled/deleted — either way, nothing to execute."""
    core = FakeCore([], fire_response=None)
    ses = FakeSes()
    plugin = OrchestratorPlugin(api=core.client(), ses_client=ses)

    await plugin.fire_scheduled_run("run-1")

    assert len(ses.calls) == 0
    assert core.result_posts() == []


# ── Write-back on completion (ADR-0027 M6) ───────────────────────────────────
#
# The plugin's whole part is "say which run finished". It carries no knowledge of
# the table, the columns, the values or the principal — Core resolves all of that
# from stored state — so these assert the trigger and its independence from
# message delivery, not any write behaviour.

_WRITEBACK = {"table": "leads", "operation": "create", "columns": {"email": "{output.email}"}}


def _writeback_run(*, status: str = "completed", delivery: dict | None = None) -> dict:
    snapshot: dict = {"model": "m", "instructions": "go", "writeback": _WRITEBACK}
    if delivery is not None:
        snapshot["delivery"] = delivery
    return {
        "id": "agent-run-9",
        "agent_name": "demo-enricher",
        "status": status,
        "result": {"email": "a@b.com"},
        "definition_snapshot": snapshot,
    }


async def test_a_completed_run_with_a_writeback_asks_core_to_record_it():
    core = FakeCore([], agent_run_record=_writeback_run())
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.events.dispatch(_completed_event())

    posted = core.writeback_posts()
    assert posted, "a run declaring a write-back must be sent to Core"
    # Only the run id — never a table, a column, a value or a principal.
    assert posted[0] == {"agent_run_id": "agent-run-9"}


async def test_a_run_with_no_writeback_asks_for_nothing():
    core = FakeCore([], agent_run_record=_run_record())
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.events.dispatch(_completed_event())
    assert core.writeback_posts() == []


async def test_a_failed_run_records_nothing():
    core = FakeCore([], agent_run_record=_writeback_run(status="failed"))
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=FakeHttp())

    await plugin.events.dispatch(_completed_event(status="failed"))
    assert core.writeback_posts() == []


async def test_writing_back_and_delivering_a_message_are_independent():
    core = FakeCore([], agent_run_record=_writeback_run(delivery=_SLACK_DELIVERY))
    http = FakeHttp(status_code=200)
    plugin = OrchestratorPlugin(api=core.client(), ses_client=FakeSes(), http_client=http)

    await plugin.events.dispatch(_completed_event())

    # A workflow may do both, and one must not suppress the other.
    assert core.writeback_posts()
    assert len(http.calls) == 1
