"""Transaction-safe, compliance-gated event emission (ADR-0002).

Handlers don't publish to EventBridge directly. They call
``emit_event(db, EVENT, payload)``, which **buffers** the event on the request's
session. ``get_db`` publishes the buffer **after** the transaction commits — never
before, so a mutation that rolls back never produces a "phantom" event — and only
for events that are **declared in code** (a registered ``EventType``; Phase B also
admits a generic-CRUD ``<table>.<op>``). An undeclared event is refused and logged,
so nothing non-compliant reaches the bus (ADR-0002, epic #222).
"""

from __future__ import annotations

from typing import Any

from aws_lambda_powertools import Logger
from sqlalchemy.ext.asyncio import AsyncSession

from .base import BiffoEvent, PublishOutcome
from .registry import EventType, find_event

logger = Logger()

# Where the per-request buffer lives: SQLAlchemy's session-scoped ``.info`` dict,
# so it travels with the session and is discarded (unpublished) on rollback.
_BUFFER_KEY = "biffo_pending_events"


def emit_event(
    db: AsyncSession,
    event: EventType,
    payload: dict[str, Any],
    *,
    tenant_id: str = "default",
) -> None:
    """Buffer a declared state-change event for publication after this request
    commits. Does **not** publish here — never on an uncommitted transaction."""
    _warn_on_payload_drift(event, payload)
    built = event.build(payload, tenant_id=tenant_id)
    db.info.setdefault(_BUFFER_KEY, []).append(built)


def _warn_on_payload_drift(event: EventType, payload: dict[str, Any]) -> None:
    """If a declared field the builder offers is missing from the emitted payload,
    a workflow condition on it can never match — so log it. Advisory only: never
    raises (a real request must not fail over builder metadata), and extra payload
    keys are fine. Absent under load in practice; it exists to catch a payload_model
    that has drifted from its emit site before it ships a silently-dead condition."""
    model = event.payload_model
    if model is None:
        return
    missing = [name for name in model.model_fields if name not in payload]
    if missing:
        logger.warning(
            "Event payload is missing declared payload_model field(s); "
            "a builder condition on them would never match.",
            extra={"detail_type": event.detail_type, "missing": missing},
        )


def pending_events(db: AsyncSession) -> list[BiffoEvent]:
    """The events buffered so far on this session (test/introspection helper)."""
    return list(db.info.get(_BUFFER_KEY, []))


_CRUD_OP = {"created": "create", "updated": "update", "deleted": "delete"}


def is_declared(source: str, detail_type: str) -> bool:
    """Whether an event is allowed on the bus — i.e. defined in code.

    Two ways an event is declared: a registered ``EventType`` (a business event),
    or a generic-CRUD ``<table>.<op>`` where that table's ``__crud_permissions__``
    allows the operation (declared implicitly by the CRUD surface, ADR-0004).
    """
    if find_event(source, detail_type) is not None:
        return True
    if source == "biffo.core":
        table, sep, op = detail_type.rpartition(".")
        if sep and op in _CRUD_OP:
            from ..permissions import get_permissions_registry

            block = get_permissions_registry().get(table)
            if block is not None:
                return bool(getattr(block, _CRUD_OP[op]).allowed)
    return False


async def publish_pending(db: AsyncSession) -> list[PublishOutcome]:
    """Publish the buffered events — called by ``get_db`` *after* a successful
    commit. Refuses any undeclared event (the compliance gate) and never raises
    into the request (``EventPublisher.publish`` is itself best-effort).

    Returns each accepted event's :class:`PublishOutcome`, in publish order
    (biffo-template#1017) — ``get_db`` currently discards it, same as before this
    change, but the outcome is no longer thrown away *inside* the publisher, so a
    future caller with somewhere to record it (an outbox, a per-run column) has
    something to call rather than needing to re-plumb the publish path first. An
    undeclared, refused event contributes no entry — it never reached
    ``EventPublisher.publish`` at all, which is a compliance rejection, not a
    delivery outcome.
    """
    events: list[BiffoEvent] = db.info.pop(_BUFFER_KEY, [])
    if not events:
        return []
    # Lazy import to avoid a database <- dependencies <- events import cycle.
    from ..dependencies import get_event_publisher

    publisher = get_event_publisher()
    outcomes: list[PublishOutcome] = []
    for event in events:
        if not is_declared(event.source, event.detail_type):
            logger.error(
                "Refusing to publish an undeclared event (not defined in code)",
                extra={"source": event.source, "detail_type": event.detail_type},
            )
            continue
        outcomes.append(publisher.publish(event))
    return outcomes
