"""Agent-run domain logic (transport-agnostic) — ADR-0014.

Pure async functions over an ``AsyncSession`` that the internal agents router
(ADR-0009) exposes to the agent runtime, and that a future authoring UI or tests
can call directly. All queries are tenant-scoped (ADR-0001).

The lifecycle is three steps, mirroring the orchestration engine's shape:

1. ``create_run`` — record the request with the **resolved definition** it will
   execute (§10) and leave it ``pending``. The §8 depth ceiling is enforced here,
   on the create path, because that is the only place a chain can be stopped
   before it costs money.
2. ``claim_run`` — take ownership of a ``pending`` run atomically, before any
   model call. EventBridge delivery is at-least-once, so without this two
   deliveries of the same request both read ``pending`` and both get billed
   (§5). Exactly one claimant wins; the rest are told to stop.
3. ``complete_run`` — write the transcript, result and cost accounting, and move
   the run to exactly one terminal state. A run already in a terminal state is
   refused, so a retried completion cannot rewrite a finished run.

And one step outside the happy path: ``reap_stale_runs`` fails runs a dead
runtime left in ``running``, so a subscriber waiting on ``agent.run.completed``
is released rather than waiting for ever (§5).

Emission is **not** done here: the routers call ``emit_event`` so the event is
buffered on the session and published by ``get_db`` only after the transaction
commits (ADR-0014 §5).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

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


class RunNotClaimableError(Exception):
    """A claim arrived for a run that is not ``pending``.

    Means another invocation owns this run — or it has already finished. The
    caller must exit **without calling the model**: the tokens for this run are
    either already being spent or already spent.
    """

    def __init__(self, run_id: str, status: str) -> None:
        self.run_id = run_id
        self.status = status
        super().__init__(
            f"Agent run {run_id} is {status}, not pending; another invocation has claimed it."
        )


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


async def list_runs(
    db: AsyncSession,
    *,
    tenant_id: str,
    agent_name: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[AgentRun]:
    """Runs for the admin inspection list, newest first, tenant-scoped (ADR-0001).

    Loads only the summary columns — never ``messages``/``result``/
    ``input_payload``, which are unbounded and are exactly why CloudWatch
    truncates. ``definition_snapshot`` is loaded because ``model`` is lifted out
    of it for the summary; it is far smaller than the transcript. The deferred
    heavy columns are never touched here, so serializing an ``AgentRunSummary``
    triggers no lazy IO.

    ``agent_name`` and ``status`` are optional equality filters. Paginated by
    ``limit``/``offset``; the caller bounds ``limit``.
    """
    stmt = (
        select(AgentRun)
        .options(
            load_only(
                AgentRun.id,
                AgentRun.tenant_id,
                AgentRun.created_at,
                AgentRun.updated_at,
                AgentRun.agent_name,
                AgentRun.status,
                AgentRun.definition_snapshot,
                AgentRun.input_tokens,
                AgentRun.output_tokens,
                AgentRun.cost_usd,
                AgentRun.started_at,
                AgentRun.completed_at,
            )
        )
        .where(AgentRun.tenant_id == tenant_id)
    )
    if agent_name is not None:
        stmt = stmt.where(AgentRun.agent_name == agent_name)
    if status is not None:
        stmt = stmt.where(AgentRun.status == status)
    stmt = stmt.order_by(AgentRun.created_at.desc(), AgentRun.id.desc()).limit(limit).offset(offset)
    return list((await db.scalars(stmt)).all())


async def get_run(db: AsyncSession, *, tenant_id: str, run_id: str) -> AgentRun | None:
    """One run, tenant-scoped. The runtime reads its definition and input here —
    the triggering event carries only the id (§5)."""
    return await db.scalar(
        select(AgentRun).where(AgentRun.tenant_id == tenant_id, AgentRun.id == run_id)
    )


async def claim_run(db: AsyncSession, *, tenant_id: str, run_id: str) -> AgentRun | None:
    """Take ownership of a ``pending`` run, moving it to ``running`` (ADR-0014 §5).

    Returns ``None`` when no such run exists for this tenant.

    Raises:
        RunNotClaimableError: when the run is not ``pending`` — another
            invocation owns it, or it has already finished.

    ## Why this exists

    EventBridge delivery is at-least-once. Without a claim, two deliveries of the
    same ``agent.run.requested`` both read ``pending``, both call the provider,
    and **both are billed**; the second completion is then refused by the
    double-completion guard, so the recorded outcome is right and the invoice is
    not. The runtime's local state check cannot help, because it only ever sees
    an *already-terminal* run — with concurrent duplicates, both have spent by
    the time either finishes.

    This is a different failure from the §8 depth ceiling, which bounds
    agent→agent recursion. Same symptom on the invoice, unrelated mechanism,
    neither covers the other.

    ## Why it is a single conditional UPDATE

    The ``WHERE status = 'pending'`` and the write are one statement, so the
    database decides the winner. A read-then-write claim — fetch, check
    ``pending``, assign, flush — reintroduces exactly the race it exists to
    close: both readers see ``pending`` before either writes.

    ``rowcount`` is therefore the verdict, not a subsequent read. The follow-up
    fetch below runs only on the losing path, to say *why* the claim failed.
    """
    # CursorResult, not Result: `rowcount` is only defined for DML, and it is
    # the entire verdict here, so the cast is asserting what the statement is
    # rather than silencing a nuisance.
    result = cast(
        CursorResult[Any],
        await db.execute(
            update(AgentRun)
            .where(
                AgentRun.tenant_id == tenant_id,
                AgentRun.id == run_id,
                AgentRun.status == "pending",
            )
            .values(status="running", started_at=datetime.now(UTC))
        ),
    )

    if result.rowcount == 0:
        # Lost, or absent. Only now is a read safe — the claim has already been
        # decided, so this cannot influence the outcome.
        existing = await get_run(db, tenant_id=tenant_id, run_id=run_id)
        if existing is None:
            return None
        raise RunNotClaimableError(run_id, existing.status)

    await db.flush()
    run = await get_run(db, tenant_id=tenant_id, run_id=run_id)
    if run is not None:
        # The UPDATE bypassed the identity map, so a previously-loaded instance
        # would still report `pending`; refresh inside the async context so
        # response serialization (sync, in a threadpool) does no lazy IO.
        await db.refresh(run)
    return run


# AWS's hard cap on a single Lambda invocation. The reaper's threshold is
# measured against this rather than against the agent-runtime module's own
# `timeout`, so the two cannot drift into reaping live runs (issue #402).
LAMBDA_MAX_SECONDS = 900

REAPED_ERROR = (
    "Reaped: the run was claimed but never reported a result. The runtime that "
    "claimed it is presumed dead (ADR-0014 §5)."
)


async def reap_stale_runs(
    db: AsyncSession,
    *,
    tenant_id: str,
    stale_after_seconds: int,
    now: datetime | None = None,
) -> list[AgentRun]:
    """Fail runs stuck in ``running`` past *stale_after_seconds*, returning them.

    A run reaches ``running`` only by being claimed, so one still there long
    after any invocation could have finished is a runtime that died holding it.
    The model work is already paid for and Core holds no result, so the run
    never terminates — and anything waiting on ``agent.run.completed`` waits for
    ever, because §5's whole point is telling "failed" from "still running".
    This makes that a definite "failed".

    Each run is flipped by its **own** conditional UPDATE, the same shape as
    ``claim_run``: a reap that raced a real completion matches zero rows and is
    skipped, so a late-arriving result is never overwritten. Whichever lands
    first wins, and the other becomes a no-op — which is what makes calling this
    on a schedule safe.

    ``now`` is injectable so a test can age a run without sleeping.
    """
    moment = now or datetime.now(UTC)
    cutoff = moment - timedelta(seconds=stale_after_seconds)

    candidates = list(
        (
            await db.scalars(
                select(AgentRun).where(
                    AgentRun.tenant_id == tenant_id,
                    AgentRun.status == "running",
                    AgentRun.started_at.is_not(None),
                    AgentRun.started_at < cutoff,
                )
            )
        ).all()
    )

    reaped: list[AgentRun] = []
    for candidate in candidates:
        result = cast(
            CursorResult[Any],
            await db.execute(
                update(AgentRun)
                .where(
                    AgentRun.tenant_id == tenant_id,
                    AgentRun.id == candidate.id,
                    # Re-checked, because the SELECT above is a snapshot: the
                    # runtime may have completed the run in between.
                    AgentRun.status == "running",
                )
                .values(status="failed", error=REAPED_ERROR, completed_at=moment)
            ),
        )
        if result.rowcount == 0:
            continue
        await db.flush()
        await db.refresh(candidate)
        reaped.append(candidate)

    return reaped


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
