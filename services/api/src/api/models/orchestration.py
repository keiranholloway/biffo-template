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

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel

# Run lifecycle states. A run is created ``pending`` when claimed, moved to
# ``dispatched`` once the engine begins the action, then ``succeeded``/``failed``
# by the recorded result. ``skipped`` is reserved for definitions that matched
# but chose not to act (e.g. a future trigger_filter miss, or a scheduled run
# whose definition was disabled/deleted before its fire time). A definition
# carrying ``schedule_config`` claims its run as ``scheduled`` instead of
# ``pending`` — waiting on ``scheduled_for`` rather than about to dispatch now
# — then ``dispatching`` once the fire-time callback claims it for execution
# (guarding EventBridge Scheduler's at-least-once delivery from double-firing).
RUN_STATUSES = (
    "pending",
    "scheduled",
    "dispatching",
    "dispatched",
    "succeeded",
    "failed",
    "skipped",
)


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
        # A plugin's own natural key for a definition it declares (issue #1593):
        # unique per (tenant, owner_plugin, definition_key) so re-declaring the
        # same key upserts the same row instead of piling up duplicates on every
        # cold start. Both columns are NULL together on every definition an
        # admin authors through orchestration.py (owner_plugin is never set
        # there), and a NULL participant exempts a row from a unique index in
        # both SQLite and Postgres — so admin-authored rows are never
        # constrained by this index at all, and it is a plain composite index
        # rather than the COALESCE trick 0019 needed: that migration had to
        # keep enforcing uniqueness for a nullable *first* column, which does
        # not apply here since a row only ever carries a definition_key when it
        # also carries an owner_plugin (the seed route always sets both).
        Index(
            "uq_orch_def_owner_key",
            "tenant_id",
            "owner_plugin",
            "definition_key",
            unique=True,
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
    # Optional delay before this definition's action fires, e.g. a follow-up
    # 2 weeks after onboarding (docs/implementation/0002-scheduled-workflow-actions).
    # ``{"type": "fixed_delay", "delay_seconds": N}`` today; ``type`` is a
    # discriminator left for a future "relative to a payload timestamp field"
    # variant without a schema migration, mirroring how ``action_config``
    # already carries a type-discriminated shape rather than dedicated columns.
    # None -> fires immediately (today's behaviour, unchanged).
    schedule_config: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # Optional hierarchy scope (docs/implementation/0003-hierarchy-scoped-workflows):
    # ``{"level": <str>, "id": <str>}``. ``level`` is an opaque string this
    # template never hardcodes — what levels exist (e.g. "brand"/"region"/
    # "unit") and their ordering is entirely defined by whichever
    # ``ScopeResolver`` an instance registers (``scope_resolvers.py``). None
    # (every existing definition) means unscoped/tenant-wide — today's
    # behaviour, unchanged.
    scope: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # Whose authority this definition's actions run under (ADR-0027 §2).
    #
    # Stamped with the authenticated caller on every create, update and enable —
    # authority re-binds to whoever last exercised it, so a definition always runs
    # as a user who affirmatively saved it in its current form. Nullable because
    # every definition written before write-back existed has no author to name,
    # and a definition with no ``run_as_user_id`` cannot carry a write-back at
    # all: fail-closed, rather than falling back to some ambient principal.
    #
    # ``run_as_kind`` mirrors ``AgentRun.run_as_kind`` (ADR-0014 §6.2) and stays
    # "system" for a definition that predates this, so the two records agree on
    # what a missing principal means.
    run_as_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    run_as_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="system")

    # The plugin that self-declared this definition via
    # POST /internal/plugins/me/workflows/seed (issue #1593), resolved from
    # ServicePrincipal.logical_names — never caller-supplied. NULL for every
    # definition authored through the human orchestration.py CRUD (the normal
    # case today), which never sets this column, so the two authoring paths
    # can never collide: a plugin's seed can only ever find and update rows it
    # itself created, and an admin's row is never visible to any plugin's seed
    # pre-read (see internal_plugin_workflows.py).
    owner_plugin: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # The plugin's own stable identifier for this definition (its half of the
    # upsert key, alongside owner_plugin) — e.g. "agent-fan-in". Chosen by the
    # plugin, stable across redeploys, and never renamed by re-declaring:
    # changing it creates a second row rather than renaming the first, exactly
    # like PluginChatAgent.agent_key. NULL alongside owner_plugin for every
    # admin-authored row.
    definition_key: Mapped[str | None] = mapped_column(String(100), nullable=True)


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
    # Set only when the claiming definition carries a ``schedule_config``: the
    # UTC instant the plugin's EventBridge Scheduler one-time schedule fires.
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The deterministic EventBridge Scheduler schedule name (``wf-run-{id}``),
    # so a future "cancel" admin action has something to call DeleteSchedule
    # with. Not read by v1 execution — the schedule self-deletes on fire
    # (``ActionAfterCompletion=DELETE``).
    schedule_name: Mapped[str | None] = mapped_column(String(128), nullable=True)


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
