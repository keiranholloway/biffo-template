"""Agent-run domain logic (transport-agnostic) — ADR-0014.

Pure async functions over an ``AsyncSession`` that the internal agents router
(ADR-0009) exposes to the agent runtime, and that a future authoring UI or tests
can call directly. All queries are tenant-scoped (ADR-0001).

The lifecycle is two steps, mirroring the orchestration engine's shape:

1. ``create_run`` — record the request with the **resolved definition** it will
   execute (§10) and leave it ``pending``. The §8 depth ceiling is enforced here,
   on the create path, because that is the only place a chain can be stopped
   before it costs money.
2. ``complete_run`` — write the transcript, result and cost accounting, and move
   the run to exactly one terminal state. A run already in a terminal state is
   refused, so a retried completion cannot rewrite a finished run.

Emission is **not** done here: the routers call ``emit_event`` so the event is
buffered on the session and published by ``get_db`` only after the transaction
commits (ADR-0014 §5).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models.agent_run import TERMINAL_AGENT_RUN_STATUSES, AgentRun


class DepthLimitExceededError(Exception):
    """A run was requested past the configured maximum chain depth (§8).

    Raised rather than silently clamped: an agent chain that keeps recursing is
    a bug or an attack, and each iteration has an invoice attached, so it must
    fail loudly at the boundary that could still stop it.
    """

    def __init__(self, depth: int, max_depth: int) -> None:
        self.depth = depth
        self.max_depth = max_depth
        super().__init__(
            f"Agent run requested at depth {depth}, which exceeds the maximum "
            f"chain depth of {max_depth} (ADR-0014 §8 loop prevention)."
        )


class RunAlreadyTerminalError(Exception):
    """A completion arrived for a run that has already terminated."""

    def __init__(self, run_id: str, status: str) -> None:
        self.run_id = run_id
        self.status = status
        super().__init__(f"Agent run {run_id} is already {status}; refusing to re-complete it.")


async def create_run(
    db: AsyncSession,
    *,
    tenant_id: str,
    agent_name: str,
    definition_snapshot: dict[str, Any],
    input_payload: dict[str, Any] | None = None,
    causation_id: str | None = None,
    depth: int = 0,
    max_depth: int,
    workflow_run_id: str | None = None,
    thread_id: str | None = None,
    run_as_kind: str = "system",
    run_as_user_id: str | None = None,
) -> AgentRun:
    """Record a requested run in ``pending``, refusing anything past the ceiling.

    Raises:
        DepthLimitExceededError: when ``depth`` is greater than ``max_depth``.
    """
    if depth > max_depth:
        raise DepthLimitExceededError(depth, max_depth)

    run = AgentRun(
        tenant_id=tenant_id,
        agent_name=agent_name,
        status="pending",
        run_as_kind=run_as_kind,
        run_as_user_id=run_as_user_id,
        thread_id=thread_id,
        causation_id=causation_id,
        depth=depth,
        definition_snapshot=definition_snapshot,
        input_payload=input_payload or {},
        messages=[],
        workflow_run_id=workflow_run_id,
    )
    db.add(run)
    await db.flush()
    return run


async def get_run(db: AsyncSession, *, tenant_id: str, run_id: str) -> AgentRun | None:
    """One run, tenant-scoped. The runtime reads its definition and input here —
    the triggering event carries only the id (§5)."""
    return await db.scalar(
        select(AgentRun).where(AgentRun.tenant_id == tenant_id, AgentRun.id == run_id)
    )


async def complete_run(
    db: AsyncSession,
    *,
    tenant_id: str,
    run_id: str,
    status: str,
    messages: list[Any] | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
) -> AgentRun | None:
    """Move a run to its terminal state, recording transcript, result and cost.

    Returns ``None`` when no such run exists for this tenant.

    Raises:
        RunAlreadyTerminalError: when the run has already completed or failed. The
            runtime's completion POST is retryable (§5's second divergence
            point), so a second delivery must not overwrite the first result.
    """
    run = await get_run(db, tenant_id=tenant_id, run_id=run_id)
    if run is None:
        return None
    if run.status in TERMINAL_AGENT_RUN_STATUSES:
        raise RunAlreadyTerminalError(run_id, run.status)

    run.status = status
    if messages is not None:
        run.messages = messages
    run.result = result
    run.error = error
    run.input_tokens = input_tokens
    run.output_tokens = output_tokens
    run.cost_usd = cost_usd
    run.completed_at = datetime.now(UTC)
    await db.flush()
    # onupdate/server_default columns (updated_at) are expired after the flush;
    # refresh within the async context so response serialization (which runs
    # sync in a threadpool) doesn't trigger lazy IO — MissingGreenlet otherwise.
    await db.refresh(run)
    return run
