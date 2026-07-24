"""Admin orchestration surface — the workflow dry-run (issue #527, Phase 2).

``POST /api/v1/admin/orchestration/test`` — "Test workflow" in the builder: run a
draft agent action against a sample event and preview the output, with **no side
effect** (no ``agent_run`` persisted, no event emitted, no downstream action).
This is the contract a later portal PR consumes.

Admin-gated and tenant-scoped (ADR-0001), a sibling admin surface to
``/admin/agent-chat``. It reuses that endpoint's Core->runtime synchronous invoke
seam (``RuntimeInvoker``, ADR-0016): ``_get_runtime_invoker`` is re-exported from
the shared chat service so it 503s identically when no runtime is wired, and so
tests override the invoke on this module the same way.

Kept under ``/admin/orchestration`` rather than on the user-facing
``/orchestration/workflows`` router: a preview is not a definition CRUD verb, it
carries no persisted resource, and hanging it off ``workflows/{id}`` would wrongly
imply a saved definition — the whole point is testing a draft before save.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ...agent_chat_service import _get_runtime_invoker
from ...agent_dryrun_service import run_dry_run
from ...chat_engine import RuntimeInvoker
from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...schemas.agent_dryrun import WorkflowDryRunRequest, WorkflowDryRunResponse

logger = Logger()

router = APIRouter(prefix="/admin/orchestration", tags=["admin"])

# Re-exported so tests override the invoke seam on this module (it is the same
# object the chat service and both chat routes use).
__all__ = ["_get_runtime_invoker", "router"]


@router.post("/test", response_model=WorkflowDryRunResponse)
async def test_workflow(
    body: WorkflowDryRunRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    invoker: RuntimeInvoker = Depends(_get_runtime_invoker),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDryRunResponse | JSONResponse:
    """Preview one agent turn for a draft workflow — no side effects."""
    return await run_dry_run(db, tenant_id=caller.tenant_id, request=body, invoker=invoker)
