"""Transaction-safe, compliance-gated emission (events/emit.py, ADR-0002 / #222)."""

from typing import Any

import pytest

import api.dependencies as dependencies
import api.database as database
from api.events import BiffoEvent, emit_event, is_declared, pending_events
from api.events.emit import publish_pending
from api.events.registry import DEMO_REQUESTED, EventType


class _RecordingPublisher:
    def __init__(self) -> None:
        self.events: list[BiffoEvent] = []

    def publish(self, event: BiffoEvent) -> None:
        self.events.append(event)


class _FakeSession:
    """Minimal stand-in exposing the bits get_db / emit use: .info + commit/rollback."""

    def __init__(self) -> None:
        self.info: dict[str, Any] = {}
        self.committed = False
        self.rolled_back = False

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


@pytest.fixture
def publisher(monkeypatch) -> _RecordingPublisher:
    rec = _RecordingPublisher()
    monkeypatch.setattr(dependencies, "get_event_publisher", lambda: rec)
    return rec


def test_emit_event_buffers_and_does_not_publish(publisher):
    db = _FakeSession()
    emit_event(db, DEMO_REQUESTED, {"demo_request_id": "d1"}, tenant_id="default")

    buffered = pending_events(db)
    assert len(buffered) == 1
    assert buffered[0].detail_type == "demo.requested"
    assert buffered[0].payload == {"demo_request_id": "d1"}
    # Buffered only — nothing hit the (fake) bus yet.
    assert publisher.events == []


def test_is_declared_gate():
    assert is_declared("biffo.core", "demo.requested") is True
    assert is_declared("biffo.core", "not.a.real.event") is False


async def test_publish_pending_publishes_declared_and_clears(publisher):
    db = _FakeSession()
    emit_event(db, DEMO_REQUESTED, {"demo_request_id": "d1"})

    await publish_pending(db)

    assert len(publisher.events) == 1
    assert publisher.events[0].detail_type == "demo.requested"
    # Buffer drained so a re-drain can't double-publish.
    assert pending_events(db) == []
    await publish_pending(db)
    assert len(publisher.events) == 1


async def test_publish_pending_refuses_undeclared(publisher):
    db = _FakeSession()
    # An EventType that was never register_event()'d is not "defined in code".
    undeclared = EventType("biffo.core", "made.up.event", "Made up", "")
    emit_event(db, undeclared, {"x": 1})

    await publish_pending(db)

    # Compliance gate: nothing non-compliant reaches the bus.
    assert publisher.events == []


async def test_get_db_publishes_after_commit(monkeypatch, publisher):
    session = _FakeSession()
    monkeypatch.setattr(database, "AsyncSessionLocal", lambda: _cm(session))

    agen = database.get_db()
    yielded = await agen.__anext__()
    emit_event(yielded, DEMO_REQUESTED, {"demo_request_id": "d1"})
    with pytest.raises(StopAsyncIteration):
        await agen.__anext__()  # runs commit + publish_pending

    assert session.committed is True
    assert len(publisher.events) == 1
    assert publisher.events[0].detail_type == "demo.requested"


async def test_get_db_does_not_publish_on_rollback(monkeypatch, publisher):
    session = _FakeSession()
    monkeypatch.setattr(database, "AsyncSessionLocal", lambda: _cm(session))

    agen = database.get_db()
    yielded = await agen.__anext__()
    emit_event(yielded, DEMO_REQUESTED, {"demo_request_id": "d1"})
    with pytest.raises(ValueError):
        await agen.athrow(ValueError("boom"))  # -> except: rollback + raise

    assert session.rolled_back is True
    assert publisher.events == []  # phantom event never published


def _cm(session: _FakeSession):
    """Async context manager mimicking AsyncSessionLocal()."""

    class _CM:
        async def __aenter__(self) -> _FakeSession:
            return session

        async def __aexit__(self, *_: object) -> bool:
            return False

    return _CM()
