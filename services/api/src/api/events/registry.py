"""Canonical registry of the platform's EventBridge events (ADR-0010).

A "trigger" the orchestration builder can offer is an EventBridge event, identified
by ``(source, detail_type)``. This module is the **one** place an event is declared:
``register_event(EventType(...))`` returns a constant to publish with, and
``registered_events()`` feeds the workflow-builder catalog and its create/update
validation. Declaring an event here is the single act that makes it both
*publishable* (emit ``EVENT.build(payload)``) and *selectable* as a trigger — there
is no second list to keep in sync.

Instance- and plugin-owned events register their own ``EventType``s from the module
that emits them; because registration happens at import time (like the model
discovery in ``main.py``), a downstream repo adds events without editing this file.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .base import BiffoEvent


@dataclass(frozen=True)
class EventType:
    """A platform event a workflow can trigger on.

    ``source``/``detail_type`` are the EventBridge identity; ``label``/
    ``description`` are the human copy the builder UI shows.
    """

    source: str
    detail_type: str
    label: str
    description: str = ""

    def build(
        self,
        payload: dict[str, Any],
        *,
        tenant_id: str = "default",
        schema_version: str = "1.0",
    ) -> BiffoEvent:
        """Construct a ``BiffoEvent`` for this type — publish via ``EventPublisher``.

        Emitting through the registry constant (``ORDER_PLACED.build({...})``) keeps
        the ``detail_type`` string in exactly one place: here.
        """
        return BiffoEvent(
            source=self.source,
            detail_type=self.detail_type,
            schema_version=schema_version,
            tenant_id=tenant_id,
            payload=payload,
        )


# Declaration-ordered, de-duplicated on (source, detail_type). Order is preserved
# so the catalog the UI renders is stable.
_REGISTRY: dict[tuple[str, str], EventType] = {}


def register_event(event: EventType) -> EventType:
    """Declare an event and return it, so callers bind a module-level constant::

        DEMO_REQUESTED = register_event(
            EventType("biffo.core", "demo.requested", "Demo requested", "...")
        )

    Idempotent on ``(source, detail_type)``: re-registering the same identity
    replaces the entry (last declaration wins, keeping its original position), so
    an instance can refine a Core event's copy without a duplicate.
    """
    _REGISTRY[(event.source, event.detail_type)] = event
    return event


def registered_events() -> list[EventType]:
    """Every declared event, in declaration order."""
    return list(_REGISTRY.values())


def find_event(source: str, detail_type: str) -> EventType | None:
    """The declared event with this identity, or ``None`` if unknown."""
    return _REGISTRY.get((source, detail_type))


# ── Canonical Core events ────────────────────────────────────────────────────
# The reference events the Biffo template ships. An instance adds its own domain
# events by calling ``register_event(...)`` from the router that emits them.

DEMO_REQUESTED = register_event(
    EventType(
        source="biffo.core",
        detail_type="demo.requested",
        label="Demo requested",
        description='Someone submits the "Book a demo" form.',
    )
)

LEAD_CAPTURED = register_event(
    EventType(
        source="biffo.core",
        detail_type="lead.captured",
        label="Lead captured",
        description="A lead comes in from the website or marketplace.",
    )
)
