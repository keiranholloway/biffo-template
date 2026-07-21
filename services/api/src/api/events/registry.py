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

USER_CREATED = register_event(
    EventType(
        source="biffo.core",
        detail_type="user.created",
        label="User created",
        description="A user record is first created in Core, on their first authenticated request.",
    )
)

USER_SUSPENDED = register_event(
    EventType(
        source="biffo.core",
        detail_type="user.suspended",
        label="User suspended",
        description="An admin disables a user (Cognito disable + global sign-out).",
    )
)

USER_REACTIVATED = register_event(
    EventType(
        source="biffo.core",
        detail_type="user.reactivated",
        label="User reactivated",
        description="An admin re-enables a previously suspended user.",
    )
)

USER_DELETED = register_event(
    EventType(
        source="biffo.core",
        detail_type="user.deleted",
        label="User deleted",
        description="An admin deletes a user from Cognito (their DB row is "
        "deactivated, not removed).",
    )
)

# Workflow-definition builder CRUD (the orchestration config plane). Hand-written,
# not generic-CRUD, so the emits are declared here. Enable/disable is emitted as
# an "updated" — the payload carries the new ``enabled`` state.
WORKFLOW_DEFINITION_CREATED = register_event(
    EventType(
        source="biffo.core",
        detail_type="workflow_definition.created",
        label="Workflow created",
        description="An admin creates an orchestration workflow definition.",
    )
)

WORKFLOW_DEFINITION_UPDATED = register_event(
    EventType(
        source="biffo.core",
        detail_type="workflow_definition.updated",
        label="Workflow updated",
        description="An admin edits a workflow definition or toggles it enabled/disabled.",
    )
)

WORKFLOW_DEFINITION_DELETED = register_event(
    EventType(
        source="biffo.core",
        detail_type="workflow_definition.deleted",
        label="Workflow deleted",
        description="An admin deletes a workflow definition.",
    )
)

# Agentic workers (ADR-0014). One statically registered event per side of a run,
# with ``agent`` in the detail so subscribers discriminate via ``trigger_filter``
# — per-agent event types would need dynamic registration and break the
# one-place rule above. Both payloads carry a **reference**, never the result:
# ``{run_id, agent, status, causation_id, depth}``. The transcript and the
# enrichment output are LLM content derived from attacker-influenceable input,
# so they stay behind an authenticated fetch (ADR-0014 §5, security model).
AGENT_RUN_REQUESTED = register_event(
    EventType(
        source="biffo.core",
        detail_type="agent.run.requested",
        label="Agent run requested",
        description="An agent run is created and waiting for the runtime to execute it.",
    )
)

AGENT_RUN_COMPLETED = register_event(
    EventType(
        source="biffo.core",
        detail_type="agent.run.completed",
        label="Agent run completed",
        description="An agent run reaches a terminal state; the payload's "
        "``status`` distinguishes completed from failed.",
    )
)
