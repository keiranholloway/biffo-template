"""workflow definition run-as principal

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-27

Records whose authority a workflow definition's actions run under (ADR-0027 §2)
— the missing term in ADR-0014 §7's `ceiling ∩ declared scope ∩ the user's own
permissions`, since until now nothing knew who had scheduled a job.

Both columns are additive and nullable/defaulted, so existing definitions are
untouched: they keep `run_as_user_id NULL` and `run_as_kind 'system'`, which is
exactly the state that makes them unable to carry a write-back.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "orchestration_workflow_definitions",
        sa.Column("run_as_user_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "orchestration_workflow_definitions",
        sa.Column(
            "run_as_kind",
            sa.String(length=16),
            nullable=False,
            server_default="system",
        ),
    )


def downgrade() -> None:
    op.drop_column("orchestration_workflow_definitions", "run_as_kind")
    op.drop_column("orchestration_workflow_definitions", "run_as_user_id")
