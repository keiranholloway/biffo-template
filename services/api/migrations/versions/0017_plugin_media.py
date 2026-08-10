"""record what a plugin has stored

Revision ID: 0017
Revises: 0016
Create Date: 2026-08-10

Plugins had nowhere to put a file, and template Core had no S3 at all — no
client, no bucket, no grant. This table is the record half of the object-storage
capability (ADR-0021, #1437): one row per object Core has VERIFIED landed.

A row is written only after `head_object` confirms the bytes are there, with
`mime_type` and `size_bytes` read from S3 rather than accepted from the caller.
An upload the browser abandoned leaves an expired presigned URL and no row, so
the table describes what storage holds rather than what a client intended.

## The unique constraint is about retries, not collisions

`storage_key` already carries a uuid4, so two objects cannot collide. The
constraint on `(tenant_id, storage_key)` stops DOUBLE CONFIRMATION: a client
retrying a confirm after a timeout must not create a second row for one object,
or every per-plugin storage total counts it twice. A UNIQUE INDEX rather than an
ALTER-added constraint, per 0013 — Alembic cannot ALTER a constraint onto an
existing table under SQLite, which the db-init tests exercise.

`owner_plugin` is indexed because "what has this plugin stored" is the question
this table exists to answer, and it is asked per plugin.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plugin_media",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("owner_plugin", sa.String(length=128), nullable=False),
        sa.Column("storage_key", sa.String(length=1024), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_plugin_media_tenant_id", "plugin_media", ["tenant_id"])
    op.create_index("ix_plugin_media_owner", "plugin_media", ["tenant_id", "owner_plugin"])
    op.create_index(
        "uq_plugin_media_key", "plugin_media", ["tenant_id", "storage_key"], unique=True
    )


def downgrade() -> None:
    op.drop_index("uq_plugin_media_key", table_name="plugin_media")
    op.drop_index("ix_plugin_media_owner", table_name="plugin_media")
    op.drop_index("ix_plugin_media_tenant_id", table_name="plugin_media")
    op.drop_table("plugin_media")
