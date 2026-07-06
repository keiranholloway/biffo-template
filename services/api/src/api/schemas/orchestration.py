"""Request/response schemas for the internal orchestration API (ADR-0009).

These back the service-only routes the orchestration engine calls; they are not
part of the user-facing API. The engine posts an event, gets back the runs it
should act on (already idempotently claimed), executes each action, and posts the
outcome.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

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
