"""issue #150: require_auth enforces the DB `users.is_active` flag, so a
suspended user can't keep calling the API with an already-issued access token."""

from typing import NamedTuple

import api.middleware.auth as auth_module
import pytest
from api.middleware.auth import require_auth
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials


def _credentials() -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")


class _FakeRow(NamedTuple):
    id: str
    is_active: bool


class _FakeResult:
    def __init__(self, row: _FakeRow | None) -> None:
        self._row = row

    def one_or_none(self) -> _FakeRow | None:
        return self._row


class _FakeDb:
    """Minimal AsyncSession stand-in. The default provider selects id and
    is_active together (ADR-0012), so execute() yields a row, or None for a
    caller with no record yet."""

    def __init__(self, is_active: bool | None) -> None:
        self._row = None if is_active is None else _FakeRow("user-1", is_active)
        self.executed = False

    async def execute(self, _stmt: object) -> _FakeResult:
        self.executed = True
        return _FakeResult(self._row)


@pytest.fixture(autouse=True)
def _stub_token(monkeypatch):
    monkeypatch.setattr(
        auth_module,
        "_verify_token",
        lambda _token: {"sub": "sub-1", "email": "a@example.com"},
    )


async def test_rejects_deactivated_user():
    db = _FakeDb(is_active=False)
    with pytest.raises(HTTPException) as exc:
        await require_auth(credentials=_credentials(), db=db)  # type: ignore[arg-type]
    assert exc.value.status_code == 401
    assert db.executed


async def test_allows_active_user():
    caller = await require_auth(credentials=_credentials(), db=_FakeDb(True))  # type: ignore[arg-type]
    assert caller.sub == "sub-1"


async def test_allows_user_without_a_row_yet():
    # Provisioned-but-never-logged-in: no row -> treated as active.
    caller = await require_auth(credentials=_credentials(), db=_FakeDb(None))  # type: ignore[arg-type]
    assert caller.sub == "sub-1"
