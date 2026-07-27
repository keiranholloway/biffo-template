"""issue #150: the DB `users.is_active` flag is enforced on every authenticated
path, so a suspended user can't keep calling the API with an already-issued
access token.

Covers both dependencies deliberately (#621). The flag was originally enforced
only in `require_auth`; `require_forwarded_user` — the SigV4/plugin path — did
not, so the mitigation silently missed every plugin-forwarded route. The
assertions below are duplicated across both entry points on purpose: they are
what stops the two drifting apart again.

Specifically about the *default* provider, whose store is the Core's own
`public.users`. A deployment that retired that table (ADR-0012) has its own
equivalent coverage against its own provider, so this module skips there.
"""

from importlib.util import find_spec
from typing import NamedTuple

import api.middleware.auth as auth_module
import pytest
from api.identity import (
    DefaultIdentityProvider,
    get_identity_provider,
    set_identity_provider,
)
from api.middleware.auth import require_auth
from api.middleware.forwarded_user import require_forwarded_user
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

pytestmark = pytest.mark.skipif(
    find_spec("api.models.user") is None,
    reason="deployment has retired the Core users model (ADR-0012)",
)


@pytest.fixture(autouse=True)
def _use_default_provider():
    """Pin the provider under test.

    The installed provider is process-global, so importing anything that calls
    set_identity_provider() (a deployment's main.py does exactly that at import
    time) would otherwise leave these assertions running against whichever
    provider happened to load first — passing or failing on test order.
    """
    original = get_identity_provider()
    set_identity_provider(DefaultIdentityProvider())
    yield
    set_identity_provider(original)


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


# ── the same flag, via the forwarded (SigV4/plugin) path — #621 ─────────────────


async def test_rejects_deactivated_user_on_the_forwarded_path():
    """The regression #621 exists to prevent: a suspended user's unexpired token,
    forwarded by a plugin, must be refused exactly as a direct call is."""
    db = _FakeDb(is_active=False)
    with pytest.raises(HTTPException) as exc:
        await require_forwarded_user(forwarded_token="token", db=db)  # type: ignore[arg-type]
    assert exc.value.status_code == 401
    assert db.executed  # the provider lookup actually ran on this path


async def test_allows_active_user_on_the_forwarded_path():
    caller = await require_forwarded_user(forwarded_token="token", db=_FakeDb(True))  # type: ignore[arg-type]
    assert caller.sub == "sub-1"


async def test_forwarded_path_allows_user_without_a_row_yet():
    caller = await require_forwarded_user(forwarded_token="token", db=_FakeDb(None))  # type: ignore[arg-type]
    assert caller.sub == "sub-1"
