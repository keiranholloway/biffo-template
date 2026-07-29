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

And one step outside the happy path: ``reap_stale_runs`` fails runs that can no
longer progress — both those a dead runtime left in ``running`` and those
**nothing ever claimed**, still sitting in ``pending`` — so a subscriber waiting
on ``agent.run.completed`` is released rather than waiting for ever (§5). The
second shape was missing until idea-scout#27, which meant a run that was never
picked up was invisible to the sweep built to catch abandoned work.

Emission is **not** done here: the routers call ``emit_event`` so the event is
buffered on the session and published by ``get_db`` only after the transaction
commits (ADR-0014 §5).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from .models.agent_run import TERMINAL_AGENT_RUN_STATUSES, AgentRun
from .prompt_library import resolve_definition_snapshot


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


def run_reference_payload(run: AgentRun) -> dict[str, object]:
    """The event payload for a run: a **reference**, never the result (ADR-0014 §5).

    The transcript and the run's output are LLM content derived from
    attacker-influenceable input, so they stay behind the authenticated fetch
    rather than being broadcast to every subscriber.

    Lives here rather than beside one of its emitters because both
    ``agent.run.requested`` and ``agent.run.completed`` carry this exact shape, and
    they are now emitted from two modules (the internal router for real runs, the
    dry-run service for previews). A second hand-rolled copy of this dict is how
    the two events quietly stop agreeing on what a run reference is.
    """
    return {
        "run_id": run.id,
        "agent": run.agent_name,
        "status": run.status,
        "causation_id": run.causation_id,
        "depth": run.depth,
    }


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
    dry_run: bool = False,
    idempotency_key: str | None = None,
) -> tuple[AgentRun, bool]:
    """Record a requested run in ``pending``, refusing anything past the ceiling.

    The prompt library resolves here (ADR-0015 §3/§4): the snapshot's ordered
    ``instructions``/``goals`` parts are composed and variable-substituted into
    final strings *before* they enter the run, so the ``definition_snapshot``
    stored — and what the runtime later reads — is the resolved prompt. The
    runtime never sees a component. A plain-string prompt (the pre-library shape)
    round-trips unchanged. Resolution runs *after* the depth check, the cheapest
    guard, so a runaway chain is refused without a component fetch.

    ``dry_run`` marks a preview (issue #726). It changes nothing here — a dry run
    is created, claimed, executed and completed exactly like a real one, because
    a preview that took a different path would not be previewing anything. It is
    read once, by the completion endpoint, to decide whether to announce the run
    on the bus.

    ``idempotency_key`` makes this create-or-**get**. Agent-run creation is
    reached from at-least-once event delivery, and `agent_fan_in`'s guard against
    firing twice is a check-then-act — two sibling completions landing within
    milliseconds both see no follow-on and both create one (#661). A caller that
    can name the work deterministically passes a key, and the database decides
    who wins instead of a race.

    The insert runs inside a SAVEPOINT, the same shape as
    ``orchestration._claim_run``: a duplicate rolls back only the insert, not the
    caller's transaction, and the run already there is fetched and returned.

    Returns ``(run, created)``. ``created`` is False when an existing run was
    returned — the caller needs it, because announcing ``agent.run.requested``
    for a run it did not create would dispatch the same work twice.

    Raises:
        DepthLimitExceededError: when ``depth`` is greater than ``max_depth``.
        PromptPartsError / PromptComponentMissingError: when a referenced
            component is missing or a required variable is unsupplied — the run
            is aborted loudly rather than created with a broken prompt (§6).
    """
    if depth > max_depth:
        raise DepthLimitExceededError(depth, max_depth)

    resolved_snapshot = await resolve_definition_snapshot(
        db, tenant_id=tenant_id, snapshot=definition_snapshot
    )

    run = AgentRun(
        tenant_id=tenant_id,
        agent_name=agent_name,
        status="pending",
        run_as_kind=run_as_kind,
        run_as_user_id=run_as_user_id,
        thread_id=thread_id,
        causation_id=causation_id,
        depth=depth,
        definition_snapshot=resolved_snapshot,
        input_payload=input_payload or {},
        messages=[],
        workflow_run_id=workflow_run_id,
        dry_run=dry_run,
        idempotency_key=idempotency_key,
    )

    if idempotency_key is None:
        db.add(run)
        await db.flush()
        return run, True

    try:
        async with db.begin_nested():
            db.add(run)
            await db.flush()
    except IntegrityError:
        existing = await db.scalars(
            select(AgentRun).where(
                AgentRun.tenant_id == tenant_id,
                AgentRun.idempotency_key == idempotency_key,
            )
        )
        return existing.one(), False
    return run, True


async def aggregate_run_costs(
    db: AsyncSession,
    *,
    tenant_id: str,
    since: datetime,
    until: datetime,
    agent_name: str | None = None,
) -> list[dict[str, str | int | float]]:
    """Per-model cost aggregation for a time range, tenant-scoped (ADR-0001).

    Groups runs by the model field (extracted from ``definition_snapshot``) and
    sums costs and token counts. Runs with NULL ``cost_usd`` are counted in
    ``unpriced_runs`` and excluded from ``total_cost_usd``, so the caller can
    see how much of the range is unpriced and correct for missing data.

    Returns one dict per distinct model with keys:
    - ``model`` (str | None): The model name, or None if not set in the snapshot.
    - ``runs`` (int): Total runs for this model.
    - ``total_cost_usd`` (float): Sum of cost_usd, excluding NULLs.
    - ``total_input_tokens`` (int): Sum of input_tokens.
    - ``total_output_tokens`` (int): Sum of output_tokens.
    - ``unpriced_runs`` (int): Count of runs with NULL cost_usd.

    ## Implementation note

    ``model`` is not a column; it lives inside ``definition_snapshot`` JSON and
    must be lifted out in Python. This approach (b) fetches rows and groups in
    Python rather than attempting cross-dialect JSON extraction, because:

    - Simple and provably correct on both SQLite and Postgres.
    - This is an admin analytics view, not a hot path.
    - The call is bounded by date range and optional agent filter.
    """
    stmt = (
        select(AgentRun)
        .options(
            load_only(
                AgentRun.definition_snapshot,
                AgentRun.agent_name,
                AgentRun.input_tokens,
                AgentRun.output_tokens,
                AgentRun.cost_usd,
                AgentRun.created_at,
            )
        )
        .where(
            AgentRun.tenant_id == tenant_id,
            AgentRun.created_at >= since,
            AgentRun.created_at <= until,
        )
    )
    if agent_name is not None:
        stmt = stmt.where(AgentRun.agent_name == agent_name)

    runs = list((await db.scalars(stmt)).all())

    # Group by model, lifting model out of definition_snapshot.
    groups: dict[str | None, dict[str, str | int | float]] = {}
    for run in runs:
        model = run.definition_snapshot.get("model") if run.definition_snapshot else None
        # Normalize: model must be a string or None, never any other type
        if not isinstance(model, str):
            model = None

        if model not in groups:
            groups[model] = {
                "model": model or "",
                "runs": 0,
                "total_cost_usd": 0.0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "unpriced_runs": 0,
            }

        groups[model]["runs"] = cast(int, groups[model]["runs"]) + 1
        if run.cost_usd is not None:
            total_cost = cast(float, groups[model]["total_cost_usd"]) + run.cost_usd
            groups[model]["total_cost_usd"] = total_cost
        else:
            groups[model]["unpriced_runs"] = cast(int, groups[model]["unpriced_runs"]) + 1

        if run.input_tokens is not None:
            groups[model]["total_input_tokens"] = (
                cast(int, groups[model]["total_input_tokens"]) + run.input_tokens
            )
        if run.output_tokens is not None:
            groups[model]["total_output_tokens"] = (
                cast(int, groups[model]["total_output_tokens"]) + run.output_tokens
            )

    return list(groups.values())


async def list_runs(
    db: AsyncSession,
    *,
    tenant_id: str,
    agent_name: str | None = None,
    status: str | None = None,
    causation_id: str | None = None,
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

    ``agent_name``, ``status`` and ``causation_id`` are optional equality
    filters. Paginated by ``limit``/``offset``; the caller bounds ``limit``.

    ``causation_id`` is how a chain is read back (ADR-0014 §8). Every run a
    chain spawns carries the root's id, so filtering on it answers "what else is
    in this chain?" — the question a fan-in has to ask when one of N parallel
    runs completes and it must decide whether the rest are done. Note the root
    run itself has ``causation_id`` NULL (it caused nothing before it), so a
    chain query returns the descendants, not the root.
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
                # Loaded because the summary carries it (#726). Omitted, the
                # attribute is unloaded rather than false, so the list would
                # either lazy-load per row or report every run as real.
                AgentRun.dry_run,
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
    if causation_id is not None:
        stmt = stmt.where(AgentRun.causation_id == causation_id)
    stmt = stmt.order_by(AgentRun.created_at.desc(), AgentRun.id.desc()).limit(limit).offset(offset)
    return list((await db.scalars(stmt)).all())


async def list_thread_runs(
    db: AsyncSession,
    *,
    tenant_id: str,
    thread_id: str,
    limit: int = 100,
) -> list[AgentRun]:
    """The runs of one thread, oldest first, tenant-scoped (ADR-0001, ADR-0016 §2).

    A *thread* is the sequence of runs sharing ``thread_id``; the prompt assistant
    assembles the next turn's history from these prior runs' transcripts. Ordered
    oldest-first (``created_at`` ascending) so the conversation replays in the order
    it happened. Unlike ``list_runs`` this loads the full row — the ``messages``
    transcript is exactly what history is built from.

    ``limit`` bounds how many runs are read; the assistant separately bounds the
    replayed *message* count (ADR-0016 §8).
    """
    stmt = (
        select(AgentRun)
        .where(AgentRun.tenant_id == tenant_id, AgentRun.thread_id == thread_id)
        .order_by(AgentRun.created_at.asc(), AgentRun.id.asc())
        .limit(limit)
    )
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

UNCLAIMED_ERROR = (
    "Reaped: the run was requested but never claimed by a runtime. The "
    "`agent.run.requested` event is presumed undelivered (ADR-0014 §5)."
)


async def reap_stale_runs(
    db: AsyncSession,
    *,
    tenant_id: str,
    stale_after_seconds: int,
    unclaimed_after_seconds: int | None = None,
    now: datetime | None = None,
) -> list[AgentRun]:
    """Fail runs that can no longer make progress, returning them.

    Two kinds of abandonment, which look nothing alike and strand a caller
    identically:

    ``running`` past *stale_after_seconds* — a run reaches ``running`` only by
    being claimed, so one still there long after any invocation could have
    finished is a runtime that died holding it. The model work is already paid
    for and Core holds no result.

    ``pending`` past *unclaimed_after_seconds* — the run was requested and
    **nothing ever picked it up**, because the ``agent.run.requested`` event was
    never delivered or its handler never ran. Aged from ``created_at``, since a
    run that was never claimed has no ``started_at`` to measure from. This was
    the gap in idea-scout#27: the sweep looked only at ``running``, so a run
    that never left ``pending`` was invisible to it — the *most* abandoned runs
    were the only ones it could not see. One survived ~17 sweeps over 255
    minutes while still presenting to the founder as "Running".

    Either way, §5's whole point is telling "failed" from "still running"; a
    stranded run says neither, and anything waiting on ``agent.run.completed``
    waits for ever. This makes it a definite "failed".

    Each run is flipped by its **own** conditional UPDATE, the same shape as
    ``claim_run``: a reap that raced a real completion — or, for a pending run,
    raced the claim itself — matches zero rows and is skipped, so a late arrival
    is never overwritten. Whichever lands first wins, and the other becomes a
    no-op, which is what makes calling this on a schedule safe.

    *unclaimed_after_seconds* defaults to *stale_after_seconds* so an existing
    caller keeps working, but the two are configured separately: they are
    bounded by different things (a Lambda invocation cap versus event-delivery
    latency), and collapsing them would let one be moved by a change meant for
    the other.

    ``now`` is injectable so a test can age a run without sleeping.
    """
    moment = now or datetime.now(UTC)
    cutoff = moment - timedelta(seconds=stale_after_seconds)
    unclaimed_cutoff = moment - timedelta(
        seconds=stale_after_seconds if unclaimed_after_seconds is None else unclaimed_after_seconds
    )

    candidates = list(
        (
            await db.scalars(
                select(AgentRun).where(
                    AgentRun.tenant_id == tenant_id,
                    or_(
                        and_(
                            AgentRun.status == "running",
                            AgentRun.started_at.is_not(None),
                            AgentRun.started_at < cutoff,
                        ),
                        and_(
                            AgentRun.status == "pending",
                            AgentRun.created_at < unclaimed_cutoff,
                        ),
                    ),
                )
            )
        ).all()
    )

    reaped: list[AgentRun] = []
    for candidate in candidates:
        # Which state it was found in decides both the re-check and the message.
        # A pending run must not be failed with "the runtime that claimed it is
        # presumed dead" — nothing claimed it, and that wording would send the
        # next person looking at the runtime instead of at event delivery.
        was_running = candidate.status == "running"
        result = cast(
            CursorResult[Any],
            await db.execute(
                update(AgentRun)
                .where(
                    AgentRun.tenant_id == tenant_id,
                    AgentRun.id == candidate.id,
                    # Re-checked, because the SELECT above is a snapshot: the
                    # runtime may have completed — or, for a pending run,
                    # claimed — it in between.
                    AgentRun.status == ("running" if was_running else "pending"),
                )
                .values(
                    status="failed",
                    error=REAPED_ERROR if was_running else UNCLAIMED_ERROR,
                    completed_at=moment,
                )
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
