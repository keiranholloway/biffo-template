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
# A config field may carry two optional keys beyond name/label/type/required:
#   ``default``      — value assumed when the field is absent from action_config.
#   ``visible_when`` — ``{"field": ..., "equals": ...}``; the field only applies
#                      when that sibling's effective value matches. A field that
#                      does not apply is neither shown by the portal nor
#                      required/format-checked here (see ``_field_applies``).
# ``type: "select"`` fields carry ``options`` (value/label pairs) and accept only
# those values.

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
            {
                "name": "instructions",
                "label": "Instructions",
                "type": "textarea",
                "required": True,
            },
            # Per-worker model choice, so alternatives can be compared without a
            # code change (§1). The value is an OpenRouter model slug.
            {
                "name": "model",
                "label": "Model",
                "type": "text",
                "required": True,
                "default": "anthropic/claude-opus-4-8",
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
            value = self.action_config.get(field["name"])
            if (
                field["type"] == "select"
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


class CreateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class UpdateWorkflowDefinitionRequest(WorkflowDefinitionBody):
    pass


class SetEnabledRequest(BaseModel):
    enabled: bool
