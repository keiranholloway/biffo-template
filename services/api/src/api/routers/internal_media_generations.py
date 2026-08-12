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

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..media_generations import record_generation
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.media_generation import MEDIA_KINDS
from ..schemas.media_generation import (
    MediaGenerationCreatedResponse,
    RecordMediaGenerationRequest,
)

router = APIRouter(prefix="/internal/media-generations", tags=["internal:media"])


@router.post("", response_model=MediaGenerationCreatedResponse, status_code=status.HTTP_201_CREATED)
async def record_media_generation(
    body: RecordMediaGenerationRequest,
    response: Response,
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

    ``client_request_id`` makes this create-or-**get** (issue #1515). A caller
    that has already paid a provider and then lost this response cannot tell
    whether its row landed; with a key it can simply post again and get the same
    row back with **200**, instead of choosing between losing the record and
    double-recording the charge. Uniqueness is enforced by a unique index rather
    than by a prior read, so two overlapping retries still produce one row.

    Without a key the behaviour is unchanged, **including the 201** — existing
    callers send none, and collapsing their posts would silently drop real
    charges that legitimately look alike.
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

    row, created = await record_generation(
        db,
        tenant_id=principal.tenant_id,
        caller_plugin=caller_plugin,
        causation_id=body.causation_id,
        media_kind=body.media_kind,
        provider=body.provider,
        model=body.model,
        units=body.units,
        unit_kind=body.unit_kind,
        cost_usd=body.cost_usd,
        client_request_id=body.client_request_id,
    )

    if not created:
        # The key matched a row this caller already recorded. 200 rather than 201
        # so a caller can tell a retry that found its earlier write from a first
        # attempt — and rather than 409, because a duplicate here is the caller
        # doing exactly the right thing and it needs the id, not an error.
        response.status_code = status.HTTP_200_OK

    return MediaGenerationCreatedResponse(id=row.id, created_at=row.created_at)
