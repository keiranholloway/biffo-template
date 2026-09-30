"""create plugin chat agents table

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-26

The live, admin-editable chat agent registry for opted-in plugins (ADR-0017
seam #1 extension). A plugin declares ``chat_agents_dynamic: true`` in its
manifest to opt into this table; when an agent_key is not found in the static
registry (populate once at cold-start from the manifest), internal_agent_chat.py
falls back to a live DB lookup so an admin can add brand-new agent keys without
a redeploy — something the static _BUILDERS dict structurally cannot support.
Mutable in place like PromptComponent (ADR-0015 §3) — editing a row changes
behavior on the next turn.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
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
        "plugin_chat_agents",
        *_base_columns(),
        sa.Column("plugin_name", sa.String(100), nullable=False),
        sa.Column("agent_key", sa.String(100), nullable=False),
        sa.Column("agent_name", sa.String(200), nullable=False),
        sa.Column("role", sa.String(50), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("required_group", sa.String(100), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("max_history_messages", sa.Integer(), nullable=False, server_default="40"),
        sa.Column("max_output_tokens", sa.Integer(), nullable=False, server_default="1024"),
        sa.Column("timeout_seconds", sa.Float(), nullable=False, server_default="20.0"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id", "plugin_name", "agent_key", name="uq_plugin_chat_agent_key"
        ),
    )
    op.create_index("ix_plugin_chat_agents_tenant_id", "plugin_chat_agents", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_plugin_chat_agents_tenant_id", table_name="plugin_chat_agents")
    op.drop_table("plugin_chat_agents")
