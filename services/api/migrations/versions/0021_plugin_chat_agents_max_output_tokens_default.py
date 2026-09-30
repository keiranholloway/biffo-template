"""raise plugin_chat_agents.max_output_tokens server default to 4096

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-30

The 1024-token default silently truncated chat replies. 0008 already shipped
with ``server_default="1024"``, so the change is forward-migrated here rather
than editing 0008 in place (which would leave already-migrated databases
disagreeing with the migration source).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("plugin_chat_agents") as batch:
        batch.alter_column(
            "max_output_tokens",
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default="4096",
        )


def downgrade() -> None:
    with op.batch_alter_table("plugin_chat_agents") as batch:
        batch.alter_column(
            "max_output_tokens",
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default="1024",
        )
