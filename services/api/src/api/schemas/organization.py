from pydantic import BaseModel, Field

from .base import BiffoBaseSchema


class OrganizationResponse(BiffoBaseSchema):
    name: str


class CreateOrganizationRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class OrganizationListResponse(BaseModel):
    organizations: list[OrganizationResponse]
