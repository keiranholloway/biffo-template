"""give agent-run creation an idempotency key

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-28

`agent_fan_in` guards against firing its follow-on twice by checking, as late as
it can, whether a run for that agent already exists in the causation chain. That
is a check-then-act: two sibling completions landing within milliseconds both
list the chain, both see no follow-on, and both POST. Two runs, two invoices,
one join (issue #661).

Observed in production twice in one day. Once visibly — both duplicates stranded
in `pending` and the founder's scout hung (biffo-plugin-idea-scout#27). Once
invisibly — both completed, one result was discarded because the plugin records a
single run id, and the tenant was billed for both. The second is the common case
and the reason this needs fixing: it looks exactly like success.

Nullable rather than defaulted, unlike 0012's `dry_run`. There is no correct
value to backfill: a key is a claim by the caller that it can name this work
deterministically, and inventing one for existing rows would assert something
nobody checked. Postgres does not constrain NULLs in a UNIQUE, so unkeyed runs
stay unconstrained and only opt-in callers get the guarantee.

The constraint is on `(tenant_id, idempotency_key)`, not the key alone —
ADR-0001 tenancy applies here as everywhere, and two tenants must be able to use
the same natural key without colliding.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("idempotency_key", sa.String(length=255), nullable=True),
    )
    # A unique INDEX, not a unique CONSTRAINT. Alembic cannot ALTER a constraint
    # onto an existing table under SQLite ("No support for ALTER of constraints
    # in SQLite dialect"), which the db-init tests exercise. `CREATE UNIQUE
    # INDEX` is supported by both dialects and gives the same guarantee: a
    # duplicate raises IntegrityError, and NULLs stay unconstrained.
    op.create_index(
        "uq_agent_run_idempotency",
        "agent_runs",
        ["tenant_id", "idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_agent_run_idempotency", table_name="agent_runs")
    op.drop_column("agent_runs", "idempotency_key")
