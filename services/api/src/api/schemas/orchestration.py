"""Request/response schemas for the internal orchestration API (ADR-0009).

These back the service-only routes the orchestration engine calls; they are not
part of the user-facing API. The engine posts an event, gets back the runs it
should act on (already idempotently claimed), executes each action, and posts the
outcome.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, model_validator

from .base import BiffoBaseSchema


class DispatchEventRequest(BaseModel):
    """An EventBridge event handed to the engine, forwarded to Core for matching.

    ``idempotency_key`` is a stable identifier for this event (e.g. the domain
    id in its payload). Core derives each run's dedupe key from it so a replayed
    event claims the same runs rather than firing actions twice.
    """

    source: str
    detail_type: str
    idempotency_key: str = Field(min_length=1)
    event: dict[str, Any] = Field(default_factory=dict)


class ClaimedRun(BaseModel):
    """A run the engine should execute (or skip, if already claimed)."""

    run_id: str
    definition_id: str
    action_type: str
    action_config: dict[str, Any]
    # False when this run was already claimed by a prior (possibly replayed)
    # delivery — the engine must not re-execute it.
    created: bool


class DispatchEventResponse(BaseModel):
    runs: list[ClaimedRun]


class RecordResultRequest(BaseModel):
    """The outcome of dispatching one run's action, recorded to the audit log."""

    action_type: str
    status: str = Field(pattern="^(succeeded|failed|skipped)$")
    request: dict[str, Any] | None = None
    response: dict[str, Any] | None = None
    error: str | None = None


class WorkflowRunResponse(BiffoBaseSchema):
    definition_id: str
    dedupe_key: str
    status: str
    trigger_event: dict[str, Any]


# ── User-facing workflow-definition CRUD (portal admin builder) ──────────────
#
# Triggers come from the canonical event registry (``events/registry.py``, ADR-0010)
# — the single source of truth for what a trigger is, shared with the publishers
# that emit those events. Actions mirror the engine's action registry
# (services/orchestrator/.../actions.py); extend WORKFLOW_ACTIONS to offer a new
# action in the UI.

WORKFLOW_ACTIONS: list[dict[str, Any]] = [
    {
        "type": "email",
        "label": "Send email",
        "config_fields": [
            {"name": "from", "label": "From", "type": "email", "required": True},
            {"name": "to", "label": "To", "type": "email", "required": True},
            {"name": "subject", "label": "Subject", "type": "text", "required": True},
            {"name": "body", "label": "Body", "type": "textarea", "required": True},
        ],
    },
]

# Deliberately permissive — enough to reject obvious typos in the form, not a
# full RFC 5322 validator (avoids a new email-validator dependency).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class WorkflowCatalog(BaseModel):
    """What the builder offers: available triggers and actions (+ config fields)."""

    triggers: list[dict[str, Any]]
    actions: list[dict[str, Any]]


class WorkflowDefinitionResponse(BiffoBaseSchema):
    name: str
    trigger_source: str
    trigger_detail_type: str
    action_type: str
    action_config: dict[str, Any]
    enabled: bool


class WorkflowDefinitionBody(BaseModel):
    """Shared, validated body for create + update.

    Validates the action against the catalog and the ``action_config`` shape
    against the chosen ``action_type`` (email → from/to/subject/body, with a basic
    email-format check). The **trigger** is validated in the router, which can
    check the tenant's observed events (registry ∪ observed, ADR-0010) — not just
    the in-memory registry. ``id``/``tenant_id`` are never accepted from the body.
    """

    name: str = Field(min_length=1, max_length=200)
    trigger_source: str = Field(min_length=1, max_length=128)
    trigger_detail_type: str = Field(min_length=1, max_length=128)
    action_type: str = Field(min_length=1, max_length=64)
    action_config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True

    @model_validator(mode="after")
    def _validate_action(self) -> WorkflowDefinitionBody:
        action = next(
            (a for a in WORKFLOW_ACTIONS if a["type"] == self.action_type), None
        )
        if action is None:
            raise ValueError(f"Unknown action_type: {self.action_type}")

        for field in action["config_fields"]:
            value = self.action_config.get(field["name"])
            if field["required"] and not (isinstance(value, str) and value.strip()):
                raise ValueError(
                    f"action_config.{field['name']} is required "
                    f"for the {self.action_type} action"
                )
            if (
                field["type"] == "email"
                and isinstance(value, str)
                and value
                and not _EMAIL_RE.match(value)
            ):
                raise ValueError(
                    f"action_config.{field['name']} must be a valid email address"
                )
        return self


class CreateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class UpdateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class SetEnabledRequest(BaseModel):
    enabled: bool
