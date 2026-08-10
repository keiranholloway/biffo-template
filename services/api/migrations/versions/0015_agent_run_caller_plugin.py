"""record which plugin requested an agent run

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-10

`agent_runs` already carries everything needed to price a run — `input_tokens`,
`output_tokens`, and a `cost_usd` that is a genuine provider price snapshot
rather than a local rate-table calculation. What it does not carry is who asked.
A run records `agent_name` and an optional `workflow_run_id`, and neither
identifies the plugin that requested it, so "how much did tenant X spend via
plugin Y last month" has been unanswerable.

That question is the prerequisite for any credit or tiering scheme, and it is
useful to every plugin rather than to the one that prompted this.

Nullable, following 0013 rather than 0012: there is no correct value to backfill.
A run created before this column existed has no recorded caller, and NULL says
exactly that. A run requested by something that is not a plugin at all — a
workflow, an admin action — is also honestly NULL rather than forced into a
plugin-shaped answer.

## What this column does NOT tell you

It records **who POSTed the run**, sourced from the verified `ServicePrincipal`
rather than the request body, so a plugin cannot bill another one.

That is narrower than "which product this run belongs to". The orchestration
engine creates fan-in synthesis runs *on a plugin's behalf*, and those record
`system:orchestrator` — correctly, because the orchestrator is what called. So a
per-plugin spend total built on this column alone under-reports every plugin that
uses fan-out/fan-in, which today is the main agentic consumer. Attributing a
whole chain needs a `causation_id` join as well.

Recorded here, in the model docstring and in the schema, because the failure mode
is a number that looks complete and is not — which is worse than an absent one.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("caller_plugin", sa.String(length=128), nullable=True),
    )
    # Supports the aggregation this column exists for — spend grouped by caller
    # over a date range — without which that query table-scans every run the
    # tenant has ever made. Leads with tenant_id like every other index on this
    # table (ADR-0001): the query is always already tenant-scoped, so a
    # caller-first index would be the wrong prefix.
    op.create_index(
        "ix_agent_run_caller_plugin",
        "agent_runs",
        ["tenant_id", "caller_plugin"],
    )


def downgrade() -> None:
    op.drop_index("ix_agent_run_caller_plugin", table_name="agent_runs")
    op.drop_column("agent_runs", "caller_plugin")
