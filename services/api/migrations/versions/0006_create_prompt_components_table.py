"""create prompt components table

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-23

The prompt library's reusable, optionally-parameterised component (ADR-0015).
Core-owned (ADR-0002); tenant-scoped (ADR-0001). ``name`` is unique per tenant
because a definition references a component by name. Mutable in place with no
version table (§3) — the run snapshot is the history.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
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
        "prompt_components",
        *_base_columns(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("variables", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "name", name="uq_prompt_component_name"),
    )
    op.create_index("ix_prompt_components_tenant_id", "prompt_components", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_prompt_components_tenant_id", table_name="prompt_components")
    op.drop_table("prompt_components")
