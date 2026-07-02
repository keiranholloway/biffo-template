"""create ddl_import_history table

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ddl_import_history",
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
        # DdlImportHistory-specific columns
        sa.Column("import_name", sa.String(128), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id",
            "import_name",
            "filename",
            name="uq_ddl_import_history_tenant_import_filename",
        ),
    )
    op.create_index(
        "ix_ddl_import_history_tenant_id", "ddl_import_history", ["tenant_id"]
    )
    op.create_index(
        "ix_ddl_import_history_import_name", "ddl_import_history", ["import_name"]
    )


def downgrade() -> None:
    op.drop_index("ix_ddl_import_history_import_name", table_name="ddl_import_history")
    op.drop_index("ix_ddl_import_history_tenant_id", table_name="ddl_import_history")
    op.drop_table("ddl_import_history")
