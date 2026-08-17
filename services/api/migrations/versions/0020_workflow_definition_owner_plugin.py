"""workflow definition plugin ownership + natural key

Revision ID: 0020
Revises: 0019
Create Date: 2026-08-17

Issue #1593: a plugin cannot seed its own orchestration workflow today —
every ``WorkflowDefinition`` write lives on the Cognito-admin-gated
``orchestration.py``, and the closest service-principal analogue
(``internal_plugin_config.py``'s ``/seed``) is insert-only, so a plugin
that used it would freeze at first write exactly like the bug this closes.

``owner_plugin`` + ``definition_key`` give a plugin-declared definition a
stable natural key a service principal can upsert against
(``routers/internal_plugin_workflows.py``), scoped to ``owner_plugin`` so one
plugin can never touch another's rows and unique per
``(tenant_id, owner_plugin, definition_key)``.

Both columns are additive and nullable, so every existing definition (all of
them authored through the human ``orchestration.py`` CRUD) is untouched: it
keeps both NULL, which is also the state that keeps it permanently outside
this new upsert path — a plugin's seed only ever reads rows carrying its own
``owner_plugin``, never an admin-authored row.

A unique INDEX rather than a table CONSTRAINT, same reason as 0013/0016/0019:
Alembic cannot ALTER a constraint onto an existing table under SQLite ("No
support for ALTER of constraints in SQLite dialect"), which the db-init tests
exercise. Unlike 0019, no COALESCE is needed: 0019's nullable *first* column
(``caller_plugin``) still needed uniqueness enforced when NULL, whereas here
``definition_key`` is only ever set alongside ``owner_plugin`` — a row with
one NULL always has the other NULL too — so the plain composite index already
gives admin rows (NULL, NULL) no uniqueness constraint at all, which is
exactly what "never touched by this path" requires.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "orchestration_workflow_definitions",
        sa.Column("owner_plugin", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "orchestration_workflow_definitions",
        sa.Column("definition_key", sa.String(length=100), nullable=True),
    )
    op.create_index(
        "uq_orch_def_owner_key",
        "orchestration_workflow_definitions",
        ["tenant_id", "owner_plugin", "definition_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_orch_def_owner_key", table_name="orchestration_workflow_definitions")
    op.drop_column("orchestration_workflow_definitions", "definition_key")
    op.drop_column("orchestration_workflow_definitions", "owner_plugin")
