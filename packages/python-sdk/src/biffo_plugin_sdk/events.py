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

#: Wildcard ``detail_type`` — a handler registered under this key runs for *every*
#: event, regardless of its detail_type. Lets a plugin be a generic forwarder
#: (e.g. the orchestration engine) that reacts to any event without enumerating
#: them, so new triggers need no plugin code change (ADR-0010, epic #210).
WILDCARD = "*"


class EventSubscriber:
    """Registry mapping EventBridge ``detail-type`` values to handlers.

    Handlers may be sync or async — ``register``/``get_handlers``/
    ``has_subscription`` accept and return either without distinction. A handler
    registered under :data:`WILDCARD` runs for every event, in addition to any
    detail-type-specific handlers.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)

    def register(self, detail_type: str, handler: EventHandler) -> None:
        """Register *handler* for events with *detail_type* (or all, if WILDCARD)."""
        self._handlers[detail_type].append(handler)

    def register_all(self, handler: EventHandler) -> None:
        """Register *handler* to run for every event (a catch-all forwarder)."""
        self._handlers[WILDCARD].append(handler)

    def get_handlers(self, detail_type: str) -> list[EventHandler]:
        """Return the handlers registered for *detail_type* (empty if none).

        Does not include wildcard handlers — use :meth:`dispatch` (or pass
        :data:`WILDCARD`) for those.
        """
        return list(self._handlers.get(detail_type, []))

    def has_subscription(self, detail_type: str) -> bool:
        """Whether any handler — specific or wildcard — will run for *detail_type*."""
        return bool(self._handlers.get(detail_type) or self._handlers.get(WILDCARD))

    async def dispatch(self, event: BiffoEvent) -> None:
        """Invoke every handler for *event* — its detail_type's, then wildcards.

        Sync handlers run inline; async handlers (or anything returning an
        awaitable) are awaited. Detail-type-specific handlers run before wildcard
        handlers; each is registered once, so a handler bound to both keys runs
        for both.
        """
        handlers = self.get_handlers(event.detail_type)
        if event.detail_type != WILDCARD:
            handlers += self.get_handlers(WILDCARD)
        for handler in handlers:
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
