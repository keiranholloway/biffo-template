"""Unit tests for the canonical event registry (events/registry.py, ADR-0010)."""

import dataclasses

import pytest
from api.events.registry import (
    AGENT_RUN_COMPLETED,
    AGENT_RUN_REQUESTED,
    DEMO_REQUESTED,
    LEAD_CAPTURED,
    EventType,
    find_event,
    register_event,
    registered_events,
)


@pytest.fixture(autouse=True)
def _pristine_event_registry():
    """Restore ``_REGISTRY`` around every test in this file (#694).

    Several tests here call ``register_event`` with synthetic identities —
    ``test.source/unit.registered``, ``test.source/dup.identity`` — and
    ``_REGISTRY`` is module-global, so those entries persisted for the rest of the
    pytest session. Nothing noticed while the only assertions over the registry
    were "is this specific event present".

    ``test_every_registered_event_describes_its_payload`` (#694) does assert a
    property of the WHOLE registry, and it failed in CI on exactly this leak:
    ``test.source/unit.registered`` declares no payload_model and no fields
    because it is a fixture, not an event — so a guard about real events was
    reporting a test artefact.

    Fixing the leak rather than teaching the guard to ignore ``test.source`` is
    deliberate: an allow-list would also hide a real instance event that shares the
    shape, and the leak is a latent order-dependence for every future assertion
    over this registry, not just this one. Same pattern and same reasoning as
    ``_pristine_scope_resolver_registry`` (#648 item 4).
    """
    from api.events import registry as reg

    saved = dict(reg._REGISTRY)  # noqa: SLF001
    yield
    reg._REGISTRY.clear()  # noqa: SLF001
    reg._REGISTRY.update(saved)  # noqa: SLF001


def test_core_events_are_registered():
    events = registered_events()
    assert DEMO_REQUESTED in events
    assert LEAD_CAPTURED in events
    # find_event resolves by identity
    assert find_event("biffo.core", "demo.requested") is DEMO_REQUESTED
    assert find_event("biffo.core", "lead.captured") is LEAD_CAPTURED


def test_agent_run_events_are_registered():
    """ADR-0014 §4/§5: both sides of a run are declared here, the one place."""
    assert find_event("biffo.core", "agent.run.requested") is AGENT_RUN_REQUESTED
    assert find_event("biffo.core", "agent.run.completed") is AGENT_RUN_COMPLETED
    assert AGENT_RUN_REQUESTED in registered_events()
    assert AGENT_RUN_COMPLETED in registered_events()


def test_find_event_unknown_returns_none():
    assert find_event("biffo.core", "does.not.exist") is None
    assert find_event("other.source", "demo.requested") is None


def test_build_produces_biffo_event_with_identity():
    event = DEMO_REQUESTED.build({"company": "Acme"}, tenant_id="t1")
    assert event.source == "biffo.core"
    assert event.detail_type == "demo.requested"
    assert event.tenant_id == "t1"
    assert event.payload == {"company": "Acme"}
    # round-trips through the EventBridge entry shape
    entry = event.to_eventbridge_entry("bus")
    assert entry["Source"] == "biffo.core"
    assert entry["DetailType"] == "demo.requested"


def test_register_event_returns_the_event_and_lists_it():
    ev = register_event(EventType("test.source", "unit.registered", "Unit registered", "desc"))
    assert ev.detail_type == "unit.registered"
    assert find_event("test.source", "unit.registered") is ev
    assert ev in registered_events()


def test_register_is_idempotent_last_wins_on_identity():
    first = register_event(EventType("test.source", "dup.identity", "First", "a"))
    before = len(registered_events())
    second = register_event(EventType("test.source", "dup.identity", "Second", "b"))
    after = len(registered_events())
    # same (source, detail_type) does not add a second entry; content is replaced
    assert after == before
    resolved = find_event("test.source", "dup.identity")
    assert resolved is not None
    assert resolved is second
    assert resolved.label == "Second"
    assert first not in registered_events()


def test_event_type_is_frozen():
    with pytest.raises(dataclasses.FrozenInstanceError):
        DEMO_REQUESTED.label = "mutated"  # type: ignore[misc]
