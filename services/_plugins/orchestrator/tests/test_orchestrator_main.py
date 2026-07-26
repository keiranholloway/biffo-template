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
