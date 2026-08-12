"""record the runtime's OpenRouter :online grounding citations on the agent run

Revision ID: 0018
Revises: 0017
Create Date: 2026-08-12

Issue #1528: `agent_runtime/openrouter.py` parsed `message.tool_calls` off an
OpenRouter completion but never read `message.annotations` — the field an
`:online` model call uses to return its grounding citations. The only way a
retrieved URL reached a plugin was if the model chose to retype it into a
structured tool call, so a run that paid for and received real search evidence
could still be reported, and billed, as having found nothing to cite.

This column is the second half of the fix (the first is
`agent_runtime.openrouter.LLMResponse.annotations`, threaded through the loop
into `RunOutcome`): the runtime now reports what it retrieved on its completion
POST, and this is where Core keeps it — a fact about the run, queryable
alongside `result`, rather than an inference a caller has to make from the
model's prose.

Nullable, and the NULL is deliberately not "empty" — following 0015's
`caller_plugin` precedent rather than `messages`/`result`'s NOT NULL default.
`NULL` means a run that predates this column, or one whose model was never
`:online`; a runtime old enough to not send the field lands here too. `[]`
means the runtime asked and the completion carried no citations — which is
precisely the state this issue exists to make visible, so it must read as
distinct from "we never checked". Never backfilled: there is no correct value
to invent for a run whose provider response is already gone.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("annotations", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_runs", "annotations")
