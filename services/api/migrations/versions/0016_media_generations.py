"""record what non-text generation cost

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-10

`agent_runs` prices text well — `cost_usd` is a real provider price snapshot, not
a rate-table calculation, so a later price change cannot rewrite history. This
table does the same job for the half `agent_runs` structurally cannot hold.

The agent runtime is text-only by construction: one chat-shaped client method,
string-only message content, and a completion contract accepting exactly
`status`/`messages`/`result`/`error`/`input_tokens`/`output_tokens`/`cost_usd`.

A generated image has no tokens. Routing its charge through `cost_usd` would make
it indistinguishable from an LLM charge AND would corrupt `aggregate_run_costs`,
which groups by `definition_snapshot["model"]` — a media charge with no model and
no tokens would land in the wrong bucket and inflate a per-model total readers
reasonably believe is about language models. Precedent: wall-clock duration hit
this same wall and was dropped to logs rather than persisted.

## Why now, before any pricing decision

Credits and tiering are a pricing decision and can wait. The ledger they bill
from cannot: a credit system introduced against an empty history has nothing to
bill from and no way to set a defensible default allowance. And a credit system
metering text but not media would bill the cheap half while giving away the
expensive half.

Enforcement is deliberately not in scope. Recording is.

## Units are stored verbatim

`units` + `unit_kind` record the provider's own quantity and what it called it,
normalised on read. Providers disagree — per image, per second, per megapixel —
and choosing one canonical unit at write time bakes in a conversion that will be
wrong for the next provider and cannot be undone, because the original number is
gone. `units` is a Float for the same reason: "3.5 seconds" is a real quantity
and rounding it at write time is the same irreversible loss.

`cost_usd` is nullable, and that null is load-bearing: a provider returning no
price must stay distinguishable from a genuine zero, or an aggregate silently
reports a total over a denominator it never states.

Three indexes, all tenant-first per ADR-0001, because every query here is already
tenant-scoped and any other prefix is the wrong one. Plain (non-unique) indexes,
so `op.create_index` is uncontroversial — note the constraint 0013 records:
Alembic cannot ALTER a CONSTRAINT onto an existing table under SQLite, which the
db-init tests exercise, so anything unique must be a CREATE UNIQUE INDEX.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "media_generations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("caller_plugin", sa.String(length=128), nullable=True),
        sa.Column("causation_id", sa.String(length=255), nullable=True),
        sa.Column("media_kind", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("units", sa.Float(), nullable=False),
        sa.Column("unit_kind", sa.String(length=32), nullable=False),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_media_generations_tenant_id", "media_generations", ["tenant_id"])
    op.create_index("ix_media_generation_caller", "media_generations", ["tenant_id", "caller_plugin"])
    op.create_index("ix_media_generation_created", "media_generations", ["tenant_id", "created_at"])
    op.create_index(
        "ix_media_generation_causation", "media_generations", ["tenant_id", "causation_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_media_generation_causation", table_name="media_generations")
    op.drop_index("ix_media_generation_created", table_name="media_generations")
    op.drop_index("ix_media_generation_caller", table_name="media_generations")
    op.drop_index("ix_media_generations_tenant_id", table_name="media_generations")
    op.drop_table("media_generations")
