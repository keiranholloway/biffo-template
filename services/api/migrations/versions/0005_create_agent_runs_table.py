"""create agent runs table

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-21

The durable record of one agentic worker invocation (ADR-0014). Core-owned
(ADR-0002): the runtime reaches it over the internal service API, never the
database. ``definition_snapshot`` captures the resolved definition each run
executed (§10) so a run stays explainable after its definition is edited.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _base_columns() -> list[sa.Column]:
    """The TenantScopedModel columns every table carries (ADR-0001)."""
    return [
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "agent_runs",
        *_base_columns(),
        sa.Column("workflow_run_id", sa.String(36), nullable=True),
        sa.Column("agent_name", sa.String(200), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("run_as_kind", sa.String(16), nullable=False, server_default="system"),
        sa.Column("run_as_user_id", sa.String(36), nullable=True),
        sa.Column("thread_id", sa.String(36), nullable=True),
        sa.Column("causation_id", sa.String(255), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("definition_snapshot", sa.JSON(), nullable=False),
        sa.Column("input_payload", sa.JSON(), nullable=False),
        sa.Column("messages", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_runs_tenant_id", "agent_runs", ["tenant_id"])
    op.create_index("ix_agent_run_agent", "agent_runs", ["tenant_id", "agent_name", "status"])
    op.create_index("ix_agent_run_thread", "agent_runs", ["tenant_id", "thread_id"])
    op.create_index("ix_agent_run_workflow", "agent_runs", ["tenant_id", "workflow_run_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_run_workflow", table_name="agent_runs")
    op.drop_index("ix_agent_run_thread", table_name="agent_runs")
    op.drop_index("ix_agent_run_agent", table_name="agent_runs")
    op.drop_index("ix_agent_runs_tenant_id", table_name="agent_runs")
    op.drop_table("agent_runs")
