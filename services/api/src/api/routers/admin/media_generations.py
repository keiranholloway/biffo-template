"""Admin read surface for the media generation cost ledger.

Two routes, both admin-gated and both tenant-scoped, mirroring
``routers/admin/agent_runs.py``:

* ``GET /admin/media-generations`` — the newest generations, for triage.
* ``GET /admin/media-generations/costs`` — spend grouped by caller, provider,
  model and unit, **with the unpriced count beside the total**.

Why the unpriced count is not optional: a provider that returns no price leaves
``cost_usd`` NULL, which is a different fact from a generation that was free. A
total that does not say how much of its input it could not price is a confident
number over an unstated denominator — the estate's most-repeated defect, and the
reason ``aggregate_run_costs`` already reports ``unpriced_runs``.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...database import get_db
from ...dependencies import AuthenticatedUser, require_admin
from ...models.media_generation import MediaGeneration
from ...schemas.media_generation import (
    MediaCostAggregate,
    MediaGenerationListResponse,
    MediaGenerationResponse,
)

router = APIRouter(prefix="/admin/media-generations", tags=["admin"])


@router.get("", response_model=MediaGenerationListResponse)
async def list_media_generations(
    caller_plugin: str | None = Query(default=None),
    media_kind: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> MediaGenerationListResponse:
    stmt = (
        select(MediaGeneration)
        .where(MediaGeneration.tenant_id == caller.tenant_id)
        .order_by(MediaGeneration.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if caller_plugin is not None:
        stmt = stmt.where(MediaGeneration.caller_plugin == caller_plugin)
    if media_kind is not None:
        stmt = stmt.where(MediaGeneration.media_kind == media_kind)

    rows = (await db.scalars(stmt)).all()
    return MediaGenerationListResponse(
        media_generations=[MediaGenerationResponse.model_validate(r) for r in rows],
        limit=limit,
        offset=offset,
    )


@router.get("/costs", response_model=list[MediaCostAggregate])
async def media_costs(
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    caller_plugin: str | None = Query(default=None),
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[MediaCostAggregate]:
    """Spend grouped by caller, provider, model, kind and unit.

    Grouped by ``unit_kind`` as well, because ``total_units`` is otherwise
    meaningless: summing 3 images and 12 seconds into "15" produces a number
    with no unit at all.

    Aggregated in Python rather than SQL for the same reason
    ``aggregate_run_costs`` is — it is provably identical on SQLite and Postgres,
    and this is an admin-only, tenant-scoped, date-ranged read. The same scale
    caveat applies: no LIMIT, so a very large range loads a lot of rows.
    """
    range_start = since or (datetime.now(UTC) - timedelta(days=30))
    range_end = until or datetime.now(UTC)

    stmt = select(MediaGeneration).where(
        MediaGeneration.tenant_id == caller.tenant_id,
        MediaGeneration.created_at >= range_start,
        MediaGeneration.created_at <= range_end,
    )
    if caller_plugin is not None:
        stmt = stmt.where(MediaGeneration.caller_plugin == caller_plugin)

    buckets: dict[tuple, dict] = defaultdict(
        lambda: {"generations": 0, "total_units": 0.0, "total_cost_usd": 0.0, "unpriced": 0}
    )
    for row in (await db.scalars(stmt)).all():
        key = (row.caller_plugin, row.provider, row.model, row.media_kind, row.unit_kind)
        b = buckets[key]
        b["generations"] += 1
        b["total_units"] += row.units
        # Mutually exclusive by construction, so generations == priced + unpriced.
        # A NULL price is counted, never silently treated as zero.
        if row.cost_usd is not None:
            b["total_cost_usd"] += row.cost_usd
        else:
            b["unpriced"] += 1

    return [
        MediaCostAggregate(
            caller_plugin=k[0],
            provider=k[1],
            model=k[2],
            media_kind=k[3],
            unit_kind=k[4],
            **v,
        )
        for k, v in sorted(buckets.items(), key=lambda kv: str(kv[0]))
    ]
