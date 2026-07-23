"""Request/response schemas for the prompt-component admin API (ADR-0015).

Cognito-authenticated, admin-gated, tenant-scoped. The ``variables`` declaration
is validated through the single source of truth in ``prompt_parts`` so the shape
a component stores is exactly the shape resolution reads.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator

from ..prompt_parts import PromptPartsError, validate_variable_declarations
from .base import BiffoBaseSchema


class PromptComponentBody(BaseModel):
    """Shared, validated body for create + update.

    ``variables`` is a list of ``{name, description?, required, default?}``.
    ``name`` must be a placeholder-safe identifier; the full rules live in
    ``prompt_parts.validate_variable_declarations`` and are enforced here so a
    malformed declaration is a 422 rather than something resolution trips over
    later. ``id``/``tenant_id`` are never accepted from the body.
    """

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    body: str = Field(min_length=1)
    variables: list[dict[str, Any]] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_variables(self) -> PromptComponentBody:
        try:
            self.variables = validate_variable_declarations(self.variables)
        except PromptPartsError as exc:
            raise ValueError(str(exc)) from exc
        return self


class CreatePromptComponentRequest(PromptComponentBody):
    pass


class UpdatePromptComponentRequest(PromptComponentBody):
    pass


class PromptComponentResponse(BiffoBaseSchema):
    name: str
    description: str | None = None
    body: str
    variables: list[dict[str, Any]]
