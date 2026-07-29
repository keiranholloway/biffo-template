"""Guards for the run-outcome observer seam (run_observers.py).

The seam exists so an instance can record what a workflow actually did against
its own domain rows, without the template learning any domain vocabulary. These
tests pin the three properties that make it safe to build on: observers see the
triggering payload, they run in the run's own transaction, and one that blows up
cannot take the run with it.
"""

from __future__ import annotations

import pytest
from api.run_observers import (
    RunOutcome,
    clear_run_outcome_observers,
    notify_run_outcome,
    register_run_outcome_observer,
    registered_run_outcome_observers,
)


@pytest.fixture(autouse=True)
def _isolate_registry():
    clear_run_outcome_observers()
    yield
    clear_run_outcome_observers()


def _outcome(**overrides):
    base = dict(
        run=object(),
        action_type="email",
        status="succeeded",
        # FLAT, because that is what dispatch_event stores and what the engine
        # reads back. This fixture used to wrap the fields in a "payload" key,
        # which nothing in the system produces — so every test here passed while
        # trigger_payload returned {} for every real run (tabsii-platform#301).
        # test_orchestration_service.py pins the shape against the producer
        # rather than against this literal.
        trigger_event={"lead_id": "lead-1", "email": "a@example.com"},
        request=None,
        response={"MessageId": "msg-1"},
        error=None,
    )
    base.update(overrides)
    return RunOutcome(**base)  # type: ignore[arg-type]


def test_trigger_payload_is_the_event_the_run_stored():
    """The fields sit at the top level; an observer reads them directly."""
    assert _outcome().trigger_payload == {"lead_id": "lead-1", "email": "a@example.com"}


def test_trigger_payload_still_unwraps_a_genuine_envelope():
    """Kept so an instance that really does post an envelope keeps working."""
    wrapped = _outcome(trigger_event={"payload": {"lead_id": "lead-9"}})
    assert wrapped.trigger_payload == {"lead_id": "lead-9"}


@pytest.mark.parametrize("event", [{"payload": None}, {"payload": "not-a-dict"}])
def test_a_payload_key_that_is_not_a_dict_does_not_swallow_the_event(event):
    """The regression itself: a non-dict ``payload`` must not yield ``{}``.

    Returning {} here is what made the seam look like it worked. An event whose
    own contract happens to include a ``payload`` field is still an event, and
    the observer must see it rather than an empty dict it cannot distinguish
    from "this event carried nothing".
    """
    assert _outcome(trigger_event=event).trigger_payload == event


def test_trigger_payload_is_empty_only_when_the_event_is():
    assert _outcome(trigger_event={}).trigger_payload == {}


def test_succeeded_reflects_the_run_status():
    assert _outcome(status="succeeded").succeeded is True
    assert _outcome(status="failed").succeeded is False


@pytest.mark.asyncio
async def test_observers_are_called_in_registration_order():
    seen: list[str] = []

    register_run_outcome_observer(lambda ctx, db: seen.append("first"))

    @register_run_outcome_observer
    async def _second(ctx, db):
        seen.append("second")

    assert len(registered_run_outcome_observers()) == 2

    await notify_run_outcome(_outcome(), db=object())  # type: ignore[arg-type]
    assert seen == ["first", "second"]


@pytest.mark.asyncio
async def test_an_observer_receives_the_outcome_and_the_session():
    captured: dict[str, object] = {}
    session = object()

    @register_run_outcome_observer
    async def _observer(ctx: RunOutcome, db) -> None:
        captured["lead_id"] = ctx.trigger_payload["lead_id"]
        captured["action_type"] = ctx.action_type
        captured["response"] = ctx.response
        captured["db"] = db

    await notify_run_outcome(_outcome(), db=session)  # type: ignore[arg-type]

    assert captured["lead_id"] == "lead-1"
    assert captured["action_type"] == "email"
    assert captured["response"] == {"MessageId": "msg-1"}
    # Same session as the ActionLog write, so the observer's row commits with it.
    assert captured["db"] is session


@pytest.mark.asyncio
async def test_a_failing_observer_neither_raises_nor_skips_the_others():
    """The send already happened. An observer must not be able to undo that.

    If this raised, a successful message would surface as a 500 and invite the
    engine to retry — delivering it twice to fix a bookkeeping fault.
    """
    seen: list[str] = []

    @register_run_outcome_observer
    def _boom(ctx, db):
        raise RuntimeError("observer is broken")

    @register_run_outcome_observer
    def _still_runs(ctx, db):
        seen.append("ran")

    outcome = _outcome(run=type("R", (), {"id": "run-1"})())
    await notify_run_outcome(outcome, db=object())  # type: ignore[arg-type]

    assert seen == ["ran"]
