"""Internal, SigV4-only write for the media generation cost ledger (ADR-0009).

POST /api/v1/internal/media-generations — a plugin records what a non-text
generation cost, immediately after making it.

``caller_plugin`` is resolved from the caller's **verified** identity
(``ServicePrincipal.logical_names``), never from the request body — the same
rule, for the same reason, as ``internal_plugin_config``: a caller-supplied name
would let any allowlisted service attribute its spend to another plugin. For a
billing ledger that is not a tidiness concern, it is the property the whole
table depends on.

Single-tenant deployment (ADR-0001): tenant comes from the principal, which
defaults to ``"default"``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.media_generation import MEDIA_KINDS, MediaGeneration
from ..schemas.media_generation import (
    MediaGenerationCreatedResponse,
    RecordMediaGenerationRequest,
)

router = APIRouter(prefix="/internal/media-generations", tags=["internal:media"])


@router.post("", response_model=MediaGenerationCreatedResponse, status_code=status.HTTP_201_CREATED)
async def record_media_generation(
    body: RecordMediaGenerationRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> MediaGenerationCreatedResponse:
    """Record one billable generation.

    Rejects an unknown ``media_kind`` with 422 rather than storing it. The set is
    validated here rather than as a database enum so adding a kind does not need
    a migration in every instance — but it *is* validated, because an unrecognised
    kind silently accepted would sit in the ledger contributing to no rollup and
    visible in no report, which is the same as not recording it while looking
    like success.
    """
    if body.media_kind not in MEDIA_KINDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"media_kind must be one of {', '.join(MEDIA_KINDS)}",
        )

    # From the verified principal, never the body. `logical_names` resolves a
    # host-mounted plugin (via the signed X-Biffo-Plugin header) and an isolated
    # plugin (from its role ARN); a caller that is neither resolves to an empty
    # set and is honestly recorded as None rather than forced into a
    # plugin-shaped answer.
    caller_plugin = next(iter(principal.logical_names), None)

    row = MediaGeneration(
        tenant_id=principal.tenant_id,
        caller_plugin=caller_plugin,
        causation_id=body.causation_id,
        media_kind=body.media_kind,
        provider=body.provider,
        model=body.model,
        units=body.units,
        unit_kind=body.unit_kind,
        cost_usd=body.cost_usd,
    )
    db.add(row)
    await db.flush()
    await db.refresh(row)

    return MediaGenerationCreatedResponse(id=row.id, created_at=row.created_at)
