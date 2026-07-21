"""Tests for OrchestratorPlugin.process_event — the engine flow end to end
(Core internal API + SES both faked)."""

from __future__ import annotations

from typing import Any

from biffo_plugin_sdk import BiffoEvent
from orchestrator import plugin as plugin_module
from orchestrator.actions import WhatsAppSettings
from orchestrator.plugin import OrchestratorPlugin
from orchestrator_fakes import (
    FakeCore,
    FakeHttp,
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
    assert ses.calls[0]["Message"]["Subject"]["Data"] == "Demo from Acme"
    # The outcome was recorded as succeeded with the SES message id.
    results = core.result_posts()
    assert len(results) == 1
    assert results[0]["status"] == "succeeded"
    assert results[0]["response"] == {"message_id": "ses-message-1", "attempts": 1}
    # The event was posted with the explicit idempotency key from the payload.
    assert core.event_posts()[0]["idempotency_key"] == "d1"


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
