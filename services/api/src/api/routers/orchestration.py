"""User-facing orchestration workflow-definition CRUD (the portal builder).

Cognito-authenticated, admin-gated, tenant-scoped (ADR-0001/ADR-0004). This is
the editing surface the orchestration domain deferred — distinct from the
engine's IAM-signed internal API (``routers/internal_orchestration.py``, ADR-0009)
and from the generic-CRUD layer: ``action_config`` needs shape validation per
``action_type``, and "toggle enabled" is a bespoke verb, so it is hand-written.

Served at ``/api/v1/orchestration/workflows`` (mounted in main.py). No Terraform
change is needed — the JWT ``$default`` API Gateway route covers it.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import require_admin
from ..events.registry import registered_events
from ..middleware.auth import AuthenticatedUser
from ..orchestration import (
    create_definition,
    delete_definition,
    get_definition,
    list_definitions,
    set_definition_enabled,
    update_definition,
)
from ..schemas.orchestration import (
    WORKFLOW_ACTIONS,
    CreateWorkflowDefinitionRequest,
    SetEnabledRequest,
    UpdateWorkflowDefinitionRequest,
    WorkflowCatalog,
    WorkflowDefinitionResponse,
)

router = APIRouter(prefix="/orchestration/workflows", tags=["orchestration"])


@router.get("/catalog", response_model=WorkflowCatalog)
async def get_catalog(
    _caller: AuthenticatedUser = Depends(require_admin),
) -> WorkflowCatalog:
    """The triggers and actions the builder offers (drives the UI dropdowns).

    Triggers are the declared platform events (``events/registry.py``); actions are
    the engine's action registry.
    """
    triggers = [
        {
            "source": e.source,
            "detail_type": e.detail_type,
            "label": e.label,
            "description": e.description,
        }
        for e in registered_events()
    ]
    return WorkflowCatalog(triggers=triggers, actions=WORKFLOW_ACTIONS)


@router.get("", response_model=list[WorkflowDefinitionResponse])
async def list_workflows(
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowDefinitionResponse]:
    definitions = await list_definitions(db, tenant_id=caller.tenant_id)
    return [WorkflowDefinitionResponse.model_validate(d) for d in definitions]


@router.post(
    "", response_model=WorkflowDefinitionResponse, status_code=status.HTTP_201_CREATED
)
async def create_workflow(
    body: CreateWorkflowDefinitionRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    definition = await create_definition(
        db,
        tenant_id=caller.tenant_id,
        name=body.name,
        trigger_source=body.trigger_source,
        trigger_detail_type=body.trigger_detail_type,
        action_type=body.action_type,
        action_config=body.action_config,
        enabled=body.enabled,
    )
    return WorkflowDefinitionResponse.model_validate(definition)


@router.get("/{definition_id}", response_model=WorkflowDefinitionResponse)
async def get_workflow(
    definition_id: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    definition = await get_definition(
        db, tenant_id=caller.tenant_id, definition_id=definition_id
    )
    if definition is None:
        raise _not_found()
    return WorkflowDefinitionResponse.model_validate(definition)


@router.put("/{definition_id}", response_model=WorkflowDefinitionResponse)
async def update_workflow(
    definition_id: str,
    body: UpdateWorkflowDefinitionRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    definition = await update_definition(
        db,
        tenant_id=caller.tenant_id,
        definition_id=definition_id,
        name=body.name,
        trigger_source=body.trigger_source,
        trigger_detail_type=body.trigger_detail_type,
        action_type=body.action_type,
        action_config=body.action_config,
        enabled=body.enabled,
    )
    if definition is None:
        raise _not_found()
    return WorkflowDefinitionResponse.model_validate(definition)


@router.post("/{definition_id}/enabled", response_model=WorkflowDefinitionResponse)
async def set_workflow_enabled(
    definition_id: str,
    body: SetEnabledRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> WorkflowDefinitionResponse:
    definition = await set_definition_enabled(
        db,
        tenant_id=caller.tenant_id,
        definition_id=definition_id,
        enabled=body.enabled,
    )
    if definition is None:
        raise _not_found()
    return WorkflowDefinitionResponse.model_validate(definition)


@router.delete("/{definition_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(
    definition_id: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    deleted = await delete_definition(
        db, tenant_id=caller.tenant_id, definition_id=definition_id
    )
    if not deleted:
        raise _not_found()


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found"
    )
