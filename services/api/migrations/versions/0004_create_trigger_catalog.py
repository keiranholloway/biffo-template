"""create orchestration trigger catalog

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-07

The self-building half of the trigger catalog (ADR-0010): events observed at
dispatch are upserted here per tenant so the workflow builder can offer them as
triggers, alongside the events declared in the code registry.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
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
        "orchestration_trigger_catalog",
        *_base_columns(),
        sa.Column("source", sa.String(128), nullable=False),
        sa.Column("detail_type", sa.String(128), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id", "source", "detail_type", name="uq_orch_trigger_catalog"
        ),
    )
    op.create_index(
        "ix_orchestration_trigger_catalog_tenant_id",
        "orchestration_trigger_catalog",
        ["tenant_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_orchestration_trigger_catalog_tenant_id",
        table_name="orchestration_trigger_catalog",
    )
    op.drop_table("orchestration_trigger_catalog")
