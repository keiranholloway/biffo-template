"""plugin chat agent history and agent run prompt versioning

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-29

Stores the edit history of live-editable chat agents (plugin_chat_agents),
recording the previous values whenever an agent is updated so the full timeline
can be reconstructed. Each edit gets a monotonic version number per agent,
starting at 1, so admins have a stable label for each change.

Simultaneously adds a nullable prompt_version_id column to agent_runs, so
each run can record which PluginChatAgent row (prompt version) produced it
when the agent was resolved from the registry. Null for runs created before
this column or runs whose instructions came inline rather than from the
registry (ADR-0017 seam #1 extension M2).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Create the plugin_chat_agent_history table
    op.create_table(
        "plugin_chat_agent_history",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("plugin_chat_agent_id", sa.String(length=36), nullable=False),
        sa.Column("plugin_name", sa.String(length=100), nullable=False),
        sa.Column("agent_key", sa.String(length=100), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("agent_name", sa.String(length=200), nullable=False),
        sa.Column("role", sa.String(length=50), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("required_group", sa.String(length=100), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("max_history_messages", sa.Integer(), nullable=False),
        sa.Column("max_output_tokens", sa.Integer(), nullable=False),
        sa.Column("timeout_seconds", sa.Float(), nullable=False),
        sa.Column("changed_by", sa.String(length=255), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id",
            "plugin_chat_agent_id",
            "version",
            name="uq_plugin_chat_agent_history_agent_version",
        ),
    )
    op.create_index("ix_plugin_chat_agent_history_tenant_id", "plugin_chat_agent_history", ["tenant_id"], unique=False)
    op.create_index("ix_plugin_chat_agent_history_plugin_chat_agent_id", "plugin_chat_agent_history", ["plugin_chat_agent_id"], unique=False)

    # Add prompt_version_id to agent_runs
    op.add_column(
        "agent_runs",
        sa.Column("prompt_version_id", sa.String(length=36), nullable=True),
    )


def downgrade() -> None:
    # Remove prompt_version_id from agent_runs
    op.drop_column("agent_runs", "prompt_version_id")

    # Drop the plugin_chat_agent_history table
    op.drop_index("ix_plugin_chat_agent_history_plugin_chat_agent_id", table_name="plugin_chat_agent_history")
    op.drop_index("ix_plugin_chat_agent_history_tenant_id", table_name="plugin_chat_agent_history")
    op.drop_table("plugin_chat_agent_history")
