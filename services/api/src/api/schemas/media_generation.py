"""Schemas for the media generation cost ledger.

The write side is service-only (a plugin recording what it just generated); the
read side is admin-only (spend triage). See ``models/media_generation.py`` for
why this is a separate table from ``agent_runs`` rather than more columns on it.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from .base import BiffoBaseSchema


class RecordMediaGenerationRequest(BaseModel):
    """One billable non-text generation, as the generating plugin reports it.

    ``caller_plugin`` is deliberately absent: it is resolved from the verified
    ``ServicePrincipal`` at the route, never accepted from the body. Letting a
    caller name itself would make spend attribution forgeable, which is the one
    property a billing ledger cannot give up.
    """

    media_kind: str = Field(description="image | video | audio")
    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=128)

    #: The provider's own quantity, and what the provider called it. Stored
    #: verbatim — see the model's docstring for why normalising here would be
    #: irreversible.
    units: float = Field(gt=0, description="Provider-native quantity, e.g. 1 image, 3.5 seconds")
    unit_kind: str = Field(min_length=1, max_length=32, description="e.g. image, second, megapixel")

    #: Omitted when the provider returned no price. Distinct from 0.0, which
    #: means it really was free.
    cost_usd: float | None = Field(default=None, ge=0)

    #: Ties this asset to the agent chain that produced it, so campaign-level
    #: spend can be assembled across text and media.
    causation_id: str | None = Field(default=None, max_length=255)

    #: Optional idempotency key, so a caller that has already paid a provider can
    #: retry a failed ledger write without risking a duplicate row (issue #1515).
    #:
    #: A repeat POST carrying a key already recorded for this caller returns the
    #: existing row with **200** instead of creating a second one with 201. Omit
    #: it and nothing changes — every post writes a row, exactly as before.
    #:
    #: Scoped per caller as well as per tenant, so two plugins deriving the same
    #: natural key do not collide; unlike ``causation_id`` this is opaque to the
    #: ledger and is never interpreted, only compared.
    client_request_id: str | None = Field(default=None, min_length=1, max_length=255)


class MediaGenerationResponse(BiffoBaseSchema):
    """A recorded generation, as admin spend views show it."""

    caller_plugin: str | None = None
    causation_id: str | None = None
    #: Surfaced on the read side so an operator reconciling a suspected double
    #: charge can see which rows were keyed, and therefore which a retry could
    #: not have duplicated.
    client_request_id: str | None = None
    media_kind: str
    provider: str
    model: str
    units: float
    unit_kind: str
    cost_usd: float | None = None


class MediaCostAggregate(BaseModel):
    """Media spend grouped by caller, provider, model and unit.

    Mirrors ``AgentRunCostAggregate``'s shape on purpose, **including
    ``unpriced``** — a total that does not state how much of its input it could
    not price is a confident number over an unstated denominator, which is the
    error this estate keeps repeating.

    Grouped by ``unit_kind`` as well as model because ``total_units`` is
    otherwise meaningless: summing 3 images and 12 seconds into "15" produces a
    number with no unit at all.
    """

    caller_plugin: str | None = None
    provider: str
    model: str
    media_kind: str
    unit_kind: str
    generations: int
    total_units: float
    total_cost_usd: float
    #: Generations whose provider returned no price. Mutually exclusive with
    #: those contributing to ``total_cost_usd``, so
    #: ``generations == priced + unpriced``.
    unpriced: int


class MediaGenerationListResponse(BaseModel):
    media_generations: list[MediaGenerationResponse]
    #: Echoed so a caller reading a page knows what it asked for without
    #: re-deriving it from the request.
    limit: int
    offset: int


class MediaGenerationCreatedResponse(BaseModel):
    id: str
    created_at: datetime
