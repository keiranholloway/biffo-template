"""Tests for the Lambda entrypoint: EventBridge event -> BiffoEvent ->
RbacPlugin.events.dispatch()."""

from __future__ import annotations

import json
from typing import Any

import rbac.main as main_module
from biffo_plugin_sdk import BiffoEvent


class _FakeContext:
    aws_request_id = "test-request-id"
    function_name = "rbac-plugin"
    memory_limit_in_mb = 128
    invoked_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:rbac-plugin"

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


def _eventbridge_event(detail_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": "0",
        "id": "abc-123",
        "detail-type": detail_type,
        "source": "biffo.core",
        "account": "123456789012",
        "time": "2026-07-02T00:00:00Z",
        "region": "us-east-1",
        "resources": [],
        "detail": {
            "schema_version": "1.0",
            "tenant_id": "default",
            "payload": payload,
        },
    }


def test_handler_dispatches_user_created_event(monkeypatch) -> None:
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)
    monkeypatch.setattr(main_module, "_plugin", None)

    raw_event = _eventbridge_event("UserCreated", {"cognito_sub": "user-123"})

    result = main_module.handler(raw_event, _FakeContext())

    assert result == {"statusCode": 200}
    assert len(fake_plugin.events.dispatched) == 1
    dispatched = fake_plugin.events.dispatched[0]
    assert dispatched.detail_type == "UserCreated"
    assert dispatched.tenant_id == "default"
    assert dispatched.payload == {"cognito_sub": "user-123"}


def test_handler_tolerates_detail_delivered_as_json_string(monkeypatch) -> None:
    """Real EventBridge always delivers `detail` as a parsed object, but
    create_event_handler (SDK, issue #16) also accepts a JSON string for
    hand-built fixtures -- this proves the Lambda entrypoint inherits that
    tolerance rather than assuming a dict."""
    fake_plugin = _FakePlugin()
    monkeypatch.setattr(main_module, "_get_plugin", lambda: fake_plugin)

    raw_event = _eventbridge_event("UserCreated", {"cognito_sub": "user-456"})
    raw_event["detail"] = json.dumps(raw_event["detail"])

    main_module.handler(raw_event, _FakeContext())

    assert fake_plugin.events.dispatched[0].payload == {"cognito_sub": "user-456"}


def test_get_plugin_is_memoized(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "_plugin", None)
    created: list[object] = []

    class _Sentinel:
        pass

    def _factory() -> _Sentinel:
        instance = _Sentinel()
        created.append(instance)
        return instance

    monkeypatch.setattr(main_module, "RbacPlugin", _factory)

    first = main_module._get_plugin()
    second = main_module._get_plugin()

    assert first is second
    assert len(created) == 1
