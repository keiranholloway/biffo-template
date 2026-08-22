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

    ``definition_snapshot`` may carry an optional ``web_search`` key configuring
    OpenRouter's **provider-side** web plugin (issue #903):

    .. code-block:: json

        {"web_search": {"max_results": 8}}

    The runtime (``agent_runtime/openrouter.py``) translates a present, non-empty
    ``web_search`` dict into the request body's ``"plugins": [{"id": "web", ...}]``
    — OpenRouter bills ``max_results`` per result, so this is a cost lever as much
    as a quality one. A missing or empty ``web_search`` key produces a request
    with no ``plugins`` key at all, byte-identical to a snapshot that predates
    this field.

    This is **not** the tool-callable ``web_search`` a worker can declare in its
    ``tools`` list (``agent_runtime/search.py``, Brave-backed, gated on
    ``BRAVE_SEARCH_API_KEY``) — that is a tool the model chooses to invoke mid-run.
    ``web_search`` here is retrieval OpenRouter performs *before* the model
    answers, configured once for the whole request. The two share a name because
    each was named for what a definition author would call it, not because they
    are related; do not route one through the other.
    """

    agent_name: str = Field(min_length=1, max_length=200)
    definition_snapshot: dict[str, Any] = Field(default_factory=dict)
    input_payload: dict[str, Any] = Field(default_factory=dict)
    causation_id: str | None = Field(default=None, max_length=255)
    depth: int = Field(default=0, ge=0)
    workflow_run_id: str | None = Field(default=None, max_length=36)
    thread_id: str | None = Field(default=None, max_length=36)
    # Opt-in create-or-get (#661). A caller reached by at-least-once delivery
    # that can name this work deterministically passes a key; a second create
    # with the same key returns the first run and 200 instead of a second run,
    # a second invoice, and a discarded result.
    idempotency_key: str | None = Field(default=None, max_length=255)


class ThreadMessagesResponse(BaseModel):
    """A thread's assembled conversation — the ordered user/assistant messages
    across every run sharing ``thread_id`` (ADR-0016 §2). Read by a module driving
    an async run over a chat it held on the synchronous spine (e.g. the Ideation
    analyst), which builds from its ``input_payload`` and so needs the conversation
    handed to it."""

    thread_id: str
    messages: list[Any] = Field(default_factory=list)


class AgentRunResponse(BiffoBaseSchema):
    """A full run record — what the runtime reads before executing (§5)."""

    workflow_run_id: str | None = None
    # Exposed because dry runs are persisted (#726): without it the admin run
    # views cannot tell a preview from a run that really happened, and the two
    # look identical once terminal. Defaulted so a caller reading an older
    # response shape still parses.
    dry_run: bool = False
    # Exposed for the same reason as `dry_run` above: without it the mechanism
    # that prevents duplicate runs (#661) is invisible to the people who would
    # need it. A duplicate that was correctly collapsed and a run that simply
    # never had a twin look identical in every admin view, so an operator
    # investigating a double-bill cannot tell whether the guard engaged, and
    # cannot tell which chain a run belongs to when the key is the only thing
    # naming it. Defaulted so a caller reading an older response shape parses.
    idempotency_key: str | None = None
    # The PluginChatAgent row id and generation number that produced this run.
    # Together they identify which version of the agent's prompt produced this run.
    # Null for runs created before this field or whose instructions came inline
    # rather than from the registry. Defaulted for backward compat.
    prompt_version_id: str | None = None
    prompt_version: int | None = None
    #: Which plugin requested this run, as ``system:<plugin>``. See the model's
    #: column docstring for what it does and does not attribute — it records who
    #: POSTed, so orchestrator-created fan-in runs read ``system:orchestrator``
    #: rather than the plugin that started the chain. Defaulted so a caller
    #: reading an older response shape still parses.
    caller_plugin: str | None = None
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
    #: The runtime's `:online` grounding citations (issue #1528) — `None` for a
    #: run that predates the column or was never `:online`, `[]` for one that
    #: was and found nothing to cite. Defaulted so a caller reading an older
    #: response shape still parses.
    annotations: list[dict[str, Any]] | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class AgentRunSummary(BiffoBaseSchema):
    """A run as an admin list view shows it: enough to scan and triage, none of
    the heavy content.

    Deliberately omits ``messages``, ``result``, ``input_payload`` and
    ``definition_snapshot`` — the transcript and triggering payload are unbounded
    and potentially PII-adjacent, and returning them on a list would make it
    expensive and leak more than a scan needs. ``model`` is lifted out of the
    definition snapshot because it is the one snapshot field worth showing per
    row (it drives cost); it is ``None`` when the snapshot did not record one.
    Fetch the full record from the detail endpoint (``AgentRunResponse``).
    """

    agent_name: str
    status: str
    model: str | None = None
    #: Which plugin requested this run, as ``system:<plugin>``. See the column's
    #: docstring on the model for what it does and does not attribute — briefly,
    #: it records who POSTed, so orchestrator-created fan-in runs read
    #: ``system:orchestrator`` rather than the plugin that started the chain.
    caller_plugin: str | None = None
    # Same reason as on the full response: a persisted preview must be labellable
    # in the list, not just on the detail page (#726).
    dry_run: bool = False
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class AgentRunCostAggregate(BaseModel):
    """Per-model cost aggregation for an admin cost analysis view.

    Groups runs by model, summing costs and token counts. Runs with NULL
    cost_usd are counted separately in ``unpriced_runs`` and excluded from
    ``total_cost_usd``, so a caller can see how much of the time range is
    unpriced and correct for missing data when reporting.
    """

    model: str | None = None
    runs: int
    total_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    unpriced_runs: int


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
    #: The `:online` grounding citations the runtime collected across the run's
    #: turns (issue #1528). Optional and defaulted to `None` so a runtime build
    #: that predates this field still completes a run exactly as before —
    #: additive, not required.
    annotations: list[dict[str, Any]] | None = Field(default=None)
