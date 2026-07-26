"""add organizations table and user profile fields

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-26

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "organizations",
        # Base columns (TenantScopedModel — ADR-0001)
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
        sa.Column("name", sa.String(255), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_organizations_tenant_id", "organizations", ["tenant_id"])
    op.create_index("ix_organizations_name", "organizations", ["name"])

    # Batch mode (rather than plain op.add_column + op.create_foreign_key)
    # because SQLite — used by the test suite — cannot ALTER TABLE ADD
    # CONSTRAINT at all; batch mode falls back to its copy-and-move strategy
    # there while still emitting a plain ALTER on Postgres.
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("organization_id", sa.String(36), nullable=True))
        batch_op.add_column(sa.Column("job_role", sa.String(128), nullable=True))
        batch_op.add_column(sa.Column("address_line1", sa.String(255), nullable=True))
        batch_op.add_column(sa.Column("address_line2", sa.String(255), nullable=True))
        batch_op.add_column(sa.Column("city", sa.String(128), nullable=True))
        batch_op.add_column(sa.Column("region", sa.String(128), nullable=True))
        batch_op.add_column(sa.Column("postal_code", sa.String(32), nullable=True))
        batch_op.add_column(sa.Column("country", sa.String(2), nullable=True))
        batch_op.create_index("ix_users_organization_id", ["organization_id"])
        batch_op.create_foreign_key(
            "fk_users_organization_id", "organizations", ["organization_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_constraint("fk_users_organization_id", type_="foreignkey")
        batch_op.drop_index("ix_users_organization_id")
        batch_op.drop_column("country")
        batch_op.drop_column("postal_code")
        batch_op.drop_column("region")
        batch_op.drop_column("city")
        batch_op.drop_column("address_line2")
        batch_op.drop_column("address_line1")
        batch_op.drop_column("job_role")
        batch_op.drop_column("organization_id")

    op.drop_index("ix_organizations_name", table_name="organizations")
    op.drop_index("ix_organizations_tenant_id", table_name="organizations")
    op.drop_table("organizations")
