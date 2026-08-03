"""Generic CRUD understands ``deleted_at``.

Instances model soft-delete on tables they expose through generic CRUD —
tabsii's ``Region`` and ``Unit`` both carry ``deleted_at`` and declare
``__crud_permissions__`` — and both models' docstrings describe their generic
delete as setting ``deleted_at``. The handlers did no such thing: there was no
soft-delete concept anywhere in this layer, so a tombstoned row was returned by
every read and ``DELETE`` destroyed the row outright.

Three properties, each of which failed before this module existed:

* a tombstoned row is invisible to list, read and update;
* ``delete`` on a model carrying ``deleted_at`` tombstones rather than destroys,
  and is still a one-shot operation (deleting twice is a 404, not a second
  ``<table>.deleted`` event);
* ``deleted_at`` is not settable from a request body — otherwise ``update``
  is a delete, and an undelete, for anyone who never held ``delete``.

A model with no ``deleted_at``, and one opting out with ``__soft_delete__ =
False``, must still hard-delete — the change is meant to be invisible to them.
"""

from datetime import UTC, datetime

import pytest
from api.events import pending_events
from api.models.base import Base, TenantScopedModel
from api.routing.crud_handlers import (
    make_create_handler,
    make_delete_handler,
    make_list_handler,
    make_read_handler,
    make_update_handler,
    user_columns_from_model,
)
from fastapi import HTTPException
from sqlalchemy import DateTime, String, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column


class _SoftWidget(TenantScopedModel):
    """Shaped like tabsii's Unit: a deleted_at column, generic CRUD exposed."""

    __tablename__ = "soft_widgets_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )


class _HardWidget(TenantScopedModel):
    """No deleted_at — must keep hard-deleting exactly as before."""

    __tablename__ = "hard_widgets_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)


class _OptedOutWidget(TenantScopedModel):
    """Carries deleted_at but opts out — a table that wants rows destroyed."""

    __tablename__ = "optout_widgets_test"
    __soft_delete__ = False

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


async def _create(session, model, name: str) -> str:
    handler = make_create_handler(model, user_columns_from_model(model))
    row = await handler(payload={"name": name}, tenant_id="default", db=session)
    return str(row["id"])


async def _tombstone(session, model, row_id: str) -> None:
    """Mark a row deleted directly, the way a bespoke domain endpoint would."""
    row = (await session.execute(select(model).where(model.id == row_id))).scalar_one()
    row.deleted_at = func.now()
    await session.flush()


class TestTombstonedRowsAreInvisible:
    async def test_list_excludes_tombstoned(self, session):
        await _create(session, _SoftWidget, "live")
        gone = await _create(session, _SoftWidget, "tombstoned")
        await _tombstone(session, _SoftWidget, gone)

        rows = await make_list_handler(_SoftWidget)(tenant_id="default", db=session)

        assert [r["name"] for r in rows] == ["live"]

    async def test_read_404s_a_tombstoned_row(self, session):
        gone = await _create(session, _SoftWidget, "tombstoned")
        await _tombstone(session, _SoftWidget, gone)

        with pytest.raises(HTTPException) as exc:
            await make_read_handler(_SoftWidget)(id=gone, tenant_id="default", db=session)

        assert exc.value.status_code == 404

    async def test_update_404s_a_tombstoned_row(self, session):
        """A row you cannot read is a row you cannot write."""
        gone = await _create(session, _SoftWidget, "tombstoned")
        await _tombstone(session, _SoftWidget, gone)
        handler = make_update_handler(_SoftWidget, user_columns_from_model(_SoftWidget))

        with pytest.raises(HTTPException) as exc:
            await handler(id=gone, payload={"name": "resurrected"}, tenant_id="default", db=session)

        assert exc.value.status_code == 404

    async def test_list_still_returns_rows_never_deleted(self, session):
        """The tombstone filter must not exclude rows whose deleted_at is NULL."""
        await _create(session, _SoftWidget, "a")
        await _create(session, _SoftWidget, "b")

        rows = await make_list_handler(_SoftWidget)(tenant_id="default", db=session)

        assert sorted(r["name"] for r in rows) == ["a", "b"]


class TestDeleteTombstones:
    async def test_delete_sets_deleted_at_and_keeps_the_row(self, session):
        row_id = await _create(session, _SoftWidget, "doomed")

        result = await make_delete_handler(_SoftWidget)(id=row_id, tenant_id="default", db=session)

        assert result == {"deleted": True, "id": row_id}
        row = (
            await session.execute(select(_SoftWidget).where(_SoftWidget.id == row_id))
        ).scalar_one_or_none()
        assert row is not None, "row was destroyed despite the model having deleted_at"
        assert row.deleted_at is not None

    async def test_deleted_row_disappears_from_list(self, session):
        await _create(session, _SoftWidget, "keeper")
        row_id = await _create(session, _SoftWidget, "doomed")

        await make_delete_handler(_SoftWidget)(id=row_id, tenant_id="default", db=session)
        rows = await make_list_handler(_SoftWidget)(tenant_id="default", db=session)

        assert [r["name"] for r in rows] == ["keeper"]

    async def test_deleting_twice_is_a_404(self, session):
        row_id = await _create(session, _SoftWidget, "doomed")
        handler = make_delete_handler(_SoftWidget)
        await handler(id=row_id, tenant_id="default", db=session)

        with pytest.raises(HTTPException) as exc:
            await handler(id=row_id, tenant_id="default", db=session)

        assert exc.value.status_code == 404

    async def test_soft_delete_still_emits_one_deleted_event(self, session):
        row_id = await _create(session, _SoftWidget, "doomed")

        await make_delete_handler(_SoftWidget)(id=row_id, tenant_id="default", db=session)

        deleted = [e for e in pending_events(session) if e.detail_type.endswith(".deleted")]
        assert len(deleted) == 1
        assert deleted[0].detail_type == "soft_widgets_test.deleted"
        assert deleted[0].payload["id"] == row_id


class TestHardDeleteIsUnchanged:
    async def test_model_without_deleted_at_is_destroyed(self, session):
        row_id = await _create(session, _HardWidget, "doomed")

        await make_delete_handler(_HardWidget)(id=row_id, tenant_id="default", db=session)

        row = (
            await session.execute(select(_HardWidget).where(_HardWidget.id == row_id))
        ).scalar_one_or_none()
        assert row is None

    async def test_opting_out_restores_hard_delete(self, session):
        row_id = await _create(session, _OptedOutWidget, "doomed")

        await make_delete_handler(_OptedOutWidget)(id=row_id, tenant_id="default", db=session)

        row = (
            await session.execute(select(_OptedOutWidget).where(_OptedOutWidget.id == row_id))
        ).scalar_one_or_none()
        assert row is None

    async def test_opted_out_model_does_not_hide_rows(self, session):
        """Opting out means deleted_at carries no meaning for this layer at all
        — including on read, not just on delete."""
        row_id = await _create(session, _OptedOutWidget, "marked")
        await _tombstone(session, _OptedOutWidget, row_id)

        rows = await make_list_handler(_OptedOutWidget)(tenant_id="default", db=session)

        assert [r["name"] for r in rows] == ["marked"]


class TestDeletedAtIsNotBodySettable:
    """A body-settable tombstone makes `update` both a delete and an undelete
    for a caller who never held the `delete` permission."""

    def test_deleted_at_is_not_a_user_column(self):
        assert "deleted_at" not in user_columns_from_model(_SoftWidget)
        assert "name" in user_columns_from_model(_SoftWidget)

    async def test_create_rejects_deleted_at(self, session):
        handler = make_create_handler(_SoftWidget, user_columns_from_model(_SoftWidget))

        with pytest.raises(HTTPException) as exc:
            await handler(
                payload={"name": "x", "deleted_at": datetime.now(UTC).isoformat()},
                tenant_id="default",
                db=session,
            )

        assert exc.value.status_code == 422
        assert "deleted_at" in str(exc.value.detail)

    async def test_update_rejects_deleted_at(self, session):
        row_id = await _create(session, _SoftWidget, "live")
        handler = make_update_handler(_SoftWidget, user_columns_from_model(_SoftWidget))

        with pytest.raises(HTTPException) as exc:
            await handler(
                id=row_id,
                payload={"deleted_at": datetime.now(UTC).isoformat()},
                tenant_id="default",
                db=session,
            )

        assert exc.value.status_code == 422

    async def test_update_cannot_resurrect_a_tombstoned_row(self, session):
        """The two halves together: the row is invisible AND the field is
        unwritable, so there is no body that brings it back."""
        row_id = await _create(session, _SoftWidget, "doomed")
        await make_delete_handler(_SoftWidget)(id=row_id, tenant_id="default", db=session)
        handler = make_update_handler(_SoftWidget, user_columns_from_model(_SoftWidget))

        with pytest.raises(HTTPException) as exc:
            await handler(id=row_id, payload={"deleted_at": None}, tenant_id="default", db=session)

        assert exc.value.status_code == 422
