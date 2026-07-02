"""EventBridge event parsing and subscription handling for plugins.

``BiffoEvent`` mirrors the base model the Core API publishes to EventBridge
(``services/api/src/api/events/base.py``, ADR-0002) field for field —
``source``, ``detail_type``, ``schema_version``, ``tenant_id``, ``payload``.
As with ``plugin.py``'s manifest models, the SDK can't import the Core API's
model directly: plugins are installed in separate repositories, outside the
Core API's own deployment, so the duplication is intentional. If either side
changes, update the other.

Parsing the raw Lambda/EventBridge event dict uses
``aws_lambda_powertools.utilities.data_classes.EventBridgeEvent`` so plugin
authors don't have to hand-roll access to the ``source`` / ``detail-type`` /
``detail`` envelope fields AWS delivers to a Lambda function.

Note on the two-level construction in ``create_event_handler``: the Core
API's ``BiffoEvent.to_eventbridge_entry`` puts ``source``/``detail_type`` at
the top level of the ``PutEvents`` entry (``Source``/``DetailType``) and
JSON-encodes ``schema_version``/``tenant_id``/``payload`` into the nested
``Detail`` string, because that's what the ``put_events`` boto3 API expects.
EventBridge parses that JSON string back into an object before invoking the
Lambda target, so ``event["detail"]`` normally arrives as a dict already —
``create_event_handler`` also tolerates it arriving as a raw JSON string
(e.g. in hand-built test fixtures) by decoding it first.
"""

from __future__ import annotations

import inspect
import json
from collections import defaultdict
from typing import Any, Awaitable, Callable

from aws_lambda_powertools.utilities.data_classes import EventBridgeEvent
from pydantic import BaseModel, Field


class BiffoEvent(BaseModel):
    """
    Base model for events consumed from EventBridge (ADR-0002).

    Mirrors ``services/api/src/api/events/base.py``'s ``BiffoEvent``. Every
    event carries ``tenant_id`` and ``schema_version``; plugin handlers must
    handle schema version changes gracefully.
    """

    source: str = "biffo.core"
    detail_type: str
    schema_version: str = "1.0"
    tenant_id: str = Field(default="default")
    payload: dict[str, Any]


SyncEventHandler = Callable[[BiffoEvent], None]
AsyncEventHandler = Callable[[BiffoEvent], Awaitable[None]]
EventHandler = SyncEventHandler | AsyncEventHandler


class EventSubscriber:
    """Registry mapping EventBridge ``detail-type`` values to handlers.

    Handlers may be sync or async — ``register``/``get_handlers``/
    ``has_subscription`` accept and return either without distinction. Full
    dispatch (invoking handlers, awaiting async ones, error handling) is
    deferred to a later chunk; ``dispatch`` here is a minimal helper that
    just proves both handler styles run without raising.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)

    def register(self, detail_type: str, handler: EventHandler) -> None:
        """Register *handler* to be invoked for events with *detail_type*."""
        self._handlers[detail_type].append(handler)

    def get_handlers(self, detail_type: str) -> list[EventHandler]:
        """Return the handlers registered for *detail_type* (empty if none)."""
        return list(self._handlers.get(detail_type, []))

    def has_subscription(self, detail_type: str) -> bool:
        """Return whether any handler is registered for *detail_type*."""
        return bool(self._handlers.get(detail_type))

    async def dispatch(self, event: BiffoEvent) -> None:
        """Invoke every handler registered for *event*'s detail_type.

        Sync handlers run inline; async handlers (or anything returning an
        awaitable) are awaited.
        """
        for handler in self.get_handlers(event.detail_type):
            result = handler(event)
            if inspect.isawaitable(result):
                await result


def create_event_handler(raw_event: dict[str, Any]) -> BiffoEvent:
    """Convert a raw Lambda/EventBridge event dict into a ``BiffoEvent``.

    *raw_event* is the ``event`` dict Lambda passes to the handler when
    invoked by an EventBridge rule: top-level ``source``/``detail-type``
    envelope fields plus a nested ``detail`` object carrying
    ``schema_version``/``tenant_id``/``payload`` (see module docstring).

    Raises:
        ValueError: If *raw_event* is missing required fields or ``detail``
            is not a JSON object.
    """
    bridge_event = EventBridgeEvent(raw_event)

    detail = bridge_event.detail
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in event detail: {exc}") from exc

    if not isinstance(detail, dict):
        raise ValueError(
            f"Event detail must be a JSON object, got {type(detail).__name__}"
        )

    try:
        return BiffoEvent(
            source=bridge_event.source,
            detail_type=bridge_event.detail_type,
            schema_version=detail.get("schema_version", "1.0"),
            tenant_id=detail.get("tenant_id", "default"),
            payload=detail.get("payload", {}),
        )
    except KeyError as exc:
        raise ValueError(f"Malformed EventBridge event, missing key: {exc}") from exc
