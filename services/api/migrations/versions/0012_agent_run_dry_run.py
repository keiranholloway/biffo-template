"""mark an agent run as a dry run

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-27

The workflow dry-run becomes a real `agent_runs` row so it can outlive API
Gateway's 29s integration cap (issue #726). A dry run must execute exactly like
a real one and cause nothing, so it needs to be distinguishable *after* the
runtime has finished with it — which is when the completion event would
otherwise fire the write-back and any chained agent.

Additive, defaulted and NOT NULL, so every existing run reads `false`: a row
written before this column existed was, by construction, not a dry run.

The server default stays on the column deliberately. `create_run` always passes
the flag, but a run row can also be written by a migration or a fixture, and
`false` is the only safe reading of an unmarked run — a dry run that lost its
mark would silently execute side effects, while a real run that gained one would
silently stop.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("dry_run", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("agent_runs", "dry_run")
