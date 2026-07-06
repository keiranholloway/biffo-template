"""create orchestration tables

Revision ID: 0003
Revises: b2694068
Create Date: 2026-07-06

Domain state for the orchestration engine (Core-owned, ADR-0002): workflow
definitions (trigger->action rules), runs (idempotent per event), and the
action audit log. Chains off the current head (the rbac plugin migration).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "b2694068"
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
        "orchestration_workflow_definitions",
        *_base_columns(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("trigger_source", sa.String(128), nullable=False),
        sa.Column("trigger_detail_type", sa.String(128), nullable=False),
        sa.Column("trigger_filter", sa.JSON(), nullable=True),
        sa.Column("action_type", sa.String(64), nullable=False),
        sa.Column("action_config", sa.JSON(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_orchestration_workflow_definitions_tenant_id",
        "orchestration_workflow_definitions",
        ["tenant_id"],
    )
    op.create_index(
        "ix_orch_def_trigger",
        "orchestration_workflow_definitions",
        ["tenant_id", "trigger_source", "trigger_detail_type", "enabled"],
    )

    op.create_table(
        "orchestration_workflow_runs",
        *_base_columns(),
        sa.Column("definition_id", sa.String(36), nullable=False),
        sa.Column("dedupe_key", sa.String(255), nullable=False),
        sa.Column("trigger_event", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "dedupe_key", name="uq_orch_run_dedupe"),
    )
    op.create_index(
        "ix_orchestration_workflow_runs_tenant_id",
        "orchestration_workflow_runs",
        ["tenant_id"],
    )
    op.create_index(
        "ix_orch_run_definition",
        "orchestration_workflow_runs",
        ["tenant_id", "definition_id"],
    )

    op.create_table(
        "orchestration_action_logs",
        *_base_columns(),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("action_type", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("request", sa.JSON(), nullable=True),
        sa.Column("response", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_orchestration_action_logs_tenant_id",
        "orchestration_action_logs",
        ["tenant_id"],
    )
    op.create_index(
        "ix_orch_action_run",
        "orchestration_action_logs",
        ["tenant_id", "run_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_orch_action_run", table_name="orchestration_action_logs")
    op.drop_index(
        "ix_orchestration_action_logs_tenant_id",
        table_name="orchestration_action_logs",
    )
    op.drop_table("orchestration_action_logs")

    op.drop_index("ix_orch_run_definition", table_name="orchestration_workflow_runs")
    op.drop_index(
        "ix_orchestration_workflow_runs_tenant_id",
        table_name="orchestration_workflow_runs",
    )
    op.drop_table("orchestration_workflow_runs")

    op.drop_index(
        "ix_orch_def_trigger", table_name="orchestration_workflow_definitions"
    )
    op.drop_index(
        "ix_orchestration_workflow_definitions_tenant_id",
        table_name="orchestration_workflow_definitions",
    )
    op.drop_table("orchestration_workflow_definitions")
