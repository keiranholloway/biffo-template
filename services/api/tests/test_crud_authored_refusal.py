"""An integrity error our own schema AUTHORED reaches the caller intact, and
``make_delete_handler`` no longer turns one into a 500 (#1349).

Two defects, both invisible until something actually called a delete route on
a trigger-guarded table:

1. ``make_delete_handler`` flushed with no ``try`` at all. ``make_create_handler``
   and ``make_update_handler`` both catch ``IntegrityError``; delete was the
   only writer that did not. A trigger guarding a **soft** delete refuses it on
   the tombstone write — a soft delete is an ``UPDATE`` — so the refusal
   surfaced as an unhandled exception (a 500): the caller was told the server
   had broken, when it had in fact correctly declined.
2. ``_integrity_error_response`` mapped every SQLSTATE to a fixed sentence from
   ``_INTEGRITY_ERROR_MESSAGES``, discarding the refusal's own message. For a
   genuine constraint violation that is right (tabsii-platform#473 — the raw
   driver text is schema reconnaissance). For an *authored* refusal — a
   ``RAISE`` inside one of our own triggers — it is backwards: the trigger's
   message names what depends on the row and prescribes the remedy, and the
   remedy clause is the load-bearing half.

## The discriminator was measured, not assumed

Against a real Postgres:

    genuine FK violation    sqlstate=23503  constraint_name='lessons_course_id_fkey'
    a RAISE in our trigger  sqlstate=23503  constraint_name=None

Postgres always names the constraint it enforced; a ``RAISE EXCEPTION`` inside
a trigger has none to name. **Class 23 with no constraint** is the schema
refusing deliberately, and only then is the message ours to forward. This must
not weaken #473 — the negative control below (a *named* constraint still gets
the generic message and the 400) is what keeps the two apart; without it the
change could pass by simply leaking every driver error.

Sibling to ``test_crud_boundary_validation.py`` (which owns #473/#474) rather
than an addition to it, since this is a distinct concern — an exception to
that file's rule, not a change to it.
"""

from datetime import datetime
from typing import Any, cast

import pytest
from api.models.base import Base, TenantScopedModel
from api.routing.crud_handlers import (
    _INTEGRITY_ERROR_MESSAGES,
    _integrity_error_response,
    make_create_handler,
    make_delete_handler,
    user_columns_from_model,
)
from fastapi import HTTPException
from sqlalchemy import DateTime, String, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column


class _Course(TenantScopedModel):
    __tablename__ = "courses_authored_refusal_test"

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


class _FakeDriverError(Exception):
    """asyncpg's ``PostgresError`` — the GENUINE one, reachable as the wrapper's
    ``__cause__``.

    Stubbed rather than provoked end-to-end because the unit lane runs on
    sqlite, whose driver sets neither ``.sqlstate`` nor ``.constraint_name``.
    """

    def __init__(self, sqlstate: str, constraint_name: str | None, message: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.constraint_name = constraint_name
        self.message = message


class _FakeWrapperError(Exception):
    """``AsyncAdapt_asyncpg_dbapi.<Error>`` — what SQLAlchemy actually puts in
    ``exc.orig``, and what a fixture must be shaped like or it tests the
    assumption instead of the driver.

    Two properties are load-bearing and both are the OPPOSITE of the obvious
    stub:

    * ``constraint_name`` is **absent**, for every error. Reading it off this
      object yields ``None`` even for a genuine FK violation, so a
      discriminator that reads the wrapper marks everything "authored" and
      forwards raw driver text — the schema reconnaissance the response
      contract exists to prevent.
    * ``str()`` carries a **class-repr prefix**, so forwarding it leaks the
      driver's exception class into the response body.

    The previous fixture set ``constraint_name`` directly and called
    ``super().__init__(message)``, giving a bare ``str()`` and a present
    attribute — so the suite was green while neither held against a real
    database.
    """

    def __init__(self, cause: _FakeDriverError) -> None:
        super().__init__(f"<class 'asyncpg.exceptions.SomeError'>: {cause}")
        self.sqlstate = cause.sqlstate
        self.__cause__ = cause


def _err(sqlstate: str, constraint_name: str | None, message: str) -> IntegrityError:
    """An ``IntegrityError`` shaped the way the asyncpg dialect raises one:
    ``.orig`` is the wrapper, and the real driver error is its ``__cause__``."""
    cause = _FakeDriverError(sqlstate, constraint_name, message)
    return IntegrityError("statement", {}, _FakeWrapperError(cause))


#: A realistic authored refusal. The remedy clause is the part that must
#: survive — it is the only thing telling the caller what to do instead.
_AUTHORED = (
    "course 0c0de102 cannot be deleted: 3 enrolment(s), 0 completion(s) and "
    "0 certification(s) depend on it. Set status to 'archived' instead — an "
    "archived course leaves the catalogue while every learner keeps theirs."
)


# ── the discriminator, unit-tested directly against _integrity_error_response ─


def test_the_authored_message_survives() -> None:
    exc = _err("23503", None, _AUTHORED)
    http_exc = _integrity_error_response(exc, model=_Course, operation="delete")
    detail = cast(dict[str, Any], http_exc.detail)
    assert "Set status to 'archived' instead" in detail["message"], (
        "the authored remedy was replaced by a generic message — the trigger "
        "wrote that sentence precisely so a caller would know what to do"
    )
    assert "3 enrolment(s)" in detail["message"]


def test_an_authored_refusal_is_a_conflict_not_a_bad_request() -> None:
    """409, not 400: the body sent was fine, the current state of the data is
    what refuses it, and retrying with a different body is not the fix —
    archiving the course is."""
    exc = _err("23503", None, _AUTHORED)
    http_exc = _integrity_error_response(exc, model=_Course, operation="delete")
    assert http_exc.status_code == 409


def test_only_the_first_line_is_forwarded() -> None:
    """asyncpg keeps DETAIL/HINT/CONTEXT on separate lines, and CONTEXT in
    particular carries internal query text — exactly the reconnaissance #473
    excludes. Only the authored sentence is forwarded, not the whole payload.
    """
    exc = _err(
        "23503",
        None,
        _AUTHORED + "\nCONTEXT: PL/pgSQL function tabsii.fn_guard_course_delete() line 12",
    )
    http_exc = _integrity_error_response(exc, model=_Course, operation="delete")
    detail = cast(dict[str, Any], http_exc.detail)
    assert "CONTEXT" not in detail["message"]
    assert "fn_guard_course_delete" not in detail["message"]


@pytest.mark.parametrize("sqlstate", sorted(_INTEGRITY_ERROR_MESSAGES))
def test_a_named_constraint_keeps_the_generic_message_and_400(sqlstate: str) -> None:
    """**The negative control, and the reason this does not weaken #473.**

    A genuine constraint violation NAMES its constraint, so it must keep the
    stable generic message and the 400 for every SQLSTATE this layer maps.
    Without this test, the change could pass by simply leaking every driver
    error — the exact thing #473 forbids.
    """
    exc = _err(
        sqlstate, "courses_authored_refusal_test_name_key", "raw driver text nobody should see"
    )
    http_exc = _integrity_error_response(exc, model=_Course, operation="create")
    detail = cast(dict[str, Any], http_exc.detail)

    assert http_exc.status_code == 400
    assert detail["message"] == _INTEGRITY_ERROR_MESSAGES[sqlstate]
    assert "raw driver text" not in detail["message"]


def test_a_non_class_23_error_with_no_constraint_is_not_treated_as_authored() -> None:
    """The discriminator is narrower than "no constraint name" — it also
    requires SQLSTATE class 23 (integrity constraint violation). A class-40
    serialization failure, say, never names a constraint either, and must not
    be mistaken for an authored refusal."""
    exc = _err("40001", None, "serialization_failure text, not an authored refusal")
    http_exc = _integrity_error_response(exc, model=_Course, operation="create")
    detail = cast(dict[str, Any], http_exc.detail)

    assert http_exc.status_code == 400
    assert "serialization_failure" not in detail["message"]


# ── make_delete_handler actually catches it (defect 1) ───────────────────────
#
# Simulated by an ORM ``before_delete``/``before_update`` mapper event raising
# a real ``IntegrityError`` — SQLAlchemy propagates whatever an event raises
# unchanged through ``flush()``, the same way a driver-raised one would reach
# ``make_delete_handler``'s ``try``. This is the only way to exercise the
# handler's own catch on sqlite, which has no triggers.


class _GuardedCourse(TenantScopedModel):
    """No ``deleted_at`` — a trigger refusing a HARD delete."""

    __tablename__ = "guarded_courses_authored_refusal_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)


@event.listens_for(_GuardedCourse, "before_delete")
def _reject_hard_delete(mapper: Any, connection: Any, target: Any) -> None:
    raise _err("23503", None, _AUTHORED)


class _GuardedSoftCourse(TenantScopedModel):
    """Carries ``deleted_at`` — the real-world case. Module 104's trigger
    guards the SOFT delete, and a soft delete is an ``UPDATE``, so the refusal
    arrives on that flush, not on a ``DELETE`` statement."""

    __tablename__ = "guarded_soft_courses_authored_refusal_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )


@event.listens_for(_GuardedSoftCourse, "before_update")
def _reject_soft_delete(mapper: Any, connection: Any, target: Any) -> None:
    if target.deleted_at is not None:
        raise _err("23503", None, _AUTHORED)


class _NamedConstraintGuardedCourse(TenantScopedModel):
    """A trigger-shaped failure that DOES name a constraint — the negative
    control at the handler level, not just at ``_integrity_error_response``."""

    __tablename__ = "named_guarded_courses_authored_refusal_test"

    name: Mapped[str] = mapped_column(String(100), nullable=False)


@event.listens_for(_NamedConstraintGuardedCourse, "before_delete")
def _reject_with_named_constraint(mapper: Any, connection: Any, target: Any) -> None:
    raise _err("23503", "fk_something_or_other", "raw driver text nobody should see")


async def test_delete_handler_forwards_an_authored_refusal_on_a_hard_delete(session):
    create_handler = make_create_handler(_GuardedCourse, user_columns_from_model(_GuardedCourse))
    created = await create_handler(payload={"name": "Intro to X"}, tenant_id="default", db=session)

    delete_handler = make_delete_handler(_GuardedCourse)
    with pytest.raises(HTTPException) as exc_info:
        await delete_handler(id=created["id"], tenant_id="default", db=session)

    err = exc_info.value
    assert err.status_code == 409
    detail = cast(dict[str, Any], err.detail)
    assert "Set status to 'archived' instead" in detail["message"]


async def test_delete_handler_forwards_an_authored_refusal_on_a_soft_delete(session):
    """This is the case #1349 actually turned up: before this fix,
    ``make_delete_handler`` had no ``try`` at all, so this refusal — arriving
    on the tombstone UPDATE's flush — propagated as an unhandled
    ``IntegrityError`` instead of a 409."""
    create_handler = make_create_handler(
        _GuardedSoftCourse, user_columns_from_model(_GuardedSoftCourse)
    )
    created = await create_handler(payload={"name": "Intro to Y"}, tenant_id="default", db=session)

    delete_handler = make_delete_handler(_GuardedSoftCourse)
    with pytest.raises(HTTPException) as exc_info:
        await delete_handler(id=created["id"], tenant_id="default", db=session)

    err = exc_info.value
    assert err.status_code == 409
    detail = cast(dict[str, Any], err.detail)
    assert "Set status to 'archived' instead" in detail["message"]


async def test_delete_handler_keeps_a_named_constraint_generic_and_400(session):
    """The handler-level negative control: delete now catches
    ``IntegrityError``, but it must still defer to ``_integrity_error_response``'s
    discriminator rather than treating every refusal as authored."""
    create_handler = make_create_handler(
        _NamedConstraintGuardedCourse, user_columns_from_model(_NamedConstraintGuardedCourse)
    )
    created = await create_handler(payload={"name": "Intro to Z"}, tenant_id="default", db=session)

    delete_handler = make_delete_handler(_NamedConstraintGuardedCourse)
    with pytest.raises(HTTPException) as exc_info:
        await delete_handler(id=created["id"], tenant_id="default", db=session)

    err = exc_info.value
    assert err.status_code == 400
    detail = cast(dict[str, Any], err.detail)
    assert detail["message"] == _INTEGRITY_ERROR_MESSAGES["23503"]
    assert "raw driver text" not in detail["message"]
