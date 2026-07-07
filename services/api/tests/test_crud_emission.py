"""Generic-CRUD state-change emission (ADR-0002 / #222, Phase B).

Drives the shared handler factories against a synthetic model on in-memory SQLite
and asserts the right ``<table>.<op>`` events are buffered, secrets are denied,
and opt-out works. The compliance gate for ``<table>.<op>`` is tested separately.
"""

import pytest
from sqlalchemy import String
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column

from api.events import is_declared, pending_events
from api.models.base import Base, TenantScopedModel
from api.models.plugin_table import PermissionRule, TablePermissions
from api.routing.crud_handlers import (
    make_create_handler,
    make_delete_handler,
    make_update_handler,
    user_columns_from_model,
)

# No __crud_permissions__ → excluded from the core CRUD registry (no pollution);
# emission is gated by __emit_events__, not the permissions block.


class _Widget(TenantScopedModel):
    __tablename__ = "widgets_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # "secret_token" contains denylisted substrings → must never hit the bus.
    secret_token: Mapped[str | None] = mapped_column(String(100), nullable=True)


class _SilentWidget(TenantScopedModel):
    __tablename__ = "silent_widgets_test"
    __emit_events__ = False

    name: Mapped[str] = mapped_column(String(100), nullable=False)


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


async def test_create_buffers_created_event_without_secrets(session):
    handler = make_create_handler(_Widget, user_columns_from_model(_Widget))
    await handler(
        payload={"name": "Acme", "secret_token": "sh-hush"},
        tenant_id="default",
        db=session,
    )

    events = pending_events(session)
    assert len(events) == 1
    event = events[0]
    assert event.detail_type == "widgets_test.created"
    assert event.tenant_id == "default"
    assert event.payload["name"] == "Acme"
    assert event.payload["id"]  # full row is carried
    # The secret column is denied — never on the bus.
    assert "secret_token" not in event.payload


async def test_update_buffers_updated_event(session):
    created = await make_create_handler(_Widget, user_columns_from_model(_Widget))(
        payload={"name": "Acme"}, tenant_id="default", db=session
    )
    row_id = created["id"]

    await make_update_handler(_Widget, user_columns_from_model(_Widget))(
        id=row_id, payload={"name": "Renamed"}, tenant_id="default", db=session
    )

    events = pending_events(session)
    assert [e.detail_type for e in events] == [
        "widgets_test.created",
        "widgets_test.updated",
    ]
    assert events[1].payload["name"] == "Renamed"


async def test_delete_buffers_deleted_event_with_captured_row(session):
    created = await make_create_handler(_Widget, user_columns_from_model(_Widget))(
        payload={"name": "Acme"}, tenant_id="default", db=session
    )
    row_id = created["id"]

    result = await make_delete_handler(_Widget)(
        id=row_id, tenant_id="default", db=session
    )
    assert result == {"deleted": True, "id": row_id}

    deleted = [e for e in pending_events(session) if e.detail_type.endswith(".deleted")]
    assert len(deleted) == 1
    # The row is captured before deletion so the payload isn't empty.
    assert deleted[0].payload["id"] == row_id
    assert deleted[0].payload["name"] == "Acme"


async def test_opt_out_model_emits_nothing(session):
    await make_create_handler(_SilentWidget, user_columns_from_model(_SilentWidget))(
        payload={"name": "quiet"}, tenant_id="default", db=session
    )
    assert pending_events(session) == []


def test_is_declared_admits_allowed_crud_ops(monkeypatch):
    registry = {"widgets": TablePermissions(create=PermissionRule(allowed=True))}
    monkeypatch.setattr(
        "api.permissions.get_permissions_registry", lambda **_: registry
    )

    assert is_declared("biffo.core", "widgets.created") is True
    # delete not allowed on this table → not a declared event
    assert is_declared("biffo.core", "widgets.deleted") is False
    # unknown table / non-crud suffix → not declared
    assert is_declared("biffo.core", "gremlins.created") is False
    assert is_declared("biffo.core", "widgets.frobnicated") is False
