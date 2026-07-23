"""Admin CRUD for prompt-library components (ADR-0015 §1, Phase 1).

Cognito-authenticated, admin-gated, tenant-scoped (ADR-0001/ADR-0004). This is
the authoring surface for the prompt library until the Phase-2 portal UI lands:
create/read/list/update/delete of ``PromptComponent``.

Hand-written rather than generic CRUD (ADR-0004), for the same reason the
workflow builder's CRUD is: ``variables`` needs structural validation and
``name`` needs a clean per-tenant uniqueness verdict (409), neither of which the
generic column-level layer provides — a uniqueness clash would otherwise surface
as a 500. Every query is scoped to the caller's verified ``tenant_id``: a
component in another tenant is a 404, never visible.

Deleting a component is allowed even while a definition still references it by
name: the reference is by name and only *resolves* at run-creation, where a
missing component aborts the run loudly (ADR-0015 §6). Blocking the delete would
require scanning every definition's parts on every delete; the fail-loud-at-run
posture is the ADR's choice.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...prompt_library import (
    DuplicateComponentNameError,
    create_component,
    delete_component,
    get_component,
    list_components,
    update_component,
)
from ...schemas.prompt_component import (
    CreatePromptComponentRequest,
    PromptComponentResponse,
    UpdatePromptComponentRequest,
)

router = APIRouter(prefix="/admin/prompt-components", tags=["admin"])


def _conflict(exc: DuplicateComponentNameError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Prompt component not found")


@router.get("", response_model=list[PromptComponentResponse])
async def list_prompt_components(
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[PromptComponentResponse]:
    components = await list_components(db, tenant_id=caller.tenant_id)
    return [PromptComponentResponse.model_validate(c) for c in components]


@router.post("", response_model=PromptComponentResponse, status_code=status.HTTP_201_CREATED)
async def create_prompt_component(
    body: CreatePromptComponentRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PromptComponentResponse:
    try:
        component = await create_component(
            db,
            tenant_id=caller.tenant_id,
            name=body.name,
            description=body.description,
            body=body.body,
            variables=body.variables,
        )
    except DuplicateComponentNameError as exc:
        raise _conflict(exc) from exc
    return PromptComponentResponse.model_validate(component)


@router.get("/{component_id}", response_model=PromptComponentResponse)
async def get_prompt_component(
    component_id: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PromptComponentResponse:
    component = await get_component(db, tenant_id=caller.tenant_id, component_id=component_id)
    if component is None:
        raise _not_found()
    return PromptComponentResponse.model_validate(component)


@router.put("/{component_id}", response_model=PromptComponentResponse)
async def update_prompt_component(
    component_id: str,
    body: UpdatePromptComponentRequest,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PromptComponentResponse:
    try:
        component = await update_component(
            db,
            tenant_id=caller.tenant_id,
            component_id=component_id,
            name=body.name,
            description=body.description,
            body=body.body,
            variables=body.variables,
        )
    except DuplicateComponentNameError as exc:
        raise _conflict(exc) from exc
    if component is None:
        raise _not_found()
    return PromptComponentResponse.model_validate(component)


@router.delete("/{component_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_prompt_component(
    component_id: str,
    caller: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    deleted = await delete_component(db, tenant_id=caller.tenant_id, component_id=component_id)
    if deleted is None:
        raise _not_found()
