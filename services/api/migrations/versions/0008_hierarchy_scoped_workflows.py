"""hierarchy-scoped workflows

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-26

Adds an optional hierarchy scope to a workflow definition (docs/
implementation/0003-hierarchy-scoped-workflows) — e.g. "this rule applies to
Brand X and everything beneath it," not just the exact trigger match.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "orchestration_workflow_definitions",
        sa.Column("scope", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("orchestration_workflow_definitions", "scope")
