"""Media generation cost ledger — what non-text generation cost, and who spent it.

`agent_runs` already prices **text**, and prices it well: `cost_usd` is a real
provider price snapshot (OpenRouter's `usage.cost`), not a rate-table
calculation, so a later price change cannot rewrite history. This table does the
same job for the half `agent_runs` structurally cannot hold.

## Why not more columns on `agent_runs`

The agent runtime is text-only by construction. `LLMClient` declares one
chat-shaped method, `Message` content is a string, and
`CompleteAgentRunRequest` accepts exactly `status`, `messages`, `result`,
`error`, `input_tokens`, `output_tokens`, `cost_usd`.

A generated image has **no tokens**. Routing its charge through `cost_usd` would
make it indistinguishable from an LLM charge, **and would corrupt
`aggregate_run_costs`**, which groups by `definition_snapshot["model"]` and
reports an `unpriced_runs` count beside the total: a media charge with no model
and no tokens would land in the wrong bucket and inflate a per-model total that
readers reasonably believe is about language models.

There is precedent for this exact wall. Wall-clock duration hit it and was
dropped to logs rather than persisted — the runtime's own comment says the
completion schema has no field for it, so sending it would be dropped at best,
and persisting it is a Core-side change.

## Why this cannot wait for a pricing model

Credits and tiering are a pricing decision. The ledger they bill from is not: a
credit system introduced against an empty history has nothing to bill from and no
way to set a defensible default allowance.

Worse, a credit system that meters text but **not** media would bill the cheap
half and silently give away the expensive half — the same denominator blindness
this estate keeps paying for, pointed at revenue.

**Enforcement is deliberately out of scope.** Recording is not. Note also that
the runtime's existing `depth`, `max_turns`, wall-clock timeout and
tool-calls-per-turn ceilings bound *looping*, not *spend* — a run has no cost
ceiling today, and those guards should not be mistaken for a budget.

Like `AgentRun`, `PromptComponent` and `WorkflowDefinition`, this deliberately
declares no ``__crud_permissions__``: no Core model does. Core tables are exposed
through hand-written routers, not the generic-CRUD layer (ADR-0004).
"""

from __future__ import annotations

from sqlalchemy import Float, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel

#: Media kinds this ledger knows how to price. Deliberately coarse: the unit
#: differs per kind (see ``units``), and a finer taxonomy would multiply the
#: normalisation table without changing any answer anyone asks.
MEDIA_KINDS = ("image", "video", "audio")


class MediaGeneration(TenantScopedModel):
    """One billable non-text generation."""

    __tablename__ = "media_generations"
    __table_args__ = (
        # Tenant-first like every index in this schema (ADR-0001): every query
        # here is already tenant-scoped, so any other prefix is the wrong one.
        Index("ix_media_generation_caller", "tenant_id", "caller_plugin"),
        Index("ix_media_generation_created", "tenant_id", "created_at"),
        # The chain join. A campaign's media spend is discovered through the
        # agent chain that produced it, not through a foreign key — see
        # ``causation_id`` below.
        Index("ix_media_generation_causation", "tenant_id", "causation_id"),
    )

    #: Which plugin requested this generation, as ``system:<plugin>``.
    #:
    #: Same semantics and the same caveat as ``AgentRun.caller_plugin``: it is
    #: sourced from the verified ``ServicePrincipal`` rather than the request
    #: body, and it records **who called** rather than which product the spend
    #: belongs to. Nullable for the same reason — there is no correct value to
    #: invent for a caller that is not a plugin.
    caller_plugin: Mapped[str | None] = mapped_column(String(128), nullable=True)

    #: Ties this asset to the agent chain that produced it, so campaign-level
    #: spend can be assembled across text and media without a foreign key
    #: between them. Matches ``AgentRun.causation_id`` in both name and width so
    #: the join is obvious; deliberately NOT a FK, because a generation can
    #: legitimately have no chain (a direct, operator-initiated render).
    causation_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    #: ``image`` / ``video`` / ``audio``. Not an enum column: adding a kind must
    #: not require a migration in every instance, and the set is validated at the
    #: write route where a bad value can be rejected with a useful message.
    media_kind: Mapped[str] = mapped_column(String(32), nullable=False)

    #: Who generated it and with what, e.g. ``openai`` / ``gpt-image-1``. Stored
    #: as free strings rather than a registry: a provider added tomorrow must not
    #: need a schema change to be billable.
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)

    #: How much was consumed, **in the provider's own unit**, and what that unit
    #: is called.
    #:
    #: Stored verbatim and normalised on read, mirroring what ``cost_usd``
    #: already does for text: record what actually happened, derive
    #: interpretations later. Providers disagree about the unit — per image, per
    #: second of video, per megapixel — and picking one canonical unit at write
    #: time bakes in a conversion that will be wrong for the next provider and
    #: cannot be undone, because the original number is gone.
    #:
    #: ``units`` is a Float, not an Integer: "3.5 seconds of video" is a real
    #: quantity, and rounding it at write time is the same irreversible loss.
    units: Mapped[float] = mapped_column(Float, nullable=False)
    unit_kind: Mapped[str] = mapped_column(String(32), nullable=False)

    #: Cost **at time of generation**, in USD.
    #:
    #: Nullable, and the null case is load-bearing rather than defensive: a
    #: provider that does not return a price leaves this ``None``, and that must
    #: stay distinguishable from a genuine zero. Any aggregate over this column
    #: must report the unpriced count beside the total — exactly as
    #: ``aggregate_run_costs`` already does for agent runs — or it silently
    #: reports a total over a denominator it never states.
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
