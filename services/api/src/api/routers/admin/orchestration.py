"""Admin orchestration surface — the workflow dry-run (issue #527; async since #726).

``POST /api/v1/admin/orchestration/test`` — "Test workflow" in the builder: run a
draft agent action against a sample event and preview the output, causing
nothing downstream.

**It answers 202, not 200.** The preview is a real agent run, and a real agent
takes as long as it takes — a research agent legitimately runs for minutes, while
every API Gateway integration here is capped at 29s (an HTTP API, where 30s is a
hard AWS ceiling, not a raisable quota). So this queues the run and returns its
id; the caller polls ``GET /api/v1/admin/agent-runs/{run_id}`` for status and
output, a page the portal already has.

It therefore no longer touches the ``RuntimeInvoker`` synchronous seam at all —
the agent runtime picks the run up off ``agent.run.requested`` exactly as it does
for a real run, so there is no 503-when-unwired case to mirror from the chat
service any more, and nothing for a test to override on this module.

Admin-gated and tenant-scoped (ADR-0001). Kept under ``/admin/orchestration``
rather than on the user-facing ``/orchestration/workflows`` router: a preview is
not a definition CRUD verb, and hanging it off ``workflows/{id}`` would wrongly
imply a saved definition — the whole point is testing a draft before save.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...agent_dryrun_service import start_dry_run
from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...schemas.agent_dryrun import WorkflowDryRunAccepted, WorkflowDryRunRequest

logger = Logger()

router = APIRouter(prefix="/admin/orchestration", tags=["admin"])

__all__ = ["router"]


@router.post(
    "/test",
    response_model=WorkflowDryRunAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def test_workflow(
    body: WorkflowDryRunRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDryRunAccepted:
    """Queue a previewed agent run for a draft workflow; poll the run for output."""
    return await start_dry_run(db, tenant_id=caller.tenant_id, request=body)
