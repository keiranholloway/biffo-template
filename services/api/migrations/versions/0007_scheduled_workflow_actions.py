"""scheduled workflow actions

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-26

Adds an optional delay to a workflow definition (docs/implementation/
0002-scheduled-workflow-actions) — a follow-up action that fires some time
after its trigger, e.g. an email 2 weeks after onboarding.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "orchestration_workflow_definitions",
        sa.Column("schedule_config", sa.JSON(), nullable=True),
    )
    op.add_column(
        "orchestration_workflow_runs",
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "orchestration_workflow_runs",
        sa.Column("schedule_name", sa.String(128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("orchestration_workflow_runs", "schedule_name")
    op.drop_column("orchestration_workflow_runs", "scheduled_for")
    op.drop_column("orchestration_workflow_definitions", "schedule_config")
