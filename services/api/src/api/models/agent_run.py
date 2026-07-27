"""Agent run state — the durable record of one agentic worker invocation (ADR-0014).

The agent framework is first-party core capability: definitions and runs live
here in Core, and the execution runtime reaches them over the internal service
API (ADR-0009), never the database (ADR-0002).

An ``AgentRun`` is **its own record**, deliberately not the orchestration
``WorkflowRun`` that spawned it (ADR-0014 §6.1). Async invocation is
``event -> workflow run -> agent run``; a future synchronous path would be
``request -> agent run``. Both produce identical rows, so nothing downstream
encodes "I was triggered by an event".

Four §6 choices are live from this first commit because retrofitting any of them
means revisiting decisions made in their absence:

- ``status`` is an explicit state machine (``pending`` -> ``running`` ->
  ``completed``/``failed``). It is also what makes a multi-turn loop resumable
  across Lambda invocations (§8).
- ``run_as_kind``/``run_as_user_id`` carry an explicit principal. v1 always
  writes ``system``; the field exists so user-delegated authority later composes
  as ceiling ∩ declared scope ∩ the user's own permissions (§7) rather than
  requiring every permission check to be revisited.
- ``thread_id`` is nullable. A *run* is one invocation to completion, bounded in
  cost and time; a *thread* is a sequence of runs sharing message history. Chat
  is a thread of runs, not one unbounded run.
- ``causation_id``/``depth`` travel with the run for loop prevention (§8) —
  event-triggered processes that emit events can cycle, and here every iteration
  has an invoice attached.

``definition_snapshot`` is the one field that cannot be added later at full
value (§10). A run records the **resolved definition it executed** — instructions,
model, tool list, read scope, limits — so it stays explainable after its
definition is edited in place. Nothing can backfill a run that did not capture
what it ran.

This model deliberately does **not** declare ``__crud_permissions__``: it is not
exposed through the generic-CRUD layer (ADR-0004). The runtime reaches it only
through the hand-written internal router (``routers/internal_agents.py``), whose
completion route is authorised by the run's own state rather than generic CRUD
(§7: "writes are not reachable through this path at all").
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel

# Run lifecycle (ADR-0014 §6). A run is created ``pending``, moved to ``running``
# when the runtime picks it up, and reaches exactly one terminal state.
AGENT_RUN_STATUSES = ("pending", "running", "completed", "failed")
TERMINAL_AGENT_RUN_STATUSES = ("completed", "failed")

# The principal a run executes as (ADR-0014 §6.2 / §7). v1 only ever writes
# "system"; "user" is designed for and not exercised.
RUN_AS_KINDS = ("system", "user")


class AgentRun(TenantScopedModel):
    """One invocation of an agentic worker, from request to terminal state."""

    __tablename__ = "agent_runs"
    __table_args__ = (
        # The run-inspection views: by agent, and by the thread a run belongs to.
        Index("ix_agent_run_agent", "tenant_id", "agent_name", "status"),
        Index("ix_agent_run_thread", "tenant_id", "thread_id"),
        # Trace back to the orchestration run that requested this one.
        Index("ix_agent_run_workflow", "tenant_id", "workflow_run_id"),
    )

    # The orchestration WorkflowRun that created this run, when there was one.
    # Nullable because a future synchronous invocation has no workflow run (§6.1).
    workflow_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    agent_name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")

    # Whose authority the run executes under (§6.2). Always "system" in v1.
    run_as_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="system")
    run_as_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    # A sequence of runs sharing message history (§6.4). Null for a one-shot run.
    thread_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    # Loop prevention (§8): what caused this run, and how deep the chain is.
    causation_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    depth: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # The resolved definition this run executed (§10) — instructions, model,
    # tools, read scope, limits. Captured at create time; never rewritten.
    definition_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    # The triggering event payload the run was handed.
    input_payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    # The turn transcript (§6.3). A list of message dicts, appended by the
    # runtime and written back on completion.
    messages: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # A preview run: executed identically, but nothing downstream may react to it
    # (issue #726). The whole side-effect surface hangs off `agent.run.completed`
    # — the orchestrator is its only subscriber, and is what fires write-backs and
    # fan-in — so "causes nothing" is enforced by not emitting that one event,
    # rather than by a flag threaded through every action.
    #
    # It is therefore load-bearing at exactly one moment: after the runtime has
    # finished, when the run is otherwise indistinguishable from a real one.
    dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Cost accounting (§8). Nullable: unknown until the run terminates, and a
    # failure may terminate before any tokens were spent.
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
