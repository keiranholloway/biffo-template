"""Request/response schemas for the workflow dry-run endpoint (issue #527, Phase 2).

The dry-run lets the workflow builder "Test workflow": given a **draft**
agent-action config and a **sample event**, it runs one agent turn and returns
the produced output for preview — with **no side effect** (no ``agent_run``
persisted, no event emitted, no downstream action). It is deliberately draft-first:
an inline config is accepted so a workflow can be tested *before* it is saved or
enabled, so there is no saved-definition id in the request.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class DryRunTrigger(BaseModel):
    """Optional trigger context for the preview (advisory only).

    Carried for parity with the workflow the builder is editing; the dry-run does
    not match or validate against it (sample generation and trigger matching are
    the portal's / engine's job). Present so a future preview could label which
    trigger the sample represents.
    """

    source: str | None = None
    detail_type: str | None = None


class WorkflowDryRunRequest(BaseModel):
    """A draft agent-action config plus a sample event to test it against.

    ``instructions``/``goals`` accept EITHER a plain string (a single inline part —
    the pre-library shape) OR an ordered list of prompt-library parts, exactly as a
    saved agent action's ``action_config`` does (ADR-0015 §2). They are resolved
    against the caller's prompt library at request time, so the preview matches
    what a real run would assemble.

    ``sample_event`` is whatever payload the builder wants to test against; the
    dry-run fences it as untrusted data (ADR-0014 §5) and never interprets it.
    Sample *generation* is the portal's job (#505) — this endpoint just runs it.
    """

    agent_name: str = Field(min_length=1, max_length=200)
    # str | list of parts; validated/resolved by the prompt library (a malformed
    # shape or a missing component surfaces as 422 from the service).
    instructions: str | list[dict[str, Any]]
    goals: str | list[dict[str, Any]] | None = None
    # Optional OpenRouter model slug; falls back to the platform default when unset.
    model: str | None = Field(default=None, max_length=200)
    # Accepted for parity with the agent action config, but NOT exercised: the
    # dry-run runs a single buffered turn only (MVP), so the tool loop that
    # max_turns would bound is not run. See agent_dryrun_service for the follow-up.
    max_turns: int | None = Field(default=None, ge=1)
    sample_event: dict[str, Any] = Field(default_factory=dict)
    trigger: DryRunTrigger | None = None


class WorkflowDryRunResponse(BaseModel):
    """The runtime's output for one previewed turn. No ids: nothing was persisted."""

    output: str
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    finish_reason: str | None = None
