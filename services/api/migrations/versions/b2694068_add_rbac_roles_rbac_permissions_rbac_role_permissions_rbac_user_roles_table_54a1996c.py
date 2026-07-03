"""add_rbac_roles_rbac_permissions_rbac_role_permissions_rbac_user_roles_table_54a1996c

Revision ID: b2694068
Revises: 0002
Create Date: 2026-07-03 05:24:00.663

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b2694068"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Upgrade: create plugin tables."""
    op.create_table(
        "rbac_roles",
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("is_system", sa.Boolean()),
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "rbac_permissions",
        sa.Column("resource", sa.String(100), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("effect", sa.String(10)),
        sa.Column("description", sa.Text()),
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "rbac_role_permissions",
        sa.Column("role_id", sa.String(36), nullable=False),
        sa.Column("permission_id", sa.String(36), nullable=False),
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "rbac_user_roles",
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("role_id", sa.String(36), nullable=False),
        sa.Column("assigned_by", sa.String(36)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_rbac_roles_tenant_id", "rbac_roles", ["tenant_id"], unique=False
    )
    op.create_index(
        "idx_rbac_roles_tenant_name", "rbac_roles", ["tenant_id", "name"], unique=True
    )
    op.create_index(
        "ix_rbac_permissions_tenant_id", "rbac_permissions", ["tenant_id"], unique=False
    )
    op.create_index(
        "idx_rbac_permissions_tenant_resource_action",
        "rbac_permissions",
        ["tenant_id", "resource", "action"],
        unique=True,
    )
    op.create_index(
        "ix_rbac_role_permissions_role_id",
        "rbac_role_permissions",
        ["role_id"],
        unique=False,
    )
    op.create_index(
        "ix_rbac_role_permissions_permission_id",
        "rbac_role_permissions",
        ["permission_id"],
        unique=False,
    )
    op.create_index(
        "ix_rbac_role_permissions_tenant_id",
        "rbac_role_permissions",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        "idx_rbac_role_permissions_unique_pair",
        "rbac_role_permissions",
        ["role_id", "permission_id"],
        unique=True,
    )
    op.create_index(
        "ix_rbac_user_roles_user_id", "rbac_user_roles", ["user_id"], unique=False
    )
    op.create_index(
        "ix_rbac_user_roles_role_id", "rbac_user_roles", ["role_id"], unique=False
    )
    op.create_index(
        "ix_rbac_user_roles_tenant_id", "rbac_user_roles", ["tenant_id"], unique=False
    )
    op.create_index(
        "idx_rbac_user_roles_unique_pair",
        "rbac_user_roles",
        ["user_id", "role_id"],
        unique=True,
    )


def downgrade() -> None:
    """Downgrade: drop plugin tables."""
    op.drop_index("ix_rbac_roles_tenant_id", "rbac_roles")
    op.drop_index("idx_rbac_roles_tenant_name", "rbac_roles")
    op.drop_index("ix_rbac_permissions_tenant_id", "rbac_permissions")
    op.drop_index("idx_rbac_permissions_tenant_resource_action", "rbac_permissions")
    op.drop_index("ix_rbac_role_permissions_role_id", "rbac_role_permissions")
    op.drop_index("ix_rbac_role_permissions_permission_id", "rbac_role_permissions")
    op.drop_index("ix_rbac_role_permissions_tenant_id", "rbac_role_permissions")
    op.drop_index("idx_rbac_role_permissions_unique_pair", "rbac_role_permissions")
    op.drop_index("ix_rbac_user_roles_user_id", "rbac_user_roles")
    op.drop_index("ix_rbac_user_roles_role_id", "rbac_user_roles")
    op.drop_index("ix_rbac_user_roles_tenant_id", "rbac_user_roles")
    op.drop_index("idx_rbac_user_roles_unique_pair", "rbac_user_roles")
    op.drop_table("rbac_roles")
    op.drop_table("rbac_permissions")
    op.drop_table("rbac_role_permissions")
    op.drop_table("rbac_user_roles")
