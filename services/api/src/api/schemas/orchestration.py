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

from ..prompt_parts import PromptPartsError, normalize_parts
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


# ── User-facing workflow-definition CRUD (portal admin builder) ──────────────
#
# Triggers come from the canonical event registry (``events/registry.py``, ADR-0010)
# — the single source of truth for what a trigger is, shared with the publishers
# that emit those events. Actions mirror the engine's action registry
# (services/_plugins/orchestrator/.../actions.py); extend WORKFLOW_ACTIONS to offer a new
# action in the UI.
#
# A config field may carry three optional keys beyond name/label/type/required:
#   ``default``      — value assumed when the field is absent from action_config.
#   ``visible_when`` — ``{"field": ..., "equals": ...}``; the field only applies
#                      when that sibling's effective value matches. A field that
#                      does not apply is neither shown by the portal nor
#                      required/format-checked here (see ``_field_applies``).
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
# ``type: "multiselect"`` is a portal-only field type (the builder injects the agent
# action's tool picker from ``available_tools``); Core never declares one, so no
# value validation for it lives here.

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
            {"name": "to", "label": "To", "type": "email", "required": True},
            {"name": "subject", "label": "Subject", "type": "text", "required": True},
            {"name": "body", "label": "Body", "type": "textarea", "required": True},
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
                "visible_when": {"field": "message_type", "equals": "template"},
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
            {
                "name": "instructions",
                "label": "Instructions",
                "type": "textarea",
                "required": True,
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
                    {"value": "anthropic/claude-opus-4-8", "label": "Claude Opus 4.8 (premium)"},
                ],
            },
            # A hard stop on the turn loop — §8 bounds cost in the framework
            # rather than by convention. Tools and read scope are deliberately
            # absent in M1.
            {
                "name": "max_turns",
                "label": "Maximum turns",
                "type": "number",
                "required": False,
                "default": 1,
            },
        ],
    },
]

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
    """
    secrets = _secret_field_names(action_type)
    if not secrets:
        return dict(action_config)
    return {
        name: (
            SECRET_SENTINEL
            if name in secrets and isinstance(value, str) and value.strip()
            else value
        )
        for name, value in action_config.items()
    }


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
    """
    secrets = _secret_field_names(action_type)
    if not secrets:
        return dict(submitted)
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
    return result


class WorkflowCatalog(BaseModel):
    """What the builder offers: available triggers and actions (+ config fields)."""

    triggers: list[dict[str, Any]]
    actions: list[dict[str, Any]]


class WorkflowDefinitionResponse(BiffoBaseSchema):
    name: str
    trigger_source: str
    trigger_detail_type: str
    trigger_filter: dict[str, Any] | None = None
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
    # Optional all-of exact-match predicate over the event payload (#226): a
    # workflow on e.g. ``leads.updated`` with ``{"status": "won"}`` fires only when
    # the payload's ``status`` equals ``"won"``. None/empty → matches every event.
    trigger_filter: dict[str, Any] | None = None
    action_type: str = Field(min_length=1, max_length=64)
    action_config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True

    @model_validator(mode="after")
    def _validate_action(self) -> WorkflowDefinitionBody:
        action = next((a for a in WORKFLOW_ACTIONS if a["type"] == self.action_type), None)
        if action is None:
            raise ValueError(f"Unknown action_type: {self.action_type}")

        config_fields = action["config_fields"]
        for field in config_fields:
            if not _field_applies(config_fields, self.action_config, field):
                continue
            # A prompt-library field (instructions/goals) is EITHER a plain string
            # or an ordered list of parts (ADR-0015 §2). Validate the shape here —
            # component existence and value/variable matching need the DB and are
            # checked in the router — then skip the plain-textarea checks below.
            if field.get("parts"):
                self._validate_parts_field(field)
                continue
            value = self.action_config.get(field["name"])
            # A secret echoed back as the redaction sentinel means "keep the stored
            # value" (#432). The real value is resolved and checked in the router's
            # write path, against what is already stored — this body validator
            # cannot see that, and has no create/update context — so accept the
            # placeholder here rather than format-checking or rejecting it. The
            # router rejects a sentinel with nothing to fall back to (a create, or a
            # first-time secret on update).
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
            # "Required" means the value must *resolve* to something — a field
            # with a catalog default therefore always satisfies it.
            resolved = _effective(config_fields, self.action_config, field["name"])
            if field["required"] and not (isinstance(resolved, str) and resolved.strip()):
                raise ValueError(
                    f"action_config.{field['name']} is required for the {self.action_type} action"
                )
            if (
                field["type"] == "email"
                and isinstance(value, str)
                and value
                and not _EMAIL_RE.match(value)
            ):
                raise ValueError(f"action_config.{field['name']} must be a valid email address")
            if (
                field["type"] == "url"
                and isinstance(value, str)
                and value
                and not _URL_RE.match(value)
            ):
                raise ValueError(f"action_config.{field['name']} must be an https URL")
        return self

    def _validate_parts_field(self, field: dict[str, Any]) -> None:
        """Validate an ordered-parts prompt field's shape (ADR-0015 §2).

        Accepts a plain string (one inline part) or a list of inline/component
        parts. A required field must resolve to at least one part — a component
        reference counts, so this passes even when the text lives entirely in the
        library; whether that component *exists* is a DB check the router runs.
        """
        name = field["name"]
        try:
            parts = normalize_parts(self.action_config.get(name), field=f"action_config.{name}")
        except PromptPartsError as exc:
            raise ValueError(str(exc)) from exc
        if field["required"] and not parts:
            raise ValueError(f"action_config.{name} is required for the {self.action_type} action")


class CreateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class UpdateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class SetEnabledRequest(BaseModel):
    enabled: bool
