"""Request/response schemas for the internal orchestration API (ADR-0009).

These back the service-only routes the orchestration engine calls; they are not
part of the user-facing API. The engine posts an event, gets back the runs it
should act on (already idempotently claimed), executes each action, and posts the
outcome.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator

from ..prompt_parts import PromptPartsError, normalize_parts
from ..scope_resolvers import registered_scope_levels
from ..writeback_targets import resolve_writeback_target
from .base import BiffoBaseSchema

# A schedule's delay, in seconds: >0 and capped at 1 year, so an author can't
# park a run indefinitely by mistake (docs/implementation/0002-scheduled-workflow-actions).
_MAX_SCHEDULE_DELAY_SECONDS = 365 * 24 * 60 * 60


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
    # Set when the claiming definition carries a schedule: the engine must
    # create an EventBridge Scheduler one-time schedule for this UTC instant
    # instead of executing now (docs/implementation/0002-scheduled-workflow-actions).
    scheduled_for: datetime | None = None


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
    scheduled_for: datetime | None = None


class FireScheduledRunResponse(BaseModel):
    """The result of the plugin's fire-time callback claiming a scheduled run.

    ``claimed=False`` means don't execute: the run already fired (a duplicate
    Scheduler delivery) or its definition was disabled/deleted since it was
    scheduled — the caller records ``status="skipped"`` and does nothing
    further. ``claimed=True`` carries the same shape ``ClaimedRun`` does for
    the immediate-dispatch path, so the engine executes it identically.
    """

    claimed: bool
    run_id: str
    definition_id: str | None = None
    action_type: str | None = None
    action_config: dict[str, Any] | None = None
    # The original triggering event's payload, stored on the run at claim
    # time — the fire-time callback has nothing but a run_id, potentially
    # weeks after the event arrived, and template rendering needs it.
    trigger_event: dict[str, Any] | None = None


# ── User-facing run history (portal admin) ───────────────────────────────────


class ActionLogEntry(BiffoBaseSchema):
    """One recorded action outcome for a run.

    ``request`` is deliberately **not** exposed: it echoes the action's config,
    which can carry a credential (a Google Chat webhook URL embeds its own
    token). The history view needs the outcome, not the request that produced it.
    """

    run_id: str
    action_type: str
    status: str
    response: dict[str, Any] | None = None
    error: str | None = None


class WorkflowRunSummary(BiffoBaseSchema):
    """A run as the portal's history view shows it: what fired, when, outcome.

    ``definition_name`` is null when the workflow has since been deleted — the
    run outlives the rule that caused it.
    """

    definition_id: str
    definition_name: str | None = None
    status: str
    trigger_event: dict[str, Any]
    logs: list[ActionLogEntry] = Field(default_factory=list)
    scheduled_for: datetime | None = None


# ── User-facing workflow-definition CRUD (portal admin builder) ──────────────
#
# Triggers come from the canonical event registry (``events/registry.py``, ADR-0010)
# — the single source of truth for what a trigger is, shared with the publishers
# that emit those events. Actions mirror the engine's action registry
# (services/_plugins/orchestrator/.../actions.py); extend WORKFLOW_ACTIONS to offer a new
# action in the UI.
#
# A config field may carry these optional keys beyond name/label/type/required:
#   ``default``      — value assumed when the field is absent from action_config.
#   ``visible_when`` — ``{"field": ..., "equals": ...}``; the field only applies
#                      when that sibling's effective value matches. A field that
#                      does not apply is neither shown by the portal nor
#                      required/format-checked here (see ``_field_applies``).
#   ``payload_template`` — ``True`` marks a field as eligible for ``{field}``
#                      templating from the triggering event's payload, filled
#                      by the orchestrator's ``_render`` at dispatch time. Set
#                      on both recipient/target fields (email/WhatsApp ``to``)
#                      and content fields (``subject``/``body``/``message``/
#                      ``template_params``) — `_render` already fills all of
#                      them identically; this flag only drives the portal's
#                      "insert field" picker (#609) and, for a field whose
#                      ``type`` is otherwise format-checked (``email``), skips
#                      that check when the value contains ``{``/``}`` so a
#                      literal address with no braces is unaffected — still
#                      format-checked as before.
#   ``secret``       — ``True`` marks the value a credential (#432). It is never
#                      returned in clear: reads (HTTP responses AND the state-change
#                      events emitted to the bus) redact a stored value to
#                      ``SECRET_SENTINEL``, and writes treat that sentinel as
#                      "keep what is stored" rather than overwriting the secret with
#                      the placeholder. Redaction and merge are the single points
#                      (``redact_secrets`` here, the router's write path) so a new
#                      read path cannot forget — the bug class this closes.
# ``type: "select"`` fields carry ``options`` (value/label pairs) and accept only
# those values — unless the field also sets ``open: True``, which makes the options
# a *suggestion list*: the portal offers them in a dropdown but any value is
# accepted (the agent action's ``model`` uses this, so an author is never locked
# out of a model that isn't among the curated slugs).
# ``type: "multiselect"`` is still a portal-only field type for other hypothetical
# pickers; Core never declares one, so no value validation for it lives here.
# ``type: "tools"`` (ADR-0014 §7, #569) is different: Core DOES declare this one,
#                   on the agent action, purely for authoring-time validation —
#                   see the field-level comment below and ``_validate_tools_field``.
#                   The portal still builds the picker's *options* from the
#                   router-injected ``available_tools`` (the runtime's live
#                   manifest), never from this field, which carries no ``options``.
# ``output_body`` — ``True`` marks the one field of a *destination* action that
#                   carries the human message (email → ``body``, the webhook
#                   channels → ``message``). It changes nothing for a standalone
#                   action, but when that action is reused as an agent-action
#                   *delivery* (ADR-0020) the field becomes optional and defaults
#                   to the ``{output}`` placeholder — so a delivery with no template
#                   sends the agent's raw result.
# ``type: "delivery"`` is the agent action's optional deliver-on-completion
#                   sub-config (ADR-0020, #527). Its value is a structured
#                   ``{"type": <destination>, "config": {…}}`` where ``type`` is one
#                   of ``DELIVERY_ACTION_TYPES`` and ``config`` is validated against
#                   that destination's own ``config_fields`` (reused, not
#                   duplicated). Absent ⇒ no delivery (today's behaviour). The
#                   orchestrator renders ``{output}`` — the agent's result — into the
#                   destination's ``output_body`` field on ``agent.run.completed``.
# ``type: "tools"`` is the agent action's declared tool list (ADR-0014 §7, #569).
#                   Its value is a list of runtime tool names, or — the one-text-
#                   input authoring shape — a comma-separated string; both are what
#                   ``agent_runtime.tools.declared_tools()`` accepts at run time, so
#                   this never rejects something the runtime would accept. Every
#                   name is checked against ``KNOWN_AGENT_TOOLS``, a reproduced
#                   mirror of the runtime's ``TOOL_REGISTRY`` (Core cannot import
#                   the runtime's Python, ADR-0002 — the same reason
#                   ``worker_messages.py`` reproduces the runtime's message-assembly
#                   constants instead of importing them). Absent/empty ⇒ no tools —
#                   §7's default-deny posture. This field is validation only; the
#                   portal's picker still gets its *options* from the router's live
#                   ``available_tools``, not from here.

# What a redacted secret reads back as. A fixed, recognisable placeholder rather
# than an empty string: the portal shows "set, unchanged", and a write echoing it
# back is understood as "keep the stored value" (see the router's merge). It must
# never be accepted as a real secret value, or a read could round-trip into a
# persisted "secret" that is actually the sentinel (rejected in ``_validate_action``
# and the router's create path).
SECRET_SENTINEL = "__biffo_secret_set__"  # noqa: S105 — not a credential; a redaction marker


WORKFLOW_ACTIONS: list[dict[str, Any]] = [
    {
        "type": "email",
        "label": "Send email",
        "config_fields": [
            {"name": "from", "label": "From", "type": "email", "required": True},
            {
                "name": "to",
                "label": "To",
                "type": "email",
                "required": True,
                # Recipient may be a literal address or a `{field}` template
                # filled from the triggering event's payload at dispatch time
                # (e.g. `{email}` to notify whoever just signed up) — see
                # `_render` in the orchestrator plugin.
                "payload_template": True,
            },
            {
                "name": "subject",
                "label": "Subject",
                "type": "text",
                "required": True,
                "payload_template": True,
            },
            # Whether `body` is plain text (escaped into the HTML part) or
            # already-authored HTML markup (sent through as-is; issue #1659).
            # See `send_email`'s docstring for the trust boundary this opts
            # into — `body_format: "html"` skips escaping `body`.
            {
                "name": "body_format",
                "label": "Body format",
                "type": "select",
                "required": False,
                "default": "text",
                "options": [
                    {"value": "text", "label": "Plain text"},
                    {"value": "html", "label": "HTML"},
                ],
            },
            {
                "name": "body",
                "label": "Body",
                "type": "textarea",
                "required": True,
                "output_body": True,
                "payload_template": True,
            },
        ],
    },
    {
        "type": "google_chat",
        "label": "Google Chat message",
        "config_fields": [
            # A Google Chat space's incoming-webhook URL; it embeds its own token.
            {
                "name": "webhook_url",
                "label": "Webhook URL",
                "type": "url",
                "required": True,
                # A Google Chat incoming-webhook URL embeds its own bearer token,
                # so the whole string is a credential (#432).
                "secret": True,
            },
            {
                "name": "message",
                "label": "Message",
                "type": "textarea",
                "required": True,
                "output_body": True,
                "payload_template": True,
            },
        ],
    },
    {
        "type": "slack",
        "label": "Slack message",
        "config_fields": [
            # A Slack incoming-webhook URL embeds its own secret token, so — like
            # the Google Chat webhook — the whole string is a credential (#432).
            {
                "name": "webhook_url",
                "label": "Webhook URL",
                "type": "url",
                "required": True,
                "secret": True,
            },
            {
                "name": "message",
                "label": "Message",
                "type": "textarea",
                "required": True,
                "output_body": True,
                "payload_template": True,
            },
        ],
    },
    {
        "type": "whatsapp",
        "label": "WhatsApp message",
        "config_fields": [
            # Account credentials live on the orchestrator, not here — only the
            # recipient and message are per-workflow.
            {
                "name": "to",
                "label": "To (phone, international format)",
                "type": "tel",
                "required": True,
                # Same `{field}` payload-templating as email's `to` (above).
                "payload_template": True,
            },
            # Text only delivers inside an open 24-hour customer service window;
            # proactive/business-initiated sends need an approved template.
            {
                "name": "message_type",
                "label": "Message type",
                "type": "select",
                "required": False,
                "default": "text",
                "options": [
                    {"value": "text", "label": "Text (reply, within 24h window)"},
                    {"value": "template", "label": "Template (proactive)"},
                ],
            },
            {
                "name": "message",
                "label": "Message",
                "type": "textarea",
                "required": True,
                "output_body": True,
                "payload_template": True,
                "visible_when": {"field": "message_type", "equals": "text"},
            },
            # The template must already exist and be approved in WhatsApp
            # Manager — this action cannot create one.
            {
                "name": "template_name",
                "label": "Template name (approved in WhatsApp Manager)",
                "type": "text",
                "required": True,
                "visible_when": {"field": "message_type", "equals": "template"},
            },
            {
                "name": "language_code",
                "label": "Language code",
                "type": "text",
                "required": True,
                "default": "en_US",
                "visible_when": {"field": "message_type", "equals": "template"},
            },
            {
                "name": "template_params",
                "label": "Body parameters, in order (comma-separated, {field} allowed)",
                "type": "text",
                "required": False,
                "payload_template": True,
                "visible_when": {"field": "message_type", "equals": "template"},
            },
        ],
    },
    {
        # The generic escape hatch every other action here is a fixed-shape
        # specialisation of (issue #1051) — including calling a deployment's
        # own internal API, which is what makes a periodic tick (#1044)
        # actually useful for anything beyond the notification channels
        # above. Always POSTs (orchestrator/actions.py's send_http).
        "type": "http",
        "label": "Call a webhook (HTTP POST)",
        "config_fields": [
            {
                "name": "url",
                # `{core_api_url}` is resolved by the action before any payload
                # templating, so a workflow can address this deployment's own
                # IAM-gated /api/v1/internal/* routes without naming a host —
                # which is what lets one seeded in a DDL module run unchanged
                # in dev, staging and production.
                "label": "URL ({core_api_url} resolves to this deployment's own API)",
                "type": "url",
                "required": True,
                "payload_template": True,
            },
            {
                # The whole field is treated as a credential (#432), the same
                # as the Slack/Google Chat webhook URL — this is where a
                # bearer token or API key lives for a generic endpoint.
                "name": "headers",
                "label": "Headers (comma-separated, Name: Value — {field} allowed)",
                "type": "text",
                "required": False,
                "secret": True,
            },
            {
                "name": "body",
                "label": "Body (JSON, {field} allowed — defaults to the trigger payload)",
                "type": "textarea",
                "required": False,
                "payload_template": True,
            },
        ],
    },
    {
        # ADR-0014 §4: binding an agentic worker to a trigger is a workflow
        # definition, not a new trigger surface. The action creates a run in
        # Core and returns; the runtime executes it off `agent.run.requested`.
        # The whole resolved config is snapshotted onto the run (§10), so every
        # field here is part of what explains a run after the fact.
        "type": "agent",
        "label": "Run an agent",
        "config_fields": [
            {"name": "agent_name", "label": "Agent name", "type": "text", "required": True},
            # instructions/goals accept EITHER a plain string (a single inline
            # part — the pre-library shape, unchanged) OR an ordered list of parts
            # for the prompt library (ADR-0015 §2): each part is
            # {"inline": "<text>"} or {"component": "<name>", "values": {…}}.
            # ``parts: True`` tells the validator (and the Phase-2 builder) to
            # treat the field as ordered parts rather than a plain textarea; the
            # string case still validates because a string is one inline part.
            # References are resolved to a final string Core-side at run-creation
            # (§4), so the runtime still reads a plain string from the snapshot.
            # Optional as of biffo-template#910: omitting it triggers registry resolution.
            {
                "name": "instructions",
                "label": "Instructions",
                "type": "textarea",
                "required": False,
                "parts": True,
            },
            # Optional acceptance criteria, folded into the system prompt after the
            # instructions by the runtime (ADR-0014). Also composable from parts.
            {
                "name": "goals",
                "label": (
                    "Goals — what does a good result look like? "
                    "(e.g. a confidence-rated verdict on each dimension you were asked to assess)"
                ),
                "type": "textarea",
                "required": False,
                "parts": True,
            },
            # Per-worker model choice, so alternatives can be compared without a
            # code change (§1). The value is an OpenRouter model slug.
            # The default is deliberately a low-cost model (#414). A defaulted
            # required field is silently satisfied by `_effective()` returning the
            # default, so leaving the field untouched runs whatever this default
            # names. It used to be `anthropic/claude-opus-4-8`, so an untouched
            # field ran — and billed — the priciest model; defaulting to a cheap
            # option instead means the do-nothing path is the frugal one, while an
            # author is still free to pick a costlier model explicitly.
            #
            # A curated `select` of tested slugs for discoverability — but ``open:
            # True`` marks the options a *suggestion list, not an allowlist*: the
            # value validator does not reject an off-list slug (see
            # ``_validate_action``). An author is free to run any OpenRouter model,
            # and — crucially — an agent stored with a model that predates this list
            # is never rejected on a later save, so editing it cannot silently drop
            # its model. Enforcement of what a run may actually use lives in the
            # runtime, not here.
            {
                "name": "model",
                "label": "Model",
                "type": "select",
                "required": True,
                "default": "moonshotai/kimi-k3",
                "open": True,
                "options": [
                    {"value": "moonshotai/kimi-k3", "label": "Kimi K3 (low-cost default)"},
                    {"value": "moonshotai/kimi-k3:online", "label": "Kimi K3 (web-connected)"},
                    {"value": "anthropic/claude-opus-4.8", "label": "Claude Opus 4.8 (premium)"},
                ],
            },
            # A hard stop on the turn loop — §8 bounds cost in the framework
            # rather than by convention. Read scope stays deliberately absent
            # (ADR-0014's third amendment, #569: no worker needs table reads yet,
            # so it is deferred rather than built speculatively). Tools, below,
            # gained an authoring path in the same change.
            {
                "name": "max_turns",
                "label": "Maximum turns",
                "type": "number",
                "required": False,
                "default": 1,
            },
            # A worker's declared tool list (ADR-0014 §7, #569) — an authoring-time-
            # validated path onto the runtime's already-working tools.py
            # (`declared_tools()`/`resolve_tools()`). Absent/empty is default-deny:
            # a worker uses no tools until it opts in. See the ``type: "tools"``
            # doc comment above for the validated shapes and KNOWN_AGENT_TOOLS below
            # for what "known" means.
            {
                "name": "tools",
                "label": "Tools",
                "type": "tools",
                "required": False,
                "default": [],
            },
            # ADR-0020 (#527): optional deliver-the-result-on-completion sub-config.
            # A structured {"type": <destination>, "config": {…}} validated against
            # the destination's own config_fields; absent ⇒ no delivery. The
            # orchestrator reacts to `agent.run.completed` for a *succeeded* run and
            # renders {output} into the destination's message. It is deliberately a
            # sub-config of the agent action rather than a second workflow step:
            # one workflow, one run, delivery as a property of the agent.
            {
                "name": "delivery",
                "label": "Deliver the result on completion",
                "type": "delivery",
                "required": False,
            },
            # The optional write-back sub-config (ADR-0027). Absent ⇒ the run's
            # result goes nowhere but the run itself, today's behaviour. Its value
            # is structured — ``{"table", "operation", "columns", "row_selector"?}``
            # — and validated against the *registered targets*, not against
            # anything declared here, because what is writeable is an instance's
            # decision in code and this catalog is the template's.
            {
                "name": "writeback",
                "label": "Record the result",
                "type": "writeback",
                "required": False,
            },
        ],
    },
    {
        # The join (#657). "Run an agent" fans out — N definitions on one trigger
        # start N runs in parallel — but nothing brought them back together: a
        # definition is one trigger to one action, so each of the N completions
        # fired the follow-on independently, N times.
        #
        # This action is triggered by `agent.run.completed` and no-ops until every
        # agent in `expect_agents` has a terminal run in the same causation chain
        # (ADR-0014 §8). The last completion to arrive finds the set complete and
        # starts `agent_name` with all their outputs in its `input_payload`.
        "type": "agent_fan_in",
        "label": "Run an agent once several agents have finished",
        "config_fields": [
            {
                "name": "expect_agents",
                "label": (
                    "Wait for these agents (comma-separated) — the runs whose "
                    "results this agent works from"
                ),
                "type": "text",
                "required": True,
            },
            {"name": "agent_name", "label": "Agent name", "type": "text", "required": True},
            {
                "name": "instructions",
                "label": "Instructions",
                "type": "textarea",
                "required": False,
                "parts": True,
            },
            {
                "name": "goals",
                "label": "Goals — what does a good result look like?",
                "type": "textarea",
                "required": False,
                "parts": True,
            },
            {
                "name": "model",
                "label": "Model",
                "type": "text",
                "required": False,
                "default": "moonshotai/kimi-k3",
            },
            {
                "name": "max_turns",
                "label": "Maximum turns",
                "type": "number",
                "required": False,
                "default": 1,
            },
            # The structured result contract (#729). A fan-in agent very often
            # exists to hand a *machine-readable* answer back to the plugin that
            # started the chain — a ranked list, a scorecard — and until this
            # field existed there was no way to say so: the only route to
            # ``output_tools`` was a write-back, which is Core deciding the shape
            # for a row Core writes, not the caller declaring its own contract.
            #
            # Its absence is not a hypothetical. A synthesis agent was seeded with
            # "call `submit_idea_candidates` exactly once, do not answer in prose"
            # and offered no such tool, so it answered in prose, the caller's
            # extractor rejected it, and the run failed after paying for the whole
            # fan-out (biffo-plugin-idea-scout#19).
            #
            # A write-back still WINS over this: ``apply_writeback_output_tool``
            # overrides ``output_tools`` when a write-back is configured, because
            # the shape of a row Core is about to write is Core's to state. The
            # two are usable together only in that order.
            {
                "name": "output_tools",
                "label": "Structured result — the tool this agent must call to answer",
                "type": "output_tools",
                "required": False,
            },
            {
                "name": "delivery",
                "label": "Deliver the result on completion",
                "type": "delivery",
                "required": False,
            },
            {
                "name": "writeback",
                "label": "Record the result",
                "type": "writeback",
                "required": False,
            },
        ],
    },
]

# The destinations an agent-action delivery may target (ADR-0020, #527). Each is a
# standalone action above whose executor the orchestrator reuses; a delivery's
# ``config`` is validated against that action's own ``config_fields``.
DELIVERY_ACTION_TYPES: tuple[str, ...] = ("email", "slack", "google_chat", "whatsapp")

# Tool names the agent runtime registers (ADR-0014 §7, #569) — a reproduced
# mirror of ``agent_runtime.tools.TOOL_REGISTRY``
# (``services/_plugins/agent-runtime/src/agent_runtime/tools.py``). Core cannot
# import the runtime's Python: it is a separately deployed unit reached over
# events/HTTP, never linked into Core's own Lambda (ADR-0002), the same
# boundary that already makes ``worker_messages.py`` reproduce the runtime's
# message-assembly constants instead of importing them. This list is the
# authoring-time mirror of that registry's keys; ``test_known_agent_tools_
# matches_the_runtime_manifest`` (test_orchestration_admin_router.py) is the
# same-repo drift guard — it cross-checks this against the runtime's
# ``biffo.plugin.json``, which the runtime's own ``test_manifest_tools.py`` in
# turn guarantees matches ``TOOL_REGISTRY`` exactly.
KNOWN_AGENT_TOOLS: frozenset[str] = frozenset({"web_search"})

# Deliberately permissive — enough to reject obvious typos in the form, not a
# full RFC 5322 validator (avoids a new email-validator dependency).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# A config field of type "url" must be an https URL (webhook endpoints always are;
# this also blocks http/SSRF-ish typos). Not a full URL validator.
_URL_RE = re.compile(r"^https://[^\s]+$")


def _effective(config_fields: list[dict[str, Any]], config: dict[str, Any], name: str) -> Any:
    """A field's value, falling back to its catalog ``default`` when unset.

    Definitions saved before a field existed carry no value for it, so the
    default is what conditional visibility must be judged against.
    """
    value = config.get(name)
    if value not in (None, ""):
        return value
    field = next((f for f in config_fields if f["name"] == name), None)
    return field.get("default") if field else None


def _field_applies(
    config_fields: list[dict[str, Any]], config: dict[str, Any], field: dict[str, Any]
) -> bool:
    """Whether a conditional field is in play for this config."""
    condition = field.get("visible_when")
    if condition is None:
        return True
    return _effective(config_fields, config, condition["field"]) == condition["equals"]


def _secret_field_names(action_type: str) -> set[str]:
    """Names of the ``secret: True`` config fields for an action (empty if none)."""
    action = next((a for a in WORKFLOW_ACTIONS if a["type"] == action_type), None)
    if action is None:
        return set()
    return {f["name"] for f in action["config_fields"] if f.get("secret")}


def redact_secrets(action_type: str, action_config: dict[str, Any]) -> dict[str, Any]:
    """A copy of ``action_config`` with every stored secret value masked (#432).

    The one place reads are made safe. Every path that turns a definition into a
    response or an event payload runs through here, so a webhook token never
    leaves the admin boundary in clear — not on the HTTP response, and not on the
    ``WORKFLOW_DEFINITION_*`` events, which carry the full row onto the bus to
    every subscriber, archive and replay (the wider surface #432 exists for).

    A secret with a non-empty stored value becomes ``SECRET_SENTINEL``; one that
    is absent or empty is left exactly as-is (absent stays absent), so the portal
    can tell "set" from "not set". Non-secret fields are untouched. The input is
    never mutated.

    An agent action's ``delivery`` sub-config is redacted recursively against its
    declared destination type (ADR-0020): a Slack or Google Chat webhook stored
    inside ``delivery.config`` is a credential too, and must not leak on a read or
    onto the bus any more than a top-level one.
    """
    secrets = _secret_field_names(action_type)
    result = {
        name: (
            SECRET_SENTINEL
            if name in secrets and isinstance(value, str) and value.strip()
            else value
        )
        for name, value in action_config.items()
    }
    delivery = result.get("delivery")
    if isinstance(delivery, dict) and isinstance(delivery.get("config"), dict):
        delivery_type = delivery.get("type")
        if delivery_type in DELIVERY_ACTION_TYPES:
            result["delivery"] = {
                **delivery,
                "config": redact_secrets(str(delivery_type), delivery["config"]),
            }
    return result


def resolve_write_secrets(
    action_type: str, submitted: dict[str, Any], stored: dict[str, Any]
) -> dict[str, Any]:
    """Resolve secret fields on a write, merging against what is stored (#432).

    The counterpart to :func:`redact_secrets`. A ``PUT`` replaces the whole
    ``action_config``, and the portal round-trips whatever a read gave it — so an
    unchanged save submits the sentinel, and a naive replace would write the
    placeholder over the real secret. Here, for each secret field: a submitted
    sentinel (or absence) keeps the stored value; a genuinely new value overwrites.

    Unified across create and update by the caller passing ``stored={}`` for a
    create: a sentinel then has nothing to keep and is rejected, which is exactly
    right — a create cannot "keep" a secret that was never stored, and the sentinel
    must never persist as a value. Raises ``ValueError`` in that case; the router
    maps it to 422. The input dicts are not mutated.

    An agent action's ``delivery`` sub-config is resolved recursively against its
    destination type (ADR-0020), so a webhook stored inside ``delivery.config`` is
    kept-on-unchanged the same way a top-level secret is. A delivery whose ``type``
    differs from what is stored has no stored secret to keep for the new type, so a
    sentinel there is refused — the author must supply the new destination's secret.
    """
    secrets = _secret_field_names(action_type)
    result = dict(submitted)
    for name in secrets:
        value = submitted.get(name)
        if value != SECRET_SENTINEL and value is not None:
            continue  # a real new value — overwrite as given
        kept = stored.get(name)
        if isinstance(kept, str) and kept.strip():
            result[name] = kept  # keep the stored secret unchanged
        elif value == SECRET_SENTINEL:
            # Sentinel submitted with nothing to fall back to: a create, or a
            # first-time secret on update. Refuse rather than persist the marker.
            raise ValueError(
                f"action_config.{name} is the redaction placeholder, but no secret "
                "is stored to keep — provide the actual value."
            )
        # value is None with nothing stored: leave absent. A required secret in
        # that state was already rejected by WorkflowDefinitionBody._validate_action.
    submitted_delivery = submitted.get("delivery")
    if isinstance(submitted_delivery, dict) and isinstance(submitted_delivery.get("config"), dict):
        delivery_type = submitted_delivery.get("type")
        if delivery_type in DELIVERY_ACTION_TYPES:
            stored_delivery = stored.get("delivery")
            stored_config: dict[str, Any] = {}
            if (
                isinstance(stored_delivery, dict)
                and stored_delivery.get("type") == delivery_type
                and isinstance(stored_delivery.get("config"), dict)
            ):
                stored_config = stored_delivery["config"]
            result["delivery"] = {
                **submitted_delivery,
                "config": resolve_write_secrets(
                    str(delivery_type), submitted_delivery["config"], stored_config
                ),
            }
    return result


def _validate_parts_field(
    action_type: str, action_config: dict[str, Any], field: dict[str, Any]
) -> None:
    """Validate an ordered-parts prompt field's shape (ADR-0015 §2).

    Accepts a plain string (one inline part) or a list of inline/component
    parts. A required field must resolve to at least one part — a component
    reference counts, so this passes even when the text lives entirely in the
    library; whether that component *exists* is a DB check the router runs.
    """
    name = field["name"]
    try:
        parts = normalize_parts(action_config.get(name), field=f"action_config.{name}")
    except PromptPartsError as exc:
        raise ValueError(str(exc)) from exc
    if field["required"] and not parts:
        raise ValueError(f"action_config.{name} is required for the {action_type} action")


def _validate_schedule_config(schedule: dict[str, Any] | None) -> None:
    """Validate an optional workflow ``schedule`` (docs/implementation/
    0002-scheduled-workflow-actions). ``None`` means "fire immediately" and is
    always valid — every existing definition predates this field.
    """
    if schedule is None:
        return
    if schedule.get("type") != "fixed_delay":
        raise ValueError(f"schedule.type must be 'fixed_delay', got: {schedule.get('type')!r}")
    delay_seconds = schedule.get("delay_seconds")
    if not isinstance(delay_seconds, int) or isinstance(delay_seconds, bool):
        raise ValueError("schedule.delay_seconds must be an integer")
    if delay_seconds <= 0:
        raise ValueError("schedule.delay_seconds must be positive")
    if delay_seconds > _MAX_SCHEDULE_DELAY_SECONDS:
        raise ValueError(
            f"schedule.delay_seconds must not exceed {_MAX_SCHEDULE_DELAY_SECONDS} (1 year)"
        )


def _validate_scope(scope: dict[str, Any] | None) -> None:
    """Validate an optional workflow ``scope`` (docs/implementation/
    0003-hierarchy-scoped-workflows). ``None`` means unscoped/tenant-wide and
    is always valid — every existing definition predates this field.

    Shape-only: ``level``/``id`` must be non-empty strings, and — when the
    instance has registered a resolver at all — ``level`` must be one of its
    declared levels. The template cannot go further than that: it has no way
    to know whether a given id is a real, existing brand/region/unit — that
    check belongs to the resolver-owning instance (Phase 2), not here.
    """
    if scope is None:
        return
    level = scope.get("level")
    scope_id = scope.get("id")
    if not isinstance(level, str) or not level:
        raise ValueError("scope.level must be a non-empty string")
    if not isinstance(scope_id, str) or not scope_id:
        raise ValueError("scope.id must be a non-empty string")
    known_levels = registered_scope_levels()
    if known_levels and level not in known_levels:
        raise ValueError(f"scope.level must be one of {known_levels}, got: {level!r}")


def _validate_action_config(
    action_type: str, action_config: dict[str, Any], *, body_optional: bool = False
) -> None:
    """Validate ``action_config`` against ``action_type``'s catalog config_fields.

    The single per-action validator, reused for a top-level workflow action and —
    with ``body_optional=True`` — for an agent-action *delivery* sub-config
    (ADR-0020). ``body_optional`` relaxes the ``required`` check on the destination's
    ``output_body`` field only: in a delivery it defaults to ``{output}`` (the agent's
    result), so the author need not supply a message. Raises ``ValueError`` on the
    first problem; the caller (a pydantic validator) surfaces it as a 422.
    """
    action = next((a for a in WORKFLOW_ACTIONS if a["type"] == action_type), None)
    if action is None:
        raise ValueError(f"Unknown action_type: {action_type}")

    config_fields = action["config_fields"]
    for field in config_fields:
        if not _field_applies(config_fields, action_config, field):
            continue
        # The agent action's optional deliver-on-completion sub-config (ADR-0020).
        if field["type"] == "delivery":
            _validate_delivery(action_config.get(field["name"]))
            continue
        # The agent action's optional write-back sub-config (ADR-0027).
        if field["type"] == "writeback":
            _validate_writeback(action_config.get(field["name"]))
            continue
        # The agent action's declared tool list (ADR-0014 §7, #569).
        if field["type"] == "tools":
            _validate_tools_field(action_config.get(field["name"]))
            continue
        # A fan-in agent's structured result contract (#729).
        if field["type"] == "output_tools":
            _validate_output_tools_field(action_config.get(field["name"]))
            continue
        # A prompt-library field (instructions/goals) is EITHER a plain string or an
        # ordered list of parts (ADR-0015 §2). Validate the shape here — component
        # existence and value/variable matching need the DB and are checked in the
        # router — then skip the plain-textarea checks below.
        if field.get("parts"):
            _validate_parts_field(action_type, action_config, field)
            continue
        value = action_config.get(field["name"])
        # A secret echoed back as the redaction sentinel means "keep the stored
        # value" (#432). The real value is resolved and checked in the router's write
        # path, against what is already stored — this validator cannot see that — so
        # accept the placeholder here. The router rejects a sentinel with nothing to
        # fall back to (a create, or a first-time secret on update).
        if field.get("secret") and value == SECRET_SENTINEL:
            continue
        if (
            field["type"] == "select"
            and not field.get("open")
            and isinstance(value, str)
            and value
            and value not in {o["value"] for o in field["options"]}
        ):
            raise ValueError(
                f"action_config.{field['name']} must be one of: "
                + ", ".join(o["value"] for o in field["options"])
            )
        # "Required" means the value must *resolve* to something — a field with a
        # catalog default therefore always satisfies it. An ``output_body`` field is
        # not required in a delivery: it defaults to the {output} placeholder.
        required = field["required"] and not (body_optional and field.get("output_body"))
        resolved = _effective(config_fields, action_config, field["name"])
        if required and not (isinstance(resolved, str) and resolved.strip()):
            raise ValueError(
                f"action_config.{field['name']} is required for the {action_type} action"
            )
        is_payload_template = (
            field.get("payload_template")
            and isinstance(value, str)
            and ("{" in value or "}" in value)
        )
        if (
            field["type"] == "email"
            and isinstance(value, str)
            and value
            and not is_payload_template
        ):
            if not _EMAIL_RE.match(value):
                raise ValueError(f"action_config.{field['name']} must be a valid email address")
        if field["type"] == "url" and isinstance(value, str) and value:
            if not _URL_RE.match(value):
                raise ValueError(f"action_config.{field['name']} must be an https URL")


def _validate_writeback(value: Any) -> None:
    """Validate an agent-action ``writeback`` sub-config (ADR-0027 §3, term 2).

    Absent/empty ⇒ no write-back, which is valid and is today's behaviour.
    Otherwise the declaration is checked against the **registered target** — the
    instance's in-code ceiling — so it can only ever narrow what that target
    permits, never widen it:

    - the table must be registered (an unregistered one is unknown, not "denied":
      the router turns that into a 404, ADR-0004 §4);
    - the operation must be one the target allows;
    - every named column must be in the target's allowlist, which is what stops
      an author reaching a column the ceiling never offered;
    - every column the target marks ``required`` must be mapped, so a run cannot
      produce a row the table would reject;
    - an ``update`` must name the target's declared row selector rather than
      inventing its own, since the row comes from the trigger event.

    Raises ``ValueError``; the caller surfaces it as a 422.
    """
    if value in (None, {}, ""):
        return
    if not isinstance(value, dict):
        raise ValueError("action_config.writeback must be an object")

    table = value.get("table")
    if not isinstance(table, str) or not table:
        raise ValueError("action_config.writeback.table is required")
    target = resolve_writeback_target(table)
    if target is None:
        raise ValueError(f"action_config.writeback.table {table!r} is not a write-back target")

    operation = value.get("operation") or "create"
    if operation not in target.operations:
        raise ValueError(
            f"action_config.writeback.operation must be one of: {', '.join(target.operations)}"
        )

    columns = value.get("columns")
    if not isinstance(columns, dict) or not columns:
        raise ValueError("action_config.writeback.columns must be a non-empty object")
    unknown = sorted(set(columns) - set(target.column_names))
    if unknown:
        raise ValueError(
            f"action_config.writeback.columns names column(s) {unknown} that {table!r} "
            f"does not allow an agent to write; allowed: {list(target.column_names)}"
        )
    missing = sorted(
        column.name for column in target.columns if column.required and column.name not in columns
    )
    if missing:
        raise ValueError(
            f"action_config.writeback.columns is missing required column(s) {missing} for {table!r}"
        )

    if operation == "update":
        selector = target.row_selector
        if selector is None:  # pragma: no cover — registration already refuses this
            raise ValueError(f"{table!r} allows update but declares no row selector")
        declared = value.get("row_selector")
        if declared not in (None, selector.payload_field):
            raise ValueError(
                "action_config.writeback.row_selector must be the target's declared "
                f"selector {selector.payload_field!r} — the row to update comes from the "
                "trigger event, not from the workflow"
            )


def _validate_delivery(value: Any) -> None:
    """Validate an agent-action ``delivery`` sub-config (ADR-0020, #527).

    Absent/empty ⇒ no delivery, which is valid (today's behaviour). Otherwise it
    must be ``{"type": <destination>, "config": {…}}`` with ``type`` one of
    :data:`DELIVERY_ACTION_TYPES` and ``config`` well-formed for that destination —
    reusing the destination's own ``config_fields`` (``body_optional``, since the
    message defaults to ``{output}``). Raises ``ValueError`` on any problem.
    """
    if value in (None, "", {}):
        return
    if not isinstance(value, dict):
        raise ValueError("action_config.delivery must be an object with 'type' and 'config'")
    delivery_type = value.get("type")
    if delivery_type not in DELIVERY_ACTION_TYPES:
        raise ValueError(
            "action_config.delivery.type must be one of: " + ", ".join(DELIVERY_ACTION_TYPES)
        )
    config = value.get("config")
    if not isinstance(config, dict):
        raise ValueError("action_config.delivery.config must be an object")
    try:
        _validate_action_config(str(delivery_type), config, body_optional=True)
    except ValueError as exc:
        raise ValueError(f"action_config.delivery.config is invalid: {exc}") from exc


#: Mirrors ``agent_runtime.tools._NAME_PATTERN`` — the runtime's rule for an
#: output tool's function name. Reproduced rather than imported for the same
#: reason as :data:`KNOWN_AGENT_TOOLS`: Core never links the runtime's Python.
_OUTPUT_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _validate_output_tools_field(value: Any) -> None:
    """Validate a fan-in agent's ``output_tools`` — the result contract it is
    told to call (#729).

    Absent/empty/``None`` ⇒ no output tool, which is valid: an agent that answers
    in prose is a legitimate workflow, and every workflow authored before this
    field existed is exactly that.

    The accepted shapes mirror ``agent_runtime.tools.output_tools`` /
    ``_coerce_output_tool``, so authoring-time validation never rejects something
    the runtime would happily run, and never accepts something it would reject
    mid-chain *after* the fan-out has already been paid for:

    - a single tool object, or a list of them;
    - each either the provider shape (``{"type": "function", "function": {…}}``)
      or the inner ``function`` object directly;
    - ``name`` lowercase alphanumeric with underscores, ``description`` non-empty,
      ``parameters`` a JSON Schema object;
    - no duplicate names.

    Why this exists at all: an agent whose instructions say "call
    ``submit_x`` exactly once, do not answer in prose" and which is offered no
    such tool cannot comply. It answers in prose, the caller's extractor rejects
    it, and the run fails at the last step having spent the most.
    """
    if value in (None, "", [], {}):
        return
    items = [value] if isinstance(value, dict) else value
    if not isinstance(items, (list, tuple)):
        raise ValueError(
            f"action_config.output_tools must be a tool schema or a list of them, got: {value!r}"
        )
    names: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError(f"action_config.output_tools entries must be objects, got: {item!r}")
        fn = item["function"] if isinstance(item.get("function"), dict) else item
        name = str(fn.get("name") or "").strip()
        if not _OUTPUT_TOOL_NAME_RE.match(name):
            raise ValueError(
                f"action_config.output_tools name {name!r} must be lowercase "
                "alphanumeric with underscores."
            )
        if not str(fn.get("description") or "").strip():
            raise ValueError(f"action_config.output_tools tool {name!r} has no description.")
        parameters = fn.get("parameters")
        if not isinstance(parameters, dict) or parameters.get("type") != "object":
            raise ValueError(
                f"action_config.output_tools tool {name!r} parameters must be a JSON Schema object."
            )
        names.append(name)
    duplicated = sorted({name for name in names if names.count(name) > 1})
    if duplicated:
        raise ValueError(f"action_config.output_tools declares {duplicated} more than once.")


def _validate_tools_field(value: Any) -> None:
    """Validate an agent action's ``tools`` list (ADR-0014 §7, #569).

    Absent/empty/``None`` ⇒ no tools, which is valid — the default-deny posture
    a worker opts out of by default. Otherwise the value must be a list of tool
    names, or a comma-separated string — the same two shapes
    ``agent_runtime.tools.declared_tools()`` accepts when it reads a run's
    definition snapshot at execution time, so authoring-time validation here
    never rejects something the runtime would happily run. Every resolved name
    must be in :data:`KNOWN_AGENT_TOOLS`, this module's reproduced mirror of the
    runtime's ``TOOL_REGISTRY`` — an unregistered name fails at save, matching
    the runtime's own ``UnknownToolError`` at run time, just earlier and for
    the same reason: a typo'd or stale tool name should fail loudly, not run
    quietly with one fewer capability.
    """
    if value in (None, "", []):
        return
    if isinstance(value, str):
        names = [item.strip() for item in value.split(",") if item.strip()]
    elif isinstance(value, list):
        names = [str(item).strip() for item in value if str(item).strip()]
    else:
        raise ValueError(f"action_config.tools must be a list of tool names, got: {value!r}")
    unknown = sorted(set(names) - KNOWN_AGENT_TOOLS)
    if unknown:
        raise ValueError(
            f"action_config.tools declares unregistered tool(s) {unknown}. "
            f"This build registers: {sorted(KNOWN_AGENT_TOOLS)}."
        )


class WorkflowCatalog(BaseModel):
    """What the builder offers: available triggers and actions (+ config fields)."""

    triggers: list[dict[str, Any]]
    actions: list[dict[str, Any]]
    # The active scope resolver's level names, broad-to-narrow (docs/implementation/
    # 0003-hierarchy-scoped-workflows) — empty when no resolver is registered, so a
    # generic instance's builder simply omits the scope picker rather than offering
    # a control with nothing to pick.
    scope_levels: list[str] = Field(default_factory=list)
    # The write-back targets the *calling user* may currently write to (ADR-0027).
    # Filtered per caller rather than listed wholesale: the picker must not offer
    # a table the author could not save against, and it must not disclose what
    # else this deployment lets other people write. Empty for an instance that
    # registers none — the builder simply omits the control.
    writeback_targets: list[dict[str, Any]] = Field(default_factory=list)


class WorkflowDefinitionResponse(BiffoBaseSchema):
    name: str
    trigger_source: str
    trigger_detail_type: str
    trigger_filter: dict[str, Any] | None = None
    action_type: str
    action_config: dict[str, Any]
    enabled: bool
    schedule_config: dict[str, Any] | None = None
    scope: dict[str, Any] | None = None
    # Whose authority this definition runs under (ADR-0027 §2). Read-only: it is
    # stamped from the authenticated caller on every save, never accepted from a
    # request body — which is why it appears here and not on
    # ``WorkflowDefinitionBody``. The UIs render it as "Runs as …".
    run_as_user_id: str | None = None
    run_as_kind: str = "system"


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
    # Optional all-of exact-match predicate over the event payload (#226): a
    # workflow on e.g. ``leads.updated`` with ``{"status": "won"}`` fires only when
    # the payload's ``status`` equals ``"won"``. None/empty → matches every event.
    trigger_filter: dict[str, Any] | None = None
    action_type: str = Field(min_length=1, max_length=64)
    action_config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    # Optional delay before the action fires (docs/implementation/
    # 0002-scheduled-workflow-actions): ``{"type": "fixed_delay", "delay_seconds": N}``.
    # None (default) -> fires immediately, today's unchanged behaviour.
    schedule_config: dict[str, Any] | None = None
    # Optional hierarchy scope (docs/implementation/0003-hierarchy-scoped-workflows):
    # ``{"level": <str>, "id": <str>}``. None (default) -> unscoped/tenant-wide,
    # today's unchanged behaviour.
    scope: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _validate_action(self) -> WorkflowDefinitionBody:
        _validate_action_config(self.action_type, self.action_config)
        _validate_schedule_config(self.schedule_config)
        _validate_scope(self.scope)
        return self


class CreateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class UpdateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class SetEnabledRequest(BaseModel):
    enabled: bool


# ── Plugin self-service seeding (issue #1593) ────────────────────────────────
#
# A service principal declaring its own workflow — see
# ``routers/internal_plugin_workflows.py``. Reuses ``WorkflowDefinitionBody``'s
# validation of action_config/schedule_config/scope verbatim, so a
# plugin-declared definition is held to exactly the same shape rules as one an
# admin builds by hand; the only addition is ``definition_key``, the plugin's
# own natural key for the row (this route's half of the upsert identity —
# ``owner_plugin``, the other half, is resolved from the verified
# ServicePrincipal and never accepted here, exactly as ``internal_plugin_config
# ._own_plugin_name`` does for plugin_chat_agents).


class SeedWorkflowDefinitionRequest(WorkflowDefinitionBody):
    """One workflow definition for a plugin to declare under its own identity."""

    definition_key: str = Field(pattern=r"^[a-z][a-z0-9-]*$", max_length=100)


class SeedWorkflowDefinitionResponse(BaseModel):
    """Result of seeding one definition — created, or updated in place."""

    definition_key: str
    definition_id: str
    created: bool
