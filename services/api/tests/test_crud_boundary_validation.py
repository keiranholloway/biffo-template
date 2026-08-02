"""Generic-CRUD boundary validation (tabsii-platform#473, #474).

Two defects found via a downstream instance's live click-through, both in the
create/update handler internals of ``crud_handlers.py``:

- **#473** — a driver ``IntegrityError`` put its raw ``exc.orig`` text (driver
  name, exception class, physical table name, constraint wording) straight into
  the HTTP 400 response body. Schema reconnaissance handed to any authenticated
  caller, and unstable — it breaks whenever the driver's wording changes.
- **#474 (part 2)** — the update (and, identically, create) handler silently
  dropped any payload key not in the model's writable column set instead of
  rejecting it. The handler still returned 200/201 with the full serialized
  row, so a caller checking only the status code concluded a write succeeded
  when it was dropped on the floor.

This file proves both are fixed: no driver text reaches the response body (only
a stable generic message, with the real detail logged server-side at WARN), and
an unwritable/unknown payload key now gets a 422 instead of a silent no-op.
"""

from typing import Any, cast

import pytest
from api.models.base import Base, TenantScopedModel
from api.routing.crud_handlers import (
    _DEFAULT_INTEGRITY_MESSAGE,
    _INTEGRITY_ERROR_MESSAGES,
    _integrity_error_response,
    make_create_handler,
    make_update_handler,
    user_columns_from_model,
)
from fastapi import HTTPException
from sqlalchemy import String, UniqueConstraint
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column


class _Gizmo(TenantScopedModel):
    __tablename__ = "gizmos_boundary_test"
    __table_args__ = (UniqueConstraint("name", name="uq_gizmos_boundary_test_name"),)

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


# ── #473: no driver text in the response ────────────────────────────────────


async def test_create_integrity_error_does_not_leak_driver_text(session):
    handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    await handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    with pytest.raises(HTTPException) as exc_info:
        await handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    err = exc_info.value
    assert err.status_code == 400
    body = str(err.detail)
    # The generic message is present...
    assert isinstance(err.detail, dict)
    detail = cast(dict[str, Any], err.detail)
    assert detail["message"] == _DEFAULT_INTEGRITY_MESSAGE
    # ...and none of the driver's own vocabulary leaked into it.
    for leaky in ("sqlite3", "IntegrityError", "gizmos_boundary_test", "UNIQUE constraint"):
        assert leaky not in body, f"driver text {leaky!r} leaked into response body: {body!r}"


async def test_update_integrity_error_does_not_leak_driver_text(session):
    create_handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    first = await create_handler(payload={"name": "Acme"}, tenant_id="default", db=session)
    second = await create_handler(payload={"name": "Beta"}, tenant_id="default", db=session)

    update_handler = make_update_handler(_Gizmo, user_columns_from_model(_Gizmo))
    with pytest.raises(HTTPException) as exc_info:
        # Renaming "Beta" to "Acme" collides with the first row's unique name.
        await update_handler(
            id=second["id"], payload={"name": "Acme"}, tenant_id="default", db=session
        )

    err = exc_info.value
    assert err.status_code == 400
    body = str(err.detail)
    assert isinstance(err.detail, dict)
    detail = cast(dict[str, Any], err.detail)
    assert detail["message"] == _DEFAULT_INTEGRITY_MESSAGE
    for leaky in ("sqlite3", "IntegrityError", "gizmos_boundary_test", "UNIQUE constraint"):
        assert leaky not in body, f"driver text {leaky!r} leaked into response body: {body!r}"
    assert first["id"] != second["id"]


async def test_integrity_error_detail_is_logged_server_side(session, caplog):
    handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    await handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    with caplog.at_level("WARNING"):
        with pytest.raises(HTTPException):
            await handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    # The real driver detail reached server-side logs even though it never
    # reached the HTTP response (asserted separately above).
    messages = [record.message for record in caplog.records]
    assert any("IntegrityError" in m and "gizmos_boundary_test" in m for m in messages)


# ── #473: SQLSTATE classification, exercised directly (production runs on
# asyncpg, whose ``exc.orig`` carries ``.sqlstate``/``.constraint_name``; the
# test suite's sqlite3 driver does not, so this is unit-tested against a stub
# standing in for asyncpg's PostgresError shape rather than faked end-to-end).


class _FakeDriverError(Exception):
    def __init__(self, sqlstate: str, constraint_name: str | None = None) -> None:
        super().__init__(f"raw driver text nobody should see (sqlstate={sqlstate})")
        self.sqlstate = sqlstate
        self.constraint_name = constraint_name


def _fake_integrity_error(sqlstate: str, constraint_name: str | None = None) -> IntegrityError:
    orig = _FakeDriverError(sqlstate, constraint_name)
    return IntegrityError("statement", {}, orig)


@pytest.mark.parametrize(
    "sqlstate",
    sorted(_INTEGRITY_ERROR_MESSAGES),
)
def test_known_sqlstates_map_to_stable_generic_messages(sqlstate: str) -> None:
    exc = _fake_integrity_error(sqlstate, constraint_name="ck_gizmos_example")
    http_exc = _integrity_error_response(exc, model=_Gizmo, operation="create")

    assert http_exc.status_code == 400
    detail: dict[str, Any] = http_exc.detail  # type: ignore[assignment]
    assert detail["message"] == _INTEGRITY_ERROR_MESSAGES[sqlstate]
    assert "raw driver text" not in detail["message"]
    # A constraint name the driver names is fine to surface — it's stable and
    # machine-readable, unlike the free-text exception body.
    assert detail["constraint"] == "ck_gizmos_example"


def test_unrecognised_sqlstate_falls_back_to_default_message() -> None:
    exc = _fake_integrity_error("99999")
    http_exc = _integrity_error_response(exc, model=_Gizmo, operation="update")

    detail: dict[str, Any] = http_exc.detail  # type: ignore[assignment]
    assert detail["message"] == _DEFAULT_INTEGRITY_MESSAGE
    assert "constraint" not in detail


# ── #474 (part 2): unwritable/unknown fields are rejected, not dropped ──────


async def test_create_rejects_unknown_field_with_422(session):
    handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    with pytest.raises(HTTPException) as exc_info:
        await handler(
            payload={"name": "Acme", "nope_not_a_field": "x"},
            tenant_id="default",
            db=session,
        )
    assert exc_info.value.status_code == 422
    assert "nope_not_a_field" in str(exc_info.value.detail)


async def test_create_rejects_auto_managed_column_with_422(session):
    # tenant_id/id/created_at/updated_at must never be settable from the body
    # (ADR-0001) — previously silently dropped, now explicitly rejected.
    handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    with pytest.raises(HTTPException) as exc_info:
        await handler(
            payload={"name": "Acme", "tenant_id": "attacker-tenant"},
            tenant_id="default",
            db=session,
        )
    assert exc_info.value.status_code == 422
    assert "tenant_id" in str(exc_info.value.detail)


async def test_update_rejects_unknown_field_with_422_instead_of_silently_succeeding(session):
    create_handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    created = await create_handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    update_handler = make_update_handler(_Gizmo, user_columns_from_model(_Gizmo))
    with pytest.raises(HTTPException) as exc_info:
        await update_handler(
            id=created["id"],
            payload={"name": "Renamed", "deleted_at": "2026-01-01T00:00:00Z"},
            tenant_id="default",
            db=session,
        )
    assert exc_info.value.status_code == 422
    assert "deleted_at" in str(exc_info.value.detail)

    # And the row was NOT partially mutated by the rejected call — the old
    # silent-drop behaviour would have returned 200 with "name" unchanged too,
    # since setattr happened before the flush; confirm the reject is total.
    from sqlalchemy import select

    result = await session.execute(select(_Gizmo).where(_Gizmo.id == created["id"]))
    row = result.scalar_one()
    assert row.name == "Acme"


async def test_update_still_allows_legitimate_partial_update(session):
    # The fix rejects keys NOT in user_columns — it must not start requiring
    # every writable field on every update. A payload naming a strict subset
    # of writable columns keeps working exactly as before.
    create_handler = make_create_handler(_Gizmo, user_columns_from_model(_Gizmo))
    created = await create_handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    update_handler = make_update_handler(_Gizmo, user_columns_from_model(_Gizmo))
    updated = await update_handler(
        id=created["id"], payload={"name": "Renamed"}, tenant_id="default", db=session
    )
    assert updated["name"] == "Renamed"
