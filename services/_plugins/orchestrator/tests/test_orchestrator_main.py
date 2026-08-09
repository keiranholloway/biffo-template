"""Tests for the Lambda entrypoint: EventBridge event -> BiffoEvent ->
OrchestratorPlugin.events.dispatch()."""

from __future__ import annotations

import json
from typing import Any

import orchestrator.main as main_module
from biffo_plugin_sdk import BiffoEvent


class _FakeContext:
    aws_request_id = "test-request-id"
    function_name = "orchestrator-plugin"
    memory_limit_in_mb = 128
    invoked_function_arn = "arn:aws:lambda:eu-west-1:123456789012:function:orchestrator-plugin"

    def get_remaining_time_in_millis(self) -> int:
        return 30_000


class _FakeEventSubscriber:
    def __init__(self) -> None:
        self.dispatched: list[BiffoEvent] = []

    async def dispatch(self, event: BiffoEvent) -> None:
        self.dispatched.append(event)


class _FakePlugin:
    def __init__(self) -> None:
        self.events = _FakeEventSubscriber()
        self.fired_run_ids: list[str] = []

    async def fire_scheduled_run(self, run_id: str) -> None:
        self.fired_run_ids.append(run_id)


def _eventbridge_event(detail_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": "0",
        "id": "abc-123",
        "detail-type": detail_type,
        "source": "biffo.core",
        "account": "123456789012",
        "time": "2026-07-06T00:00:00Z",
        "region": "eu-west-1",
        "resources": [],
        "detail": {
            "schema_version": "1.0",
            "tenant_id": "default",
            "payload": payload,
        },
    }


def test_handler_dispatches_demo_requested_event(monkeypatch) -> None:
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)
    monkeypatch.setattr(main_module, "_plugin", None)

    raw_event = _eventbridge_event("demo.requested", {"demo_request_id": "d1"})

    result = main_module.handler(raw_event, _FakeContext())

    assert result == {"statusCode": 200}
    assert len(fake_plugin.events.dispatched) == 1
    dispatched = fake_plugin.events.dispatched[0]
    assert dispatched.detail_type == "demo.requested"
    assert dispatched.payload == {"demo_request_id": "d1"}


def test_handler_tolerates_detail_as_json_string(monkeypatch) -> None:
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)

    raw_event = _eventbridge_event("demo.requested", {"demo_request_id": "d2"})
    raw_event["detail"] = json.dumps(raw_event["detail"])

    main_module.handler(raw_event, _FakeContext())

    assert fake_plugin.events.dispatched[0].payload == {"demo_request_id": "d2"}


def test_get_plugin_is_memoized(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "_plugin", None)
    created: list[object] = []

    class _Sentinel:
        pass

    def _factory() -> _Sentinel:
        instance = _Sentinel()
        created.append(instance)
        return instance

    monkeypatch.setattr(main_module, "OrchestratorPlugin", _factory)

    first = main_module._get_plugin()
    second = main_module._get_plugin()

    assert first is second
    assert len(created) == 1


# ── Scheduled workflow actions (docs/implementation/0002-scheduled-workflow-actions) ──


def test_handler_routes_a_scheduled_fire_payload_to_fire_scheduled_run(monkeypatch) -> None:
    """EventBridge Scheduler's raw Target.Input invocation — not an
    EventBridge-rule-shaped event — is detected before create_event_handler
    ever sees it and routed straight to fire_scheduled_run (ADR-0023)."""
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)

    result = main_module.handler({main_module.SCHEDULED_RUN_ID_KEY: "run-42"}, _FakeContext())

    assert result == {"statusCode": 200}
    assert fake_plugin.fired_run_ids == ["run-42"]
    # Never touched the bus-event dispatch path.
    assert fake_plugin.events.dispatched == []


def test_handler_still_dispatches_a_normal_event_unchanged(monkeypatch) -> None:
    """No regression: a real EventBridge-rule event (no sentinel key) still
    flows through create_event_handler/dispatch as before."""
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)

    raw_event = _eventbridge_event("demo.requested", {"demo_request_id": "d3"})
    main_module.handler(raw_event, _FakeContext())

    assert fake_plugin.fired_run_ids == []
    assert len(fake_plugin.events.dispatched) == 1


# ── Log-redaction hook for credential-shaped payload fields (biffo-template#950,
# the second half of #1182 — the first half added CognitoAdmin.create_user's
# temporary_password param). Asserts against the actual emitted log record
# (the powertools Logger's own `extra` attribute on the captured LogRecord),
# not against orchestrator.redaction.redact_event_payload() in isolation —
# the bug this guards against is the log CALL SITE forgetting to redact, which
# a helper-only test cannot catch. ──────────────────────────────────────────


def test_handler_logs_a_redacted_copy_of_a_credential_bearing_event(monkeypatch, caplog) -> None:
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)
    monkeypatch.setattr(main_module, "_plugin", None)

    raw_event = _eventbridge_event(
        "user.invited",
        {"email": "person@example.com", "temporary_password": "correct-horse-battery-staple"},
    )

    with caplog.at_level("INFO"):
        main_module.handler(raw_event, _FakeContext())

    received_logs = [r for r in caplog.records if r.message == "Received event"]
    assert len(received_logs) == 1
    logged_event = received_logs[0].event

    assert logged_event["detail"]["payload"]["temporary_password"] == "***"
    # Redaction must be surgical: everything else in the same payload is
    # still legible, so the log line keeps its debugging value.
    assert logged_event["detail"]["payload"]["email"] == "person@example.com"
    assert logged_event["detail-type"] == "user.invited"

    # The real, unredacted secret must never appear anywhere in the record
    # actually handed to the logger — not just absent from the one field we
    # already checked.
    assert "correct-horse-battery-staple" not in json.dumps(logged_event)


def test_handler_still_dispatches_the_real_unredacted_event(monkeypatch, caplog) -> None:
    """The log line is redacted; the event that reaches plugin.events.dispatch
    (and therefore any action handler, e.g. "Send email") is NOT — a plugin
    that legitimately needs the real credential must still get it."""
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)
    monkeypatch.setattr(main_module, "_plugin", None)

    raw_event = _eventbridge_event(
        "user.invited", {"temporary_password": "correct-horse-battery-staple"}
    )

    with caplog.at_level("INFO"):
        main_module.handler(raw_event, _FakeContext())

    assert len(fake_plugin.events.dispatched) == 1
    assert (
        fake_plugin.events.dispatched[0].payload["temporary_password"]
        == "correct-horse-battery-staple"
    )


def test_handler_does_not_redact_a_payload_with_no_credential_shaped_fields(
    monkeypatch, caplog
) -> None:
    """No false positives: an ordinary event's fields survive the log line
    unchanged."""
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)
    monkeypatch.setattr(main_module, "_plugin", None)

    raw_event = _eventbridge_event("demo.requested", {"demo_request_id": "d4"})

    with caplog.at_level("INFO"):
        main_module.handler(raw_event, _FakeContext())

    received_logs = [r for r in caplog.records if r.message == "Received event"]
    assert received_logs[0].event["detail"]["payload"] == {"demo_request_id": "d4"}
