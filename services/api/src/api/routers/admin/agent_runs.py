"""Admin read surface for agent runs (ADR-0014 §5 / §10).

Cognito-authenticated, admin-gated, tenant-scoped (ADR-0001/ADR-0004). This is
the *only* way a logged-in operator (and the portal, in a follow-up) can read an
agent run: the run's transcript and result would otherwise be reachable only by
grepping CloudWatch, where SQLAlchemy truncates the middle of the message array
(see docs/guides/agentic-workers.md).

Distinct from the run runtime's IAM-signed internal API
(``routers/internal_agents.py``, ADR-0009), which is SigV4-only and allowlisted
to the agent-runtime Lambda role. This router carries a Cognito identity and is
read-only: runs are written exclusively through that internal API. A run's
``messages``/``result``/``input_payload`` are LLM content derived from
attacker-influenceable input and are potentially PII-adjacent business data, so
this is gated behind ``require_admin`` rather than open to any authenticated
caller.

Both endpoints scope every query to the caller's verified ``tenant_id``
(``AgentRun`` is a ``TenantScopedModel``, CLAUDE.md invariant #2) — unlike
``admin/plugins.py``, which reads manifests off disk and is a documented
tenant-scoping exception. This reads tenant data, so it must scope: a run in
another tenant is a 404, never visible.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...agent_runs import aggregate_run_costs, get_run, list_runs
from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...models.agent_run import AGENT_RUN_STATUSES, AgentRun
from ...schemas.agent_run import AgentRunCostAggregate, AgentRunResponse, AgentRunSummary

router = APIRouter(prefix="/admin/agent-runs", tags=["admin"])


def _summary(run: AgentRun) -> AgentRunSummary:
    """Shape a run into the list summary, lifting ``model`` out of the snapshot.

    Reads only the columns ``list_runs`` loaded; the heavy transcript/result
    columns stay deferred and untouched, so this does no lazy IO.
    """
    model = run.definition_snapshot.get("model") if run.definition_snapshot else None
    return AgentRunSummary(
        id=run.id,
        tenant_id=run.tenant_id,
        created_at=run.created_at,
        updated_at=run.updated_at,
        agent_name=run.agent_name,
        status=run.status,
        dry_run=run.dry_run,
        model=model if isinstance(model, str) else None,
        input_tokens=run.input_tokens,
        output_tokens=run.output_tokens,
        cost_usd=run.cost_usd,
        started_at=run.started_at,
        completed_at=run.completed_at,
    )


@router.get("", response_model=list[AgentRunSummary])
async def list_agent_runs(
    agent_name: str | None = Query(None, description="Only runs of this agent."),
    run_status: str | None = Query(
        None, alias="status", description=f"One of: {', '.join(AGENT_RUN_STATUSES)}."
    ),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[AgentRunSummary]:
    """Newest-first, paginated list of this tenant's agent runs.

    A summary per row — id, agent, status, model, token totals, cost, timings —
    never the transcript, result or triggering payload. Fetch one run in full
    from ``GET /admin/agent-runs/{run_id}``.
    """
    if run_status is not None and run_status not in AGENT_RUN_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown status: {run_status}",
        )
    runs = await list_runs(
        db,
        tenant_id=caller.tenant_id,
        agent_name=agent_name,
        status=run_status,
        limit=limit,
        offset=offset,
    )
    return [_summary(run) for run in runs]


@router.get("/costs", response_model=list[AgentRunCostAggregate])
async def aggregate_agent_run_costs(
    agent_name: str | None = Query(None, description="Only runs of this agent."),
    since: datetime | None = Query(None, description="Start of time range (inclusive, ISO 8601)."),
    until: datetime | None = Query(None, description="End of time range (inclusive, ISO 8601)."),
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[AgentRunCostAggregate]:
    """Per-model cost aggregation for a time range, tenant-scoped (ADR-0001).

    Groups runs by model (extracted from definition_snapshot) and sums costs
    and token counts. Runs with NULL cost_usd are counted separately in
    ``unpriced_runs`` and excluded from ``total_cost_usd``, so the caller can
    see how much of the range is unpriced and correct for missing data.

    Default time range is the last 30 days if omitted. An optional ``agent_name``
    filters to runs of that agent.
    """
    now = datetime.now(UTC)
    range_start = since or (now - timedelta(days=30))
    range_end = until or now

    results = await aggregate_run_costs(
        db,
        tenant_id=caller.tenant_id,
        since=range_start,
        until=range_end,
        agent_name=agent_name,
    )
    return [AgentRunCostAggregate.model_validate(r) for r in results]


@router.get("/{run_id}", response_model=AgentRunResponse)
async def get_agent_run(
    run_id: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AgentRunResponse:
    """One run in full — transcript, result, definition snapshot, input payload,
    tokens, cost, timings and error.

    404 when no such run exists **in the caller's tenant**: a run belonging to
    another tenant is indistinguishable from one that does not exist.
    """
    run = await get_run(db, tenant_id=caller.tenant_id, run_id=run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent run not found")
    return AgentRunResponse.model_validate(run)
