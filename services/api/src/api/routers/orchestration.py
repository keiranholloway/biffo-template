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

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..dependencies import require_admin
from ..events import emit_event
from ..events.registry import (
    WORKFLOW_DEFINITION_CREATED,
    WORKFLOW_DEFINITION_DELETED,
    WORKFLOW_DEFINITION_UPDATED,
    registered_events,
)
from ..middleware.auth import AuthenticatedUser
from ..models.orchestration import WorkflowDefinition
from ..permissions import get_permissions_registry
from ..orchestration import (
    create_definition,
    delete_definition,
    get_definition,
    is_known_trigger,
    list_definitions,
    list_observed_triggers,
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
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> WorkflowCatalog:
    """The triggers and actions the builder offers (drives the UI dropdowns).

    Triggers are every **declared** event (defined in code — a registered
    ``EventType`` or a generic-CRUD ``<table>.<op>`` from the permissions registry,
    ADR-0002/#222), unioned with any event this tenant has been **observed**
    dispatching that isn't declared (a compliance anomaly, ADR-0010). Actions are
    the engine's action registry.
    """
    triggers: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    # Declared business events (events/registry.py).
    for e in registered_events():
        triggers.append(
            {
                "source": e.source,
                "detail_type": e.detail_type,
                "label": e.label,
                "description": e.description,
                "origin": "declared",
            }
        )
        seen.add((e.source, e.detail_type))

    # Declared generic-CRUD events: <table>.<op> for every table+operation the
    # CRUD layer exposes (declared implicitly by __crud_permissions__). Every such
    # mutation emits (ADR-0002), so each is a valid trigger even before it fires.
    for table, block in get_permissions_registry().items():
        for op, verb in (
            ("create", "created"),
            ("update", "updated"),
            ("delete", "deleted"),
        ):
            if not getattr(block, op).allowed:
                continue
            key = ("biffo.core", f"{table}.{verb}")
            if key in seen:
                continue
            triggers.append(
                {
                    "source": "biffo.core",
                    "detail_type": f"{table}.{verb}",
                    "label": f"{table} {verb}",
                    "description": f"A {table} row was {verb}.",
                    "origin": "declared",
                }
            )
            seen.add(key)

    # Observed-but-undeclared events (should be empty under the compliance gate;
    # surfaced so an anomaly is visible rather than hidden).
    for observed in await list_observed_triggers(db, tenant_id=caller.tenant_id):
        key = (observed.source, observed.detail_type)
        if key in seen:
            continue
        triggers.append(
            {
                "source": observed.source,
                "detail_type": observed.detail_type,
                "label": observed.detail_type,
                "description": "Seen on the event bus.",
                "origin": "observed",
            }
        )
        seen.add(key)

    return WorkflowCatalog(triggers=triggers, actions=WORKFLOW_ACTIONS)


def _definition_payload(definition: WorkflowDefinition) -> dict[str, Any]:
    """Full-row, JSON-safe payload for a workflow-definition state-change event."""
    return WorkflowDefinitionResponse.model_validate(definition).model_dump(mode="json")


async def _require_known_trigger(
    db: AsyncSession, *, tenant_id: str, source: str, detail_type: str
) -> None:
    """422 unless the trigger is a declared or already-observed event."""
    if not await is_known_trigger(
        db, tenant_id=tenant_id, source=source, detail_type=detail_type
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown trigger: {source}/{detail_type}",
        )


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
    await _require_known_trigger(
        db,
        tenant_id=caller.tenant_id,
        source=body.trigger_source,
        detail_type=body.trigger_detail_type,
    )
    definition = await create_definition(
        db,
        tenant_id=caller.tenant_id,
        name=body.name,
        trigger_source=body.trigger_source,
        trigger_detail_type=body.trigger_detail_type,
        trigger_filter=body.trigger_filter,
        action_type=body.action_type,
        action_config=body.action_config,
        enabled=body.enabled,
    )
    emit_event(
        db,
        WORKFLOW_DEFINITION_CREATED,
        _definition_payload(definition),
        tenant_id=caller.tenant_id,
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
    await _require_known_trigger(
        db,
        tenant_id=caller.tenant_id,
        source=body.trigger_source,
        detail_type=body.trigger_detail_type,
    )
    definition = await update_definition(
        db,
        tenant_id=caller.tenant_id,
        definition_id=definition_id,
        name=body.name,
        trigger_source=body.trigger_source,
        trigger_detail_type=body.trigger_detail_type,
        trigger_filter=body.trigger_filter,
        action_type=body.action_type,
        action_config=body.action_config,
        enabled=body.enabled,
    )
    if definition is None:
        raise _not_found()
    emit_event(
        db,
        WORKFLOW_DEFINITION_UPDATED,
        _definition_payload(definition),
        tenant_id=caller.tenant_id,
    )
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
    # A toggle is a row update; the payload's ``enabled`` carries the new state.
    emit_event(
        db,
        WORKFLOW_DEFINITION_UPDATED,
        _definition_payload(definition),
        tenant_id=caller.tenant_id,
    )
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
    if deleted is None:
        raise _not_found()
    emit_event(
        db,
        WORKFLOW_DEFINITION_DELETED,
        _definition_payload(deleted),
        tenant_id=caller.tenant_id,
    )


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found"
    )
