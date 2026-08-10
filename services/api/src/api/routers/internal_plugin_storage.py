"""Internal, SigV4-only object storage for plugins (ADR-0009, ADR-0021, #1437).

Four routes under ``/api/v1/internal/plugins/me/storage``, all scoped to the
caller's **own verified identity** — the same shape and the same reason as
``internal_plugin_config``, whose docstring names the threat: a caller-supplied
plugin name *"would let any allowlisted service read another plugin's config."*
Here it would let one plugin read, overwrite and enumerate another's files.

    POST   /presign          mint a presigned POST for a browser upload
    POST   /confirm          verify what landed, record it
    GET    /{id}/url         mint a short-lived GET URL
    GET    /                 list this plugin's own media

Bytes never pass through this Lambda. Core signs and verifies; the browser moves
the data.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import plugin_storage
from ..database import get_db
from ..middleware.service_auth import ServicePrincipal, require_service_principal
from ..models.plugin_media import PluginMedia
from ..plugin_storage import ObjectStorageUnavailableError
from ..schemas.plugin_media import (
    ConfirmUploadRequest,
    MediaUrlResponse,
    PluginMediaResponse,
    PresignUploadRequest,
    PresignUploadResponse,
)

router = APIRouter(prefix="/internal/plugins/me/storage", tags=["internal:plugins"])


def _own_plugin(principal: ServicePrincipal) -> str:
    """The caller's own plugin identity, or 403.

    Copied from ``internal_plugin_config._own_plugin_name`` rather than
    generalised: the two will diverge if one ever needs to admit a non-plugin
    caller, and a shared helper would make that a silent change to both.

    Requires exactly one logical name. A principal resolving to several is not a
    plugin acting as itself, and picking one would be a guess about identity —
    the one thing this must not guess.
    """
    names = principal.logical_names
    if len(names) != 1:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not resolve a single plugin identity for this caller.",
        )
    (name,) = names
    return name.removeprefix("system:")


def _unavailable(exc: ObjectStorageUnavailableError) -> HTTPException:
    """503, not 500.

    An environment with no bucket configured is not a bug in this request — it
    is a deployment that has not been wired. 503 says "try elsewhere/later",
    which is true, where 500 would send someone reading tracebacks.
    """
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


@router.post("/presign", response_model=PresignUploadResponse)
async def presign_upload(
    body: PresignUploadRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
) -> PresignUploadResponse:
    """Mint a presigned POST scoped to this plugin and tenant.

    No database write happens here, deliberately. A presign is an offer, not a
    fact — the client may never use it, and a row written now would describe an
    object that does not exist. The record is created at confirm, when there is
    something to record.
    """
    plugin = _own_plugin(principal)
    # TODO(#1437 follow-up): read the ceiling from the plugin's own manifest
    # declaration once the host exposes it. Until then every plugin gets the
    # platform default, which is deliberately conservative rather than generous.
    max_bytes = plugin_storage.resolve_max_bytes(None)
    try:
        presigned = plugin_storage.presign_upload(
            plugin=plugin,
            tenant_id=principal.tenant_id,
            filename=body.filename,
            content_type=body.content_type,
            max_bytes=max_bytes,
        )
    except ObjectStorageUnavailableError as exc:
        raise _unavailable(exc) from exc

    return PresignUploadResponse(
        key=presigned.key,
        url=presigned.url,
        fields=presigned.fields,
        max_bytes=max_bytes,
        expires_in=plugin_storage.UPLOAD_EXPIRY_SECONDS,
    )


@router.post("/confirm", response_model=PluginMediaResponse, status_code=status.HTTP_201_CREATED)
async def confirm_upload(
    body: ConfirmUploadRequest,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> PluginMediaResponse:
    """Verify what actually landed, then record it.

    Two checks, and both matter:

    **The key must be inside this caller's own prefix.** Otherwise a plugin could
    confirm — and thereby gain a readable record of — an object belonging to
    another plugin or another tenant, without ever having been able to write it.
    Checked against the prefix built from the *verified* principal, so there is
    nothing for the caller to influence.

    **The object must exist**, and its size and type are read from S3 rather
    than accepted. Without that a caller can presign for an image and record
    whatever it likes, and a crashed upload leaves a row describing an object
    that is not there. The estate has both shapes and they disagree —
    ``lms_media`` reads ``ContentLength``; ``ops_evidence`` trusts a
    client-supplied ``size_bytes`` against a ceiling it never verifies. This
    follows ``lms_media``.
    """
    plugin = _own_plugin(principal)
    expected_prefix = f"{plugin_storage.KEY_ROOT}/{plugin}/{principal.tenant_id}/"
    if not body.key.startswith(expected_prefix):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="That key does not belong to this plugin.",
        )

    try:
        stored = plugin_storage.head(body.key)
    except ObjectStorageUnavailableError as exc:
        raise _unavailable(exc) from exc
    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No object at that key — the upload did not complete.",
        )

    # An idempotent confirm. A client retrying after a timeout must get the
    # existing record rather than a duplicate row, or every per-plugin storage
    # total counts the same object twice.
    existing = await db.scalar(
        select(PluginMedia).where(
            PluginMedia.tenant_id == principal.tenant_id,
            PluginMedia.storage_key == body.key,
        )
    )
    if existing is not None:
        return PluginMediaResponse.model_validate(existing)

    row = PluginMedia(
        tenant_id=principal.tenant_id,
        owner_plugin=f"system:{plugin}",
        storage_key=body.key,
        filename=body.key.rsplit("/", 1)[-1],
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
    )
    db.add(row)
    await db.flush()
    await db.refresh(row)
    return PluginMediaResponse.model_validate(row)


@router.get("/{media_id}/url", response_model=MediaUrlResponse)
async def media_url(
    media_id: str,
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> MediaUrlResponse:
    """A short-lived GET URL for one of this plugin's own objects.

    Minted per request rather than stored, because a stored URL is stale the
    moment it is written. Scoped by owner and tenant in the query itself, so a
    plugin asking for another's id gets 404 — the same answer as an id that does
    not exist, which is deliberate: distinguishing them would confirm existence
    to a caller with no right to know.
    """
    # Checked before the lookup, not after: if storage is unconfigured the answer
    # is 503 for every id, so querying first spends a round trip to reach a
    # conclusion already known.
    try:
        plugin_storage.ensure_configured()
    except ObjectStorageUnavailableError as exc:
        raise _unavailable(exc) from exc

    row = await db.scalar(
        select(PluginMedia).where(
            PluginMedia.id == media_id,
            PluginMedia.tenant_id == principal.tenant_id,
            PluginMedia.owner_plugin == f"system:{_own_plugin(principal)}",
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")

    url = plugin_storage.presign_download(row.storage_key, filename=row.filename)
    return MediaUrlResponse(url=url, expires_in=plugin_storage.DOWNLOAD_EXPIRY_SECONDS)


@router.get("", response_model=list[PluginMediaResponse])
async def list_media(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    principal: ServicePrincipal = Depends(require_service_principal),
    db: AsyncSession = Depends(get_db),
) -> list[PluginMediaResponse]:
    """This plugin's own media, newest first."""
    rows = (
        await db.scalars(
            select(PluginMedia)
            .where(
                PluginMedia.tenant_id == principal.tenant_id,
                PluginMedia.owner_plugin == f"system:{_own_plugin(principal)}",
            )
            .order_by(PluginMedia.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return [PluginMediaResponse.model_validate(r) for r in rows]
