"""Orchestration domain models (Core-owned state for the orchestration engine).

The orchestration engine is an ADR-0003 plugin that subscribes to EventBridge
and fires actions (email, SMS, agentic workflows, …). ADR-0002 forbids any
component but the Core API touching the database, so the engine's durable state
lives here in Core and is reached over the internal service API (ADR-0009):

- ``WorkflowDefinition`` — a trigger (source + detail_type) mapped to an action.
  Authored/edited via the UI (deferred) or seeded; the engine reads the enabled
  ones matching an incoming event.
- ``WorkflowRun`` — one execution of a definition for one event. ``dedupe_key``
  is unique per tenant so a replayed event (EventBridge archive replay, at-least-
  once delivery) claims the same run instead of firing the action twice.
- ``ActionLog`` — the outcome of dispatching a run's action; the audit trail.

These deliberately do **not** declare ``__crud_permissions__``: they are not
exposed through the generic-CRUD layer (ADR-0004). The engine reaches them only
through the hand-written internal router (``routers/internal_orchestration.py``),
and the editing UI will get its own explicit surface later.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Boolean, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel

# Run lifecycle states. A run is created ``pending`` when claimed, moved to
# ``dispatched`` once the engine begins the action, then ``succeeded``/``failed``
# by the recorded result. ``skipped`` is reserved for definitions that matched
# but chose not to act (e.g. a future trigger_filter miss).
RUN_STATUSES = ("pending", "dispatched", "succeeded", "failed", "skipped")


class WorkflowDefinition(TenantScopedModel):
    """A trigger→action rule the engine evaluates against incoming events."""

    __tablename__ = "orchestration_workflow_definitions"
    __table_args__ = (
        # Resolve query: enabled definitions for a given (source, detail_type).
        Index(
            "ix_orch_def_trigger",
            "tenant_id",
            "trigger_source",
            "trigger_detail_type",
            "enabled",
        ),
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    trigger_source: Mapped[str] = mapped_column(String(128), nullable=False)
    trigger_detail_type: Mapped[str] = mapped_column(String(128), nullable=False)
    # Optional additional match criteria against the event payload. Reserved for
    # a later increment; the wedge matches on (source, detail_type) only.
    trigger_filter: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    action_type: Mapped[str] = mapped_column(String(64), nullable=False)
    action_config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class TriggerCatalog(TenantScopedModel):
    """An event type observed at dispatch — the self-building trigger catalog.

    Declared events come from the code registry (``events/registry.py``, ADR-0010);
    this table records events the engine has actually *seen* on the bus, so the
    builder can offer them as triggers too — including events the registry does
    not (yet) name (e.g. a new sibling/plugin event). Upserted per tenant on each
    dispatch: ``created_at`` is first-seen, ``updated_at`` is last-seen.
    """

    __tablename__ = "orchestration_trigger_catalog"
    __table_args__ = (
        UniqueConstraint("tenant_id", "source", "detail_type", name="uq_orch_trigger_catalog"),
    )

    source: Mapped[str] = mapped_column(String(128), nullable=False)
    detail_type: Mapped[str] = mapped_column(String(128), nullable=False)


class WorkflowRun(TenantScopedModel):
    """One execution of a definition for one triggering event (idempotent)."""

    __tablename__ = "orchestration_workflow_runs"
    __table_args__ = (
        # A replayed event must claim the same run, not create a second one.
        UniqueConstraint("tenant_id", "dedupe_key", name="uq_orch_run_dedupe"),
        Index("ix_orch_run_definition", "tenant_id", "definition_id"),
    )

    definition_id: Mapped[str] = mapped_column(String(36), nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(255), nullable=False)
    trigger_event: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")


class ActionLog(TenantScopedModel):
    """The recorded outcome of dispatching a run's action (audit trail)."""

    __tablename__ = "orchestration_action_logs"
    __table_args__ = (Index("ix_orch_action_run", "tenant_id", "run_id"),)

    run_id: Mapped[str] = mapped_column(String(36), nullable=False)
    action_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    request: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    response: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
