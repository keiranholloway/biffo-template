"""Admin endpoint: list and create organizations for the user-management "Company"
picker (see apps/portal/src/app/admin/users/page.tsx).

Organizations are a plain DB-owned table (not Cognito-backed, unlike users/groups)
so admins pick from — or add to — one consistent list instead of the same company
being spelled differently across users.
"""

from aws_lambda_powertools import Logger
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...database import get_db
from ...dependencies import require_admin
from ...middleware.auth import AuthenticatedUser
from ...models.organization import Organization
from ...schemas.organization import (
    CreateOrganizationRequest,
    OrganizationListResponse,
    OrganizationResponse,
)

logger = Logger()

router = APIRouter(prefix="/admin/organizations", tags=["admin"])


@router.get("", response_model=OrganizationListResponse)
async def list_organizations(
    admin: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> OrganizationListResponse:
    result = await db.execute(
        select(Organization)
        .where(Organization.tenant_id == admin.tenant_id)
        .order_by(Organization.name)
    )
    return OrganizationListResponse(
        organizations=[OrganizationResponse.model_validate(o) for o in result.scalars().all()]
    )


@router.post("", response_model=OrganizationResponse, status_code=status.HTTP_201_CREATED)
async def create_organization(
    body: CreateOrganizationRequest,
    admin: AuthenticatedUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    org = Organization(name=body.name, tenant_id=admin.tenant_id)
    db.add(org)
    await db.flush()
    await db.refresh(org)
    return OrganizationResponse.model_validate(org)
