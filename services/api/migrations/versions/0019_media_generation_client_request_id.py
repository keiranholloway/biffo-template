"""give media-generation recording an idempotency key

Revision ID: 0019
Revises: 0018
Create Date: 2026-08-12

A plugin that charges a provider and then fails to record the charge has no safe
retry today (issue #1515). Retrying the ledger POST either loses the record — if
the caller gives up — or writes a second row, if the original insert actually
landed and only the response was lost. The second is the dangerous one, because
it looks exactly like success and inflates every per-plugin spend total that
reads from this table.

`client_request_id` lets a caller name the write deterministically, so a repeat
POST returns the row already there instead of creating another. Same shape and
same reasoning as 0013 on `agent_runs`, and nullable for the same reason: there
is no correct value to backfill, and a key is a *claim* by the caller that it can
name this work — inventing one for existing rows would assert something nobody
checked.

## Why the index is on COALESCE(caller_plugin, ''), not caller_plugin

Issue #1515 suggests uniqueness per `(tenant_id, caller_plugin,
client_request_id)`. Scoping per caller is right — two plugins may legitimately
derive the same natural key, and handing one plugin's row to another would
misattribute a charge *and* silently lose the second one — but that literal
column list does not deliver it, because **`caller_plugin` is nullable**. Neither
Postgres nor SQLite constrains a row whose index tuple contains a NULL, so every
row written by a caller that resolves to no plugin (`logical_names` empty — a
contemplated state the column is deliberately nullable to represent honestly)
would be exempt from the constraint entirely. The guarantee would be absent for
exactly one class of caller, and absent silently.

Measured on both dialects before choosing, rather than assumed:

    plain (tenant_id, caller_plugin, client_request_id)
      multiple NULL keys permitted ........................ PASS
      duplicate key rejected when caller_plugin IS NULL ... FAIL  (sqlite AND postgres)
      two callers may share one key ....................... PASS

    (tenant_id, COALESCE(caller_plugin, ''), client_request_id)
      multiple NULL keys permitted ........................ PASS
      duplicate key rejected when caller_plugin IS NULL ... PASS
      two callers may share one key ....................... PASS

Folding NULL to `''` puts `caller_plugin` inside the constraint for every caller
while leaving `client_request_id`'s own NULL as the only thing that exempts a
row — which is the behaviour the optional key needs, since existing callers send
none and must keep writing as many rows as they post. That NULL exemption is
Postgres's default `NULLS DISTINCT` semantics, and the `A` line above is it being
verified rather than trusted; a partial `WHERE client_request_id IS NOT NULL`
would express the same thing and buy nothing but a dialect-specific clause.

A unique INDEX, not a unique CONSTRAINT, for the reason 0013 and 0016 both
record: Alembic cannot ALTER a constraint onto an existing table under SQLite
("No support for ALTER of constraints in SQLite dialect"), which the db-init
tests exercise. `CREATE UNIQUE INDEX` is supported by both dialects, supports an
expression, and gives the same guarantee — a duplicate raises IntegrityError.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Kept in one place so the migration, the model's ``__table_args__`` and the
#: create-or-get lookup cannot drift into disagreeing about what is unique.
_CALLER = "coalesce(caller_plugin, '')"


def upgrade() -> None:
    op.add_column(
        "media_generations",
        sa.Column("client_request_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "uq_media_generation_client_request",
        "media_generations",
        ["tenant_id", sa.text(_CALLER), "client_request_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_media_generation_client_request", table_name="media_generations")
    op.drop_column("media_generations", "client_request_id")
