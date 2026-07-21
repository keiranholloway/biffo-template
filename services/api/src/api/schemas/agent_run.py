"""Request/response schemas for the internal agent-run API (ADR-0009 / ADR-0014).

These back the service-only routes the agent runtime calls; they are not part of
the user-facing API. The orchestrator requests a run, the runtime fetches it to
read the definition and input it must execute, then posts the outcome back.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from .base import BiffoBaseSchema


class CreateAgentRunRequest(BaseModel):
    """A request to run an agentic worker.

    ``definition_snapshot`` is the **resolved** definition the run will execute
    (instructions, model, tools, read scope, limits). It is captured verbatim so
    the run stays explainable after its definition is edited in place — nothing
    can backfill it later (ADR-0014 §10).

    ``causation_id``/``depth`` carry the §8 loop-prevention chain: a run created
    in reaction to another agent's completion increments ``depth``, and the
    create route refuses past the configured ceiling.
    """

    agent_name: str = Field(min_length=1, max_length=200)
    definition_snapshot: dict[str, Any] = Field(default_factory=dict)
    input_payload: dict[str, Any] = Field(default_factory=dict)
    causation_id: str | None = Field(default=None, max_length=255)
    depth: int = Field(default=0, ge=0)
    workflow_run_id: str | None = Field(default=None, max_length=36)
    thread_id: str | None = Field(default=None, max_length=36)


class AgentRunResponse(BiffoBaseSchema):
    """A full run record — what the runtime reads before executing (§5)."""

    workflow_run_id: str | None = None
    agent_name: str
    status: str
    run_as_kind: str
    run_as_user_id: str | None = None
    thread_id: str | None = None
    causation_id: str | None = None
    depth: int
    definition_snapshot: dict[str, Any]
    input_payload: dict[str, Any]
    messages: list[Any]
    result: dict[str, Any] | None = None
    error: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class CompleteAgentRunRequest(BaseModel):
    """The runtime's terminal report for one run.

    ``status`` is constrained to the two terminal states: a failure is reported
    the same way a success is, because a subscriber must be able to tell "failed"
    from "still running" (§5).
    """

    status: str = Field(pattern="^(completed|failed)$")
    messages: list[Any] | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)
