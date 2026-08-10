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
    registered_events,
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

# The EXHAUSTIVE set of (source, detail_type) identities registry.py may declare
# (#848, class:boundary). Genericity is a judgement call, not something grep can
# check — so rather than pattern-matching for "looks domain-specific", this is a
# fixed allowlist of what the template declares TODAY. Extending it is a one-line,
# REVIEWED diff: that visibility is the whole guard. Before #848, ``lead.captured``
# sat here for weeks with no reviewer ever asked "is this platform-generic?" —
# widening a payload in place was easier than relocating it (see the note on
# "Canonical Core events" above), and nothing forced the question. A new franchising
# (or any other product-domain) event landing here now fails this test by
# construction; the fix is either "this genuinely is platform-generic, extend the
# set" or "this belongs in the instance's domains/<name>/ instead" (ADR-0022) — the
# same choice #848 made, just made BEFORE merge instead of months after.
_EXPECTED_TEMPLATE_EVENT_IDENTITIES = frozenset(
    {
        ("biffo.core", "demo.requested"),
        ("biffo.core", "user.created"),
        ("biffo.core", "user.suspended"),
        ("biffo.core", "user.reactivated"),
        ("biffo.core", "user.deleted"),
        ("biffo.core", "workflow_definition.created"),
        ("biffo.core", "workflow_definition.updated"),
        ("biffo.core", "workflow_definition.deleted"),
        ("biffo.core", "agent.run.requested"),
        ("biffo.core", "agent.run.completed"),
    }
)


def test_core_events_were_discovered():
    # Guard the guard: if this list were empty the assertions below pass vacuously.
    assert len(_CORE_EVENTS) >= 10


def test_template_registry_declares_only_the_reviewed_platform_events():
    """The boundary guard for #848's class (class:boundary).

    registry.py is a SHARED artifact — every instance and sibling scaffolded from
    this template inherits whatever it declares. ``lead.captured`` leaked in as a
    franchising concept because nothing asserted the registry's membership, only
    each event's shape (the tests above). This closes that gap: the declared set
    must equal the reviewed allowlist exactly, so a new event here is a decision,
    not a side effect of importing registry.py from wherever it was convenient to
    add one.
    """
    actual = {(e.source, e.detail_type) for e in _CORE_EVENTS}
    unreviewed = actual - _EXPECTED_TEMPLATE_EVENT_IDENTITIES
    missing = _EXPECTED_TEMPLATE_EVENT_IDENTITIES - actual
    assert actual == _EXPECTED_TEMPLATE_EVENT_IDENTITIES, (
        f"registry.py's declared events differ from the reviewed template set.\n"
        f"Unreviewed additions: {unreviewed or 'none'}. A product/domain concept "
        f"(a franchising 'lead', a retailer's 'order', ...) belongs in the "
        f"instance's own domains/<name>/ instead, registered at import time "
        f"(ADR-0022), not here. Once confirmed platform-generic, extend "
        f"_EXPECTED_TEMPLATE_EVENT_IDENTITIES.\n"
        f"Missing (removed without updating this set): {missing or 'none'}."
    )


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


def test_registered_events_covers_at_least_the_core_ones():
    """The widened guard below must never see FEWER events than the narrow one.

    ``_CORE_EVENTS`` is read out of ``vars(registry)`` — module constants, present
    the moment the module imports. ``registered_events()`` reads ``_REGISTRY``,
    which is populated by ``register_event`` calls as modules import. Those are
    different mechanisms, and if the second ever lags the first, the widened
    assertion would quietly cover less while looking broader.

    This is the anti-vacuity control for that specific direction: a superset
    check, not a count.
    """
    registered = {(e.source, e.detail_type) for e in registered_events()}
    core = {(e.source, e.detail_type) for e in _CORE_EVENTS}
    assert core <= registered, (
        f"registered_events() is missing core events declared in registry.py: {core - registered}. "
        f"The widened guard would be weaker than the narrow one."
    )


def test_every_registered_event_describes_its_payload():
    """The same property, over EVERY event in the registry — not just Core's (#694).

    ## Why the narrow version was not enough

    ``test_every_core_event_describes_its_payload`` iterates ``vars(registry)``,
    which by construction contains only the events *this file's own module*
    declares. That was a deliberate choice — the comment on ``_CORE_EVENTS`` says
    it is "independent of whatever else (plugins, instance modules) may have
    registered" — and it is the right scope for a test about Core's own events.

    But the property being asserted is not about Core. The trigger catalog the UI
    renders comes from ``registered_events()`` (``routers/orchestration.py``
    iterates it), so an event registered by a plugin or an instance domain reaches
    the same dropdown with no field metadata and nothing notices. #694 was filed
    believing no such guard existed at all; the guard existed, and its scope was
    narrower than its subject.

    ## Why it is currently equivalent, and why it is still worth having

    In the template nothing calls ``register_event`` outside ``events/registry.py``,
    so this set equals the core set today and the test passes trivially. It stops
    being trivial in two places:

    - **an instance**, which inherits ``services/api/tests/`` through
      ``core upgrade`` and registers its own domain events (ADR-0022);
    - **the template**, since #848 relocated ``LEAD_CAPTURED`` out of Core and
      into ``domains/tabsii/`` in the owning instance — this guard was put in
      place *before* that move, not after, precisely so the move could not
      silently regress the property.

    The ``FIELDLESS_EVENTS`` opt-out applies here too, keyed on ``detail_type``, so
    an instance event with genuinely no filterable payload has the same escape
    hatch Core events do.
    """
    for event in registered_events():
        has_metadata = event.payload_model is not None or bool(event.fields)
        opted_out = event.detail_type in FIELDLESS_EVENTS
        assert has_metadata or opted_out, (
            f"{event.source}/{event.detail_type} is in the event registry but declares "
            f"neither a payload_model nor explicit fields, so it reaches the trigger "
            f"catalog with nothing to filter on. Add a payload_model (preferred), or "
            f"list it in FIELDLESS_EVENTS if it genuinely has no filterable payload.\n"
            f"If this event is an INSTANCE's, both of those live in template-owned "
            f"files and the next core upgrade would revert your edit (#983): declare "
            f"the payload_model beside the event's own register_event() call, in the "
            f"instance domain module that raises it (ADR-0022)."
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
