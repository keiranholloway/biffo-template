"""add organizations table and user profile fields

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-26

The profile columns are added **only where a Core-owned `users` table exists**
(issue #670).

`users` is not universal. An instance may retire Core's `public.users` and model
its own — tabsii's are DDL-imported as `tabsii.users` (ADR-0005), created by no
migration at all. Against such a chain `batch_alter_table("users")` reflects and
raises `NoSuchTableError`, which took out four migration smoke tests and every
write-back executor test on the 0.127.0 -> 0.132.0 upgrade into tabsii-platform
(tabsii-platform#241). That instance had to *decline* this migration and re-point
its chain around it, which is a divergence that then has to be maintained for
ever.

The template cannot see this class of bug in its own CI, because the template
always has `public.users`. So the guard is not defensive coding — it is the only
way this migration can be honest about a table it does not own everywhere.

`organizations` is created unconditionally: it is Core's own table, it depends on
nothing instance-specific, and an instance that later adopts Core users should
find it already there.
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

    if not _has_core_users_table():
        # No Core-owned `users` to extend. `organizations` above still lands, so
        # an instance that later adopts Core users converges rather than forking.
        return

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
    if _has_core_users_table():
        _drop_user_profile_columns()

    op.drop_index("ix_organizations_name", table_name="organizations")
    op.drop_index("ix_organizations_tenant_id", table_name="organizations")
    op.drop_table("organizations")


def _has_core_users_table() -> bool:
    """Whether this instance has a Core-owned `users` table to extend.

    Inspected at run time against the live connection rather than assumed from
    the chain: whether `users` exists is a property of the database in front of
    us, and an instance may have created, dropped or never had it.

    Deliberately unqualified, matching what `batch_alter_table("users")` would
    itself reflect — the default search path. An instance whose users live in
    another schema (tabsii's `tabsii.users`) reads False here, which is correct:
    those are not Core's to alter.

    **What that correctness rests on (#764).** "The default search path" is not a
    property of this function; it is a property of the engine Alembic runs on.
    `migrations/env.py` passes **no** `connect_args` to `create_async_engine`,
    while the application engine in `api/database.py` passes
    `connect_args=_connect_args_for(settings.db_search_path)`. So the app sees the
    instance's schemas and migrations do not.

    That asymmetry was undocumented and untested until #764: give Alembic a search
    path and this guard silently starts returning True for an instance's own users
    table, and the migration below would `batch_alter_table` a table Core does not
    own. `test_alembic_engine_carries_no_search_path` now holds the invariant;
    `test_migration_0010_optional_users.py` cannot, because it runs on SQLite,
    which has no schemas.
    """
    return sa.inspect(op.get_bind()).has_table("users")


def _drop_user_profile_columns() -> None:
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
