"""Guards for declared-event trigger fields (events/registry.py, #505).

Unlike a generic-CRUD event — whose fields are introspected from the model
(see test_event_fields.py) — a declared business event's payload is a hand-built
dict in whatever router emits it, so its ``EventField``s are hand-declared on the
``EventType``. The two can drift: a declared field the emitter never puts on the
bus makes the builder offer a condition that can *never* match, so the workflow
silently never fires.

These tests are that guard. ``_EMITTED_PAYLOAD_KEYS`` is the contract — the exact
keys each emitter publishes, mirrored from the emit call sites cited beside each
entry. Every declared field must be a subset of its event's emitted keys.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

from api.events.registry import (
    AGENT_RUN_COMPLETED,
    AGENT_RUN_REQUESTED,
    DEMO_REQUESTED,
    registered_events,
)

if TYPE_CHECKING:
    from api.models.agent_run import AgentRun

# The payload keys each declared event actually emits. Mirrors the emit sites:
#   demo.requested            → routers/demo_requests.py  (emit_event(... DEMO_REQUESTED))
#   lead.captured             → routers/marketplace.py    (emit_event(... LEAD_CAPTURED))
#   user.created              → identity/tabsii.py        (emit_event(... USER_CREATED))
#   user.suspended/…          → routers/admin/users.py    (_emit_user_lifecycle)
#   workflow_definition.*     → routers/orchestration.py  (_definition_payload → redacted response)
#   agent.run.requested/…     → routers/internal_agents.py (_reference_payload)
# Keep in sync when a payload changes — the subset test below is what enforces it.
_EMITTED_PAYLOAD_KEYS: dict[str, set[str]] = {
    "demo.requested": {"demo_request_id", "email", "company"},
    "lead.captured": {
        "lead_id",
        "brand_id",
        "brand_slug",
        "pipeline_stage_id",
        "source",
        "status",
    },
    "user.created": {"user_id", "cognito_sub", "email", "username"},
    "user.suspended": {"cognito_sub", "username", "email"},
    "user.reactivated": {"cognito_sub", "username", "email"},
    "user.deleted": {"cognito_sub", "username", "email"},
    # Redacted definition response: BiffoBaseSchema (id/tenant_id/created_at/
    # updated_at) + name/trigger_source/trigger_detail_type/trigger_filter/
    # action_type/action_config/enabled.
    "workflow_definition.created": {
        "id",
        "tenant_id",
        "created_at",
        "updated_at",
        "name",
        "trigger_source",
        "trigger_detail_type",
        "trigger_filter",
        "action_type",
        "action_config",
        "enabled",
    },
    "workflow_definition.updated": {
        "id",
        "tenant_id",
        "created_at",
        "updated_at",
        "name",
        "trigger_source",
        "trigger_detail_type",
        "trigger_filter",
        "action_type",
        "action_config",
        "enabled",
    },
    "workflow_definition.deleted": {
        "id",
        "tenant_id",
        "created_at",
        "updated_at",
        "name",
        "trigger_source",
        "trigger_detail_type",
        "trigger_filter",
        "action_type",
        "action_config",
        "enabled",
    },
    "agent.run.requested": {"run_id", "agent", "status", "causation_id", "depth"},
    "agent.run.completed": {"run_id", "agent", "status", "causation_id", "depth"},
}


def test_every_declared_field_is_well_formed():
    """Fields must have copy, and the enum contract must hold both ways."""
    for event in registered_events():
        for field in event.fields:
            assert field.name.strip(), f"{event.detail_type}: empty field name"
            assert field.label.strip(), f"{event.detail_type}:{field.name}: empty label"
            if field.type == "enum":
                assert field.values, (
                    f"{event.detail_type}:{field.name}: enum with no values gives an empty dropdown"
                )
            else:
                assert field.values == (), (
                    f"{event.detail_type}:{field.name}: only enum fields carry values"
                )


def test_declared_fields_are_a_subset_of_the_emitted_payload():
    """A field the emitter never publishes = a condition that can never match."""
    for event in registered_events():
        if not event.fields:
            continue
        expected = _EMITTED_PAYLOAD_KEYS.get(event.detail_type)
        assert expected is not None, (
            f"{event.detail_type} declares fields but has no emitted-payload contract in "
            f"_EMITTED_PAYLOAD_KEYS — add it (mirroring the emit site) so drift is guarded."
        )
        declared = {f.name for f in event.fields}
        assert declared <= expected, (
            f"{event.detail_type}: declared fields {declared - expected} are not in the "
            f"emitted payload {expected} — the builder would offer conditions that never match."
        )


def test_agent_run_contract_matches_the_real_reference_payload():
    """Self-check the curated agent-run keys against the actual emitter helper."""
    from api.routers.internal_agents import _reference_payload

    # _reference_payload only reads five attributes; duck-type them rather than
    # build a full ORM row.
    run = cast(
        "AgentRun",
        SimpleNamespace(
            id="run-1",
            agent_name="triage",
            status="completed",
            causation_id="demo.requested/d1",
            depth=0,
        ),
    )
    actual_keys = set(_reference_payload(run).keys())
    assert _EMITTED_PAYLOAD_KEYS["agent.run.requested"] == actual_keys
    assert _EMITTED_PAYLOAD_KEYS["agent.run.completed"] == actual_keys
    # And both events only declare fields that exist in that payload.
    for event in (AGENT_RUN_REQUESTED, AGENT_RUN_COMPLETED):
        assert {f.name for f in event.fields} <= actual_keys


def test_demo_requested_declares_its_full_payload():
    """The flagship builder example seeds a complete, usable sample."""
    assert {f.name for f in DEMO_REQUESTED.fields} == {
        "demo_request_id",
        "email",
        "company",
    }
