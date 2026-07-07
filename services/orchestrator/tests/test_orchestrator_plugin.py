"""Tests for OrchestratorPlugin.process_event — the engine flow end to end
(Core internal API + SES both faked)."""

from __future__ import annotations

from typing import Any

from biffo_plugin_sdk import BiffoEvent

from orchestrator.plugin import OrchestratorPlugin
from orchestrator_fakes import FakeCore, FakeSes


def _event(payload: dict[str, Any] | None = None) -> BiffoEvent:
    return BiffoEvent(
        source="biffo.core",
        detail_type="demo.requested",
        payload=payload
        or {"demo_request_id": "d1", "company": "Acme", "email": "lead@acme.com"},
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
    assert results[0]["response"] == {"message_id": "ses-message-1"}
    # The event was posted with the explicit idempotency key from the payload.
    assert core.event_posts()[0]["idempotency_key"] == "d1"


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
    core = FakeCore(
        [_email_run(created=True, action_config={"from": "no-reply@example.com"})]
    )
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
