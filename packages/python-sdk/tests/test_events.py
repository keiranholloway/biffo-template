"""Tests for BiffoEvent, EventSubscriber, and create_event_handler."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from biffo_plugin_sdk import BiffoEvent, EventSubscriber, create_event_handler


def make_raw_event(
    *,
    source: str = "biffo.core",
    detail_type: str = "user.created",
    schema_version: str = "1.0",
    tenant_id: str = "default",
    payload: dict | None = None,
    detail_as_string: bool = False,
) -> dict:
    """Build a raw Lambda/EventBridge event dict, matching the shape AWS
    delivers when a Core API event (published via ``BiffoEvent.to_eventbridge_entry``
    in services/api/src/api/events/base.py) triggers a Lambda target.
    """
    detail = {
        "schema_version": schema_version,
        "tenant_id": tenant_id,
        "payload": payload if payload is not None else {"id": "abc123"},
    }
    return {
        "version": "0",
        "id": "11111111-2222-3333-4444-aaaaaaaaaaaa",
        "detail-type": detail_type,
        "source": source,
        "account": "123456789012",
        "time": "2026-06-30T12:00:00Z",
        "region": "eu-west-2",
        "resources": [],
        "detail": json.dumps(detail) if detail_as_string else detail,
    }


# --- BiffoEvent model ---


class TestBiffoEventModel:
    def test_construct_with_all_fields(self) -> None:
        event = BiffoEvent(
            source="biffo.core",
            detail_type="user.created",
            schema_version="1.0",
            tenant_id="default",
            payload={"id": "abc123"},
        )
        assert event.source == "biffo.core"
        assert event.detail_type == "user.created"
        assert event.schema_version == "1.0"
        assert event.tenant_id == "default"
        assert event.payload == {"id": "abc123"}

    def test_defaults_mirror_api_side_model(self) -> None:
        """Mirrors services/api/src/api/events/base.py's BiffoEvent defaults:
        source='biffo.core', schema_version='1.0', tenant_id='default'."""
        event = BiffoEvent(detail_type="user.created", payload={})
        assert event.source == "biffo.core"
        assert event.schema_version == "1.0"
        assert event.tenant_id == "default"

    def test_detail_type_is_required(self) -> None:
        with pytest.raises(ValidationError):
            BiffoEvent(payload={})  # type: ignore[call-arg]  # missing detail_type

    def test_payload_is_required(self) -> None:
        with pytest.raises(ValidationError):
            BiffoEvent(detail_type="user.created")  # type: ignore[call-arg]  # missing payload


# --- EventSubscriber ---


class TestEventSubscriberRegister:
    def test_register_stores_handler(self) -> None:
        subscriber = EventSubscriber()

        def handler(event: BiffoEvent) -> None:
            pass

        subscriber.register("user.created", handler)

        assert subscriber.get_handlers("user.created") == [handler]

    def test_register_multiple_handlers_for_same_detail_type(self) -> None:
        subscriber = EventSubscriber()

        def handler_one(event: BiffoEvent) -> None:
            pass

        def handler_two(event: BiffoEvent) -> None:
            pass

        subscriber.register("user.created", handler_one)
        subscriber.register("user.created", handler_two)

        assert subscriber.get_handlers("user.created") == [handler_one, handler_two]

    def test_register_accepts_async_handler(self) -> None:
        subscriber = EventSubscriber()

        async def async_handler(event: BiffoEvent) -> None:
            pass

        subscriber.register("user.created", async_handler)

        assert subscriber.get_handlers("user.created") == [async_handler]


class TestEventSubscriberGetHandlers:
    def test_returns_empty_list_for_unregistered_detail_type(self) -> None:
        subscriber = EventSubscriber()

        assert subscriber.get_handlers("nonexistent.event") == []

    def test_returns_a_copy_not_the_internal_list(self) -> None:
        subscriber = EventSubscriber()

        def handler(event: BiffoEvent) -> None:
            pass

        subscriber.register("user.created", handler)
        handlers = subscriber.get_handlers("user.created")
        handlers.append(handler)

        assert subscriber.get_handlers("user.created") == [handler]


class TestEventSubscriberHasSubscription:
    def test_true_when_handler_registered(self) -> None:
        subscriber = EventSubscriber()
        subscriber.register("user.created", lambda event: None)

        assert subscriber.has_subscription("user.created") is True

    def test_false_when_no_handler_registered(self) -> None:
        subscriber = EventSubscriber()

        assert subscriber.has_subscription("user.created") is False


class TestEventSubscriberDispatch:
    """dispatch() is a minimal helper proving both handler styles run;
    full dispatch semantics (ordering, error handling) are a later chunk."""

    async def test_dispatch_invokes_sync_handler(self) -> None:
        subscriber = EventSubscriber()
        received: list[BiffoEvent] = []

        def handler(event: BiffoEvent) -> None:
            received.append(event)

        subscriber.register("user.created", handler)
        event = BiffoEvent(detail_type="user.created", payload={"id": "1"})

        await subscriber.dispatch(event)

        assert received == [event]

    async def test_dispatch_invokes_async_handler(self) -> None:
        subscriber = EventSubscriber()
        received: list[BiffoEvent] = []

        async def handler(event: BiffoEvent) -> None:
            received.append(event)

        subscriber.register("user.created", handler)
        event = BiffoEvent(detail_type="user.created", payload={"id": "1"})

        await subscriber.dispatch(event)

        assert received == [event]

    async def test_dispatch_invokes_mixed_sync_and_async_handlers(self) -> None:
        subscriber = EventSubscriber()
        received: list[str] = []

        def sync_handler(event: BiffoEvent) -> None:
            received.append("sync")

        async def async_handler(event: BiffoEvent) -> None:
            received.append("async")

        subscriber.register("user.created", sync_handler)
        subscriber.register("user.created", async_handler)
        event = BiffoEvent(detail_type="user.created", payload={})

        await subscriber.dispatch(event)

        assert received == ["sync", "async"]

    async def test_dispatch_noop_when_no_handlers(self) -> None:
        subscriber = EventSubscriber()
        event = BiffoEvent(detail_type="user.created", payload={})

        await subscriber.dispatch(event)  # must not raise


# --- create_event_handler ---


class TestCreateEventHandler:
    def test_converts_raw_event_to_biffo_event(self) -> None:
        raw_event = make_raw_event(
            detail_type="user.created",
            tenant_id="default",
            payload={"id": "abc123", "email": "a@example.com"},
        )

        event = create_event_handler(raw_event)

        assert isinstance(event, BiffoEvent)
        assert event.source == "biffo.core"
        assert event.detail_type == "user.created"
        assert event.schema_version == "1.0"
        assert event.tenant_id == "default"
        assert event.payload == {"id": "abc123", "email": "a@example.com"}

    def test_handles_detail_delivered_as_json_string(self) -> None:
        """Defensive: EventBridge normally delivers 'detail' as an already-parsed
        object, but hand-built fixtures sometimes leave it as the raw JSON
        string that to_eventbridge_entry() produces for the PutEvents call."""
        raw_event = make_raw_event(payload={"foo": "bar"}, detail_as_string=True)

        event = create_event_handler(raw_event)

        assert event.payload == {"foo": "bar"}

    def test_missing_schema_version_defaults(self) -> None:
        raw_event = make_raw_event()
        del raw_event["detail"]["schema_version"]

        event = create_event_handler(raw_event)

        assert event.schema_version == "1.0"

    def test_missing_tenant_id_defaults(self) -> None:
        raw_event = make_raw_event()
        del raw_event["detail"]["tenant_id"]

        event = create_event_handler(raw_event)

        assert event.tenant_id == "default"

    def test_missing_payload_defaults_to_empty_dict(self) -> None:
        raw_event = make_raw_event()
        del raw_event["detail"]["payload"]

        event = create_event_handler(raw_event)

        assert event.payload == {}

    def test_invalid_json_string_detail_raises_value_error(self) -> None:
        raw_event = make_raw_event()
        raw_event["detail"] = "{not valid json"

        with pytest.raises(ValueError):
            create_event_handler(raw_event)

    def test_non_object_detail_raises_value_error(self) -> None:
        raw_event = make_raw_event()
        raw_event["detail"] = json.dumps(["not", "an", "object"])

        with pytest.raises(ValueError):
            create_event_handler(raw_event)

    def test_missing_detail_type_raises(self) -> None:
        raw_event = make_raw_event()
        del raw_event["detail-type"]

        with pytest.raises(Exception):
            create_event_handler(raw_event)
