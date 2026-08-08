"""A DBAPI refusal reaches the caller as what it IS, not as a 500 or a lie.

Generic CRUD had no ``except DBAPIError`` arm at all, so two refusals Postgres
raises routinely arrived as 500s — the server reporting itself broken when it
had correctly declined:

* **42501** — an RLS ``WITH CHECK`` denial, or a missing grant on the app role.
  The caller is authenticated and not authorised for this row: 403.
* **TB701** — an instance trigger refusing a row whose scope columns disagree
  with the parent its foreign key points at. The caller IS authorised and the
  row is wrong: 422, carrying the trigger's own sentence.

## Why the order matters, and why it is asserted

Downstream, these scope refusals were originally spelled 42501 too, so they
mapped to 403 and told a caller who held the permission that they did not —
measured against a deployed instance, where the same caller writing the same
table succeeded with a same-scope parent and got 403 with a cross-scope one.
The remedy a 403 implies (obtain a grant) could never fix it.

That is why ``_is_scope_inconsistency`` is checked FIRST and why an explicit
test pins the precedence: if the two arms are ever reordered, a scope refusal
silently becomes an authorization lie again, and every status-only assertion
still passes.

## The fixture shape is the point

``exc.orig`` is SQLAlchemy's asyncpg wrapper, which has **no** ``.message`` and
**no** ``.constraint_name``; the genuine error is its ``__cause__``. A stub that
sets those on the wrapper tests the assumption rather than the driver — see
``test_crud_authored_refusal.py``, where exactly that shape kept five real
failures invisible.
"""

from __future__ import annotations

import pytest
from api.routing.crud_handlers import (
    SCOPE_INCONSISTENCY_SQLSTATE,
    _is_permission_denied,
    _is_scope_inconsistency,
    _scope_inconsistency_detail,
)
from sqlalchemy.exc import DBAPIError

_TRIGGER_MESSAGE = "round-robin cursor points at rule 8cab1462, which belongs to another brand"


class _AsyncpgError(Exception):
    """The genuine ``asyncpg.exceptions.*``: carries ``.message``."""

    def __init__(self, sqlstate: str, message: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.message = message


class _WrapperError(Exception):
    """``AsyncAdapt_asyncpg_dbapi.<Error>``: ``.sqlstate`` yes, ``.message`` NO,
    and ``str()`` carries a class-repr prefix."""

    def __init__(self, cause: _AsyncpgError) -> None:
        super().__init__(f"<class 'asyncpg.exceptions.SomeError'>: {cause}")
        self.sqlstate = cause.sqlstate
        self.__cause__ = cause


def _dbapi_error(sqlstate: str, message: str = "refused") -> DBAPIError:
    return DBAPIError(
        "SELECT redacted_statement",
        {"bound": "param"},
        _WrapperError(_AsyncpgError(sqlstate, message)),
    )


def test_a_privilege_refusal_is_recognised() -> None:
    exc = _dbapi_error("42501")
    assert _is_permission_denied(exc) is True
    assert _is_scope_inconsistency(exc) is False


def test_a_scope_refusal_is_recognised_and_is_not_a_privilege_refusal() -> None:
    """The discrimination the whole change rests on.

    If these two ever answer the same way for one error, the handler's first
    matching arm wins and the distinction is gone.
    """
    exc = _dbapi_error(SCOPE_INCONSISTENCY_SQLSTATE, _TRIGGER_MESSAGE)
    assert _is_scope_inconsistency(exc) is True
    assert _is_permission_denied(exc) is False


def test_the_scope_code_is_not_one_postgres_can_raise_itself() -> None:
    """A user-defined class is what makes the match exact.

    Were this a standard code (23514 ``check_violation``, say), a genuine CHECK
    constraint would take the 422 path and its raw constraint name would reach
    the caller.
    """
    assert SCOPE_INCONSISTENCY_SQLSTATE[:2].isalpha()
    assert not SCOPE_INCONSISTENCY_SQLSTATE.startswith(("23", "42", "40", "22"))


def test_the_detail_is_the_trigger_sentence_not_the_wrapper() -> None:
    """Reading ``exc.orig`` yields no message at all, so this would silently
    degrade to the fallback: right status, no explanation."""
    detail = _scope_inconsistency_detail(
        _dbapi_error(SCOPE_INCONSISTENCY_SQLSTATE, _TRIGGER_MESSAGE)
    )
    assert detail == _TRIGGER_MESSAGE
    assert "asyncpg" not in detail, "the wrapper's class-repr prefix leaked into the body"


def test_the_detail_never_carries_the_statement_or_its_parameters() -> None:
    """``str(exc)`` on the SQLAlchemy wrapper includes both. A response body is
    the one place they must never appear."""
    detail = _scope_inconsistency_detail(
        _dbapi_error(SCOPE_INCONSISTENCY_SQLSTATE, _TRIGGER_MESSAGE)
    )
    assert "redacted_statement" not in detail
    assert "bound" not in detail


@pytest.mark.parametrize("message", ["", "   "])
def test_an_empty_driver_message_falls_back_rather_than_returning_blank(message: str) -> None:
    """A blank detail is worse than a generic one: it reads as a bug in us."""
    detail = _scope_inconsistency_detail(_dbapi_error(SCOPE_INCONSISTENCY_SQLSTATE, message))
    assert detail.strip()
    assert "different scope" in detail


def test_an_unrelated_sqlstate_matches_neither_arm() -> None:
    """Both must decline, so the handler re-raises and the error is not
    mislabelled as an authorization or validation outcome."""
    exc = _dbapi_error("08006")  # connection_failure
    assert _is_permission_denied(exc) is False
    assert _is_scope_inconsistency(exc) is False
