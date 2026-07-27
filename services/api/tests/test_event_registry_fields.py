"""Guards for declared-event trigger fields (events/registry.py, #505).

A declared business event's builder fields (the "Only when…" dropdowns and the
seeded sample) are DERIVED from its ``payload_model`` — one Pydantic model per
event, the single source of truth shared with the emit site. These tests keep
that guarantee honest:

* **Completeness** — every core event declares a ``payload_model`` (or is a
  deliberate, listed exception). This is what stops the "add an event, forget to
  describe it" treadmill: a new event with neither is a red build, not a silent
  free-text degrade.
* **Well-formedness** — the derived fields have copy and a valid enum contract.
* **No drift** — each payload model matches what its emit site actually sends
  (self-checked against the real payload builders where they are pure).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import api.events.registry as registry
from api.events.registry import (
    AGENT_RUN_COMPLETED,
    AGENT_RUN_REQUESTED,
    DEMO_REQUESTED,
    AgentRunEventPayload,
    EventType,
    WorkflowDefinitionEventPayload,
)

if TYPE_CHECKING:
    from api.models.agent_run import AgentRun

# Core events that intentionally carry no filterable payload. Empty today — every
# shipped event has a payload_model. An event added with neither a payload_model
# nor an entry here fails test_every_core_event_describes_its_payload below.
FIELDLESS_EVENTS: frozenset[str] = frozenset()

# The EventType constants declared in registry.py, independent of whatever else
# (plugins, instance modules) may have registered globally in this test process.
_CORE_EVENTS = [v for v in vars(registry).values() if isinstance(v, EventType)]


def test_core_events_were_discovered():
    # Guard the guard: if this list were empty the assertions below pass vacuously.
    assert len(_CORE_EVENTS) >= 11


def test_every_core_event_describes_its_payload():
    """The treadmill-ender: no event may silently ship without field metadata."""
    for event in _CORE_EVENTS:
        has_metadata = event.payload_model is not None or bool(event.fields)
        opted_out = event.detail_type in FIELDLESS_EVENTS
        assert has_metadata or opted_out, (
            f"{event.detail_type} declares neither a payload_model nor explicit fields. "
            f"Add a payload_model (preferred), or list it in FIELDLESS_EVENTS if it "
            f"genuinely has no filterable payload."
        )


def test_derived_fields_are_well_formed():
    for event in _CORE_EVENTS:
        for field in event.payload_fields():
            assert field.name.strip(), f"{event.detail_type}: empty field name"
            assert field.label.strip(), f"{event.detail_type}:{field.name}: empty label"
            if field.type == "enum":
                assert field.values, f"{event.detail_type}:{field.name}: enum with no values"
            else:
                assert field.values == (), f"{event.detail_type}:{field.name}: values on non-enum"


def test_demo_requested_derives_its_full_payload():
    """The flagship builder example seeds a complete, usable sample."""
    assert {f.name for f in DEMO_REQUESTED.payload_fields()} == {
        "demo_request_id",
        "email",
        "company",
    }


def test_agent_run_payload_model_matches_the_real_reference_payload():
    """The model is the source for the fields; assert it still equals the emit site.

    Imports from ``api.agent_runs`` rather than the router: the builder moved
    there when the dry-run service became a second emitter of
    ``agent.run.requested`` (#726), so one shape now serves both emit sites.
    """
    from api.agent_runs import run_reference_payload

    # run_reference_payload only reads five attributes; duck-type them.
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
    assert set(run_reference_payload(run).keys()) == set(AgentRunEventPayload.model_fields)
    # Both agent-run events point at that model.
    for event in (AGENT_RUN_REQUESTED, AGENT_RUN_COMPLETED):
        assert event.payload_model is AgentRunEventPayload
    # status is enumerable → a value dropdown, not free text.
    status = next(f for f in AGENT_RUN_REQUESTED.payload_fields() if f.name == "status")
    assert status.type == "enum"
    assert status.values == ("pending", "running", "completed", "failed")


def test_workflow_definition_payload_is_a_subset_of_the_emitted_response():
    """The emit dumps the redacted WorkflowDefinitionResponse, so every field the
    event model declares must exist there — else a condition on it never matches."""
    from api.schemas.orchestration import WorkflowDefinitionResponse

    assert set(WorkflowDefinitionEventPayload.model_fields) <= set(
        WorkflowDefinitionResponse.model_fields
    )
    # id is auto-managed, so it is dropped from the derived builder fields.
    derived = {
        f.name
        for event in _CORE_EVENTS
        if event.payload_model is WorkflowDefinitionEventPayload
        for f in event.payload_fields()
    }
    assert derived == {"name", "trigger_source", "trigger_detail_type", "action_type", "enabled"}
