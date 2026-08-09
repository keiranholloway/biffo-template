"""A model may declare a column that exists and must never be settable through
generic create/update, with the model itself supplying the refusal message.

## Why this is a capability the generic CRUD layer needs

`user_columns_from_model` already has one way to keep a column real but
unwritable: `AUTO_COLUMN_NAMES` and the `deleted_at` soft-delete marker. Both
are fixed, framework-level exclusions. Nothing before this let an individual
*model* declare its own — so a column that a schema still carries but a write
path should never touch again (a retired capability, a value now derived
elsewhere, anything the table legitimately keeps while the API must stop
accepting writes to it) had exactly two available outcomes, and both are worse
than naming the reason:

1. Stay in the writable set, reach the database, and fail however the schema
   happens to enforce it — typically a generic, driver-classified 400
   (`_integrity_error_response`) that names a database condition, not a reason
   a caller can act on.
2. Be removed from the writable set some other way (deleting the column
   outright, say) and fall through to `_reject_unwritable_fields`'s generic
   422 ("Unwritable or unknown field(s): ...") — the same message a genuine
   typo gets, which throws away the one thing that makes a refusal
   actionable: *why*.

A refusal naming neither the cause nor the remedy is a repeated, costly defect
in this estate's own history — a message telling a caller to be the thing
they already were, an orphaning failure whose 403 named neither the cause nor
the side effect it had just caused. A model that knows a column is retired
also knows what to tell the caller. `__crud_forbidden_fields__` is the hook
that lets it.

## What this file proves

- A model declaring `__crud_forbidden_fields__` refuses that field with its
  own message and a 400, on both create and update, before the database ever
  sees it.
- The refusal wins over `_reject_unwritable_fields`'s generic 422 for the same
  key (checked first, in `make_create_handler`/`make_update_handler`).
- Every other writable column is unaffected — the mechanism narrows one field,
  not the model's writability in general.
- The forbidden column stays mapped and readable: it appears in a create
  response, and other columns still round-trip normally.
"""

from typing import ClassVar

import pytest
from api.models.base import Base, TenantScopedModel
from api.routing.crud_handlers import (
    make_create_handler,
    make_update_handler,
    user_columns_from_model,
)
from fastapi import HTTPException
from sqlalchemy import String
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column


class _Widget(TenantScopedModel):
    """A stand-in for "a column the table still carries but must never be
    written again" — `legacy_code` is the forbidden field, `name` is an
    ordinary writable one so the tests can show the refusal is scoped."""

    __tablename__ = "widgets_forbidden_fields_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    legacy_code: Mapped[str | None] = mapped_column(String(50), nullable=True)

    __crud_forbidden_fields__: ClassVar[dict[str, str]] = {
        "legacy_code": "legacy_code is retired and can no longer be set — pass name instead",
    }


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


# ── the mechanism: user_columns_from_model excludes a declared field ───────


def test_user_columns_from_model_excludes_a_declared_forbidden_field() -> None:
    columns = user_columns_from_model(_Widget)
    assert "legacy_code" not in columns
    assert "name" in columns


def test_a_model_declaring_nothing_is_unaffected() -> None:
    """The default (no `__crud_forbidden_fields__` at all) must not change
    behaviour for every other model — this reads via `getattr` with an empty
    dict fallback, never a hard requirement."""

    class _Plain(TenantScopedModel):
        __tablename__ = "plain_forbidden_fields_test"
        name: Mapped[str] = mapped_column(String(100), nullable=False)

    assert user_columns_from_model(_Plain) == {"name"}


# ── create: refused with the model's own message, before the database ──────


async def test_create_refuses_the_forbidden_field_with_its_own_message(session):
    handler = make_create_handler(_Widget, user_columns_from_model(_Widget))
    with pytest.raises(HTTPException) as exc_info:
        await handler(
            payload={"name": "Acme", "legacy_code": "old-001"},
            tenant_id="default",
            db=session,
        )
    err = exc_info.value
    assert err.status_code == 400
    assert err.detail == _Widget.__crud_forbidden_fields__["legacy_code"]


async def test_create_refusal_beats_the_generic_unwritable_field_422(session):
    """Excluding the field from `user_columns` alone would already stop the
    write — `_reject_unwritable_fields` rejects anything outside that set. The
    point of `_reject_forbidden_fields` running first is the STATUS and
    MESSAGE: 400 naming the reason, not a 422 saying only that the field is
    unknown."""
    handler = make_create_handler(_Widget, user_columns_from_model(_Widget))
    with pytest.raises(HTTPException) as exc_info:
        await handler(
            payload={"name": "Acme", "legacy_code": "old-001"},
            tenant_id="default",
            db=session,
        )
    assert exc_info.value.status_code != 422


async def test_create_still_accepts_every_other_writable_field(session):
    """The allow mirror — the mechanism must narrow only the declared field,
    not creation in general."""
    handler = make_create_handler(_Widget, user_columns_from_model(_Widget))
    result = await handler(payload={"name": "Acme"}, tenant_id="default", db=session)
    assert result["name"] == "Acme"
    # The forbidden column stays mapped and readable — it just was never set.
    assert result["legacy_code"] is None


# ── update: same refusal, same precedence ───────────────────────────────────


async def test_update_refuses_the_forbidden_field_with_its_own_message(session):
    create_handler = make_create_handler(_Widget, user_columns_from_model(_Widget))
    row = await create_handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    update_handler = make_update_handler(_Widget, user_columns_from_model(_Widget))
    with pytest.raises(HTTPException) as exc_info:
        await update_handler(
            id=row["id"],
            payload={"legacy_code": "old-001"},
            tenant_id="default",
            db=session,
        )
    err = exc_info.value
    assert err.status_code == 400
    assert err.detail == _Widget.__crud_forbidden_fields__["legacy_code"]


async def test_update_still_accepts_every_other_writable_field(session):
    create_handler = make_create_handler(_Widget, user_columns_from_model(_Widget))
    row = await create_handler(payload={"name": "Acme"}, tenant_id="default", db=session)

    update_handler = make_update_handler(_Widget, user_columns_from_model(_Widget))
    updated = await update_handler(
        id=row["id"], payload={"name": "Acme Renamed"}, tenant_id="default", db=session
    )
    assert updated["name"] == "Acme Renamed"
