"""ADR-0012: identity is resolved through a provider seam, so a deployment can
move its identity record out of `public.users` without forking the auth path."""

from collections.abc import AsyncGenerator
from importlib.util import find_spec
from pathlib import Path
from typing import NamedTuple, cast

import api.middleware.auth as auth_module
import pytest
from api.identity import (
    DefaultIdentityProvider,
    ResolvedIdentity,
    get_identity_provider,
    set_identity_provider,
)
from api.middleware.auth import require_auth
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession


def _credentials() -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")


class _Row(NamedTuple):
    id: str
    is_active: bool


class _Result:
    def __init__(self, row: _Row | None) -> None:
        self._row = row

    def one_or_none(self) -> _Row | None:
        return self._row


class _Db:
    def __init__(self, row: _Row | None = None) -> None:
        self._row = row

    async def execute(self, _stmt: object) -> _Result:
        return _Result(self._row)


@pytest.fixture(autouse=True)
def _stub_token(monkeypatch):
    monkeypatch.setattr(
        auth_module,
        "_verify_token",
        lambda _token: {
            "sub": "sub-1",
            "email": "a@example.com",
            "cognito:groups": ["platform_admin"],
        },
    )


@pytest.fixture(autouse=True)
def _restore_provider():
    """The provider is process-global; never let a test leak one."""
    original = get_identity_provider()
    yield
    set_identity_provider(original)


class _ProfilesNotExercised:
    """Satisfies the profile half of `IdentityProvider` for auth-path tests.

    Test-only, and it raises rather than returning empties on purpose. The doubles
    below exist to exercise the four authentication operations; a profile call
    reaching one of them means the test under it drifted, and a silent `None`
    would hide that. Do not copy this into a real provider — a deployment that
    inherits stubs like these has a profile surface that type-checks and then
    fails in production, which is exactly what making these members required is
    meant to prevent.
    """

    async def list_profiles(self, db, tenant_id):
        raise AssertionError("profile surface not exercised by this test")

    async def get_profile_by_id(self, db, tenant_id, user_id):
        raise AssertionError("profile surface not exercised by this test")

    async def get_profile(self, db, subject):
        raise AssertionError("profile surface not exercised by this test")

    async def get_profiles(self, db, subjects):
        raise AssertionError("profile surface not exercised by this test")

    async def upsert_profile(self, db, *, subject, tenant_id, email, username, fields=None):
        raise AssertionError("profile surface not exercised by this test")

    async def set_active(self, db, subject, active):
        raise AssertionError("profile surface not exercised by this test")


@pytest.mark.skipif(
    find_spec("api.models.user") is None,
    reason="deployment has retired the Core users model (ADR-0012)",
)
class TestDefaultProvider:
    """A fresh `biffo init` has no business schema — the default must work.

    Skipped wholesale on a deployment that retired `public.users`: the default
    provider is inert there, and its backing model is deliberately gone.
    """

    async def test_resolves_id_and_active_state(self):
        identity = await DefaultIdentityProvider().resolve(
            _Db(_Row("user-1", True)),  # type: ignore[arg-type]
            {"sub": "sub-1"},
        )
        assert identity == ResolvedIdentity(user_id="user-1", is_active=True)

    async def test_absent_record_is_active_not_locked_out(self):
        """Provisioned-but-never-logged-in. Treating absence as deactivation
        would lock out every user of a lazily-provisioning deployment."""
        identity = await DefaultIdentityProvider().resolve(
            _Db(None),  # type: ignore[arg-type]
            {"sub": "sub-1"},
        )
        assert identity.is_active is True
        assert identity.user_id is None

    async def test_platform_admin_sync_is_a_noop(self):
        # No table to mirror in the base template; must not raise.
        assert (
            await DefaultIdentityProvider().sync_platform_admin(
                _Db(),  # type: ignore[arg-type]
                "user-1",
                True,
            )
            is None
        )

    async def test_permissions_empty_under_adr0004(self):
        assert (
            await DefaultIdentityProvider().resolve_permissions(
                _Db(),  # type: ignore[arg-type]
                "user-1",
            )
            == frozenset()
        )


class TestOverride:
    """The reason the seam exists: a deployment that retired `public.users`."""

    async def test_require_auth_uses_the_installed_provider(self):
        calls: list[str] = []

        class RetiredUsersTableProvider(_ProfilesNotExercised):
            """Sources identity from a business schema. Touches no Core table —
            note nothing here reads `public.users`."""

            def session(self) -> AsyncGenerator[AsyncSession]:
                raise AssertionError("session() is not used when db is injected")

            async def resolve(self, db, claims) -> ResolvedIdentity:
                calls.append("resolve")
                return ResolvedIdentity(user_id="biz-42", is_active=True)

            async def sync_platform_admin(self, db, user_id, is_member) -> None:
                calls.append(f"sync:{user_id}:{is_member}")

            async def resolve_permissions(self, db, user_id) -> frozenset[str]:
                calls.append("permissions")
                return frozenset({"regions.write"})

        set_identity_provider(RetiredUsersTableProvider())

        caller = await require_auth(credentials=_credentials(), db=_Db())  # type: ignore[arg-type]

        assert caller.user_id == "biz-42"
        assert caller.permissions == frozenset({"regions.write"})
        # The Cognito group is the source of truth for platform admin, and the
        # provider is told so it can reconcile whatever RLS reads.
        assert caller.is_platform_admin is True
        assert calls == ["resolve", "sync:biz-42:True", "permissions"]

    async def test_provider_can_reject_a_deactivated_caller(self):
        class DeactivatingProvider(DefaultIdentityProvider):
            async def resolve(self, db, claims) -> ResolvedIdentity:
                return ResolvedIdentity(user_id="biz-42", is_active=False)

        set_identity_provider(DeactivatingProvider())

        with pytest.raises(HTTPException) as exc:
            await require_auth(credentials=_credentials(), db=_Db())  # type: ignore[arg-type]
        assert exc.value.status_code == 401


class TestThroughFastAPI:
    """The unit tests inject `db` directly, which bypasses `identity_session`.
    This drives a real request so FastAPI itself resolves the async-generator
    dependency — the wiring most likely to break without a test noticing."""

    async def test_provider_session_is_driven_by_the_dependency(self):
        from fastapi import Depends, FastAPI
        from fastapi.testclient import TestClient

        opened: list[str] = []

        class SessionTrackingProvider(_ProfilesNotExercised):
            def session(self) -> AsyncGenerator[AsyncSession]:
                async def _gen():
                    opened.append("open")
                    try:
                        yield _Db()
                    finally:
                        opened.append("close")

                # _Db is a stand-in, not a real AsyncSession — the point of the
                # test is the generator lifecycle, not the session type.
                return cast(AsyncGenerator[AsyncSession], _gen())

            async def resolve(self, db, claims) -> ResolvedIdentity:
                # Proves the session the dependency yielded reached the provider.
                assert isinstance(db, _Db)
                return ResolvedIdentity(user_id="biz-7", is_active=True)

            async def sync_platform_admin(self, db, user_id, is_member) -> None:
                return None

            async def resolve_permissions(self, db, user_id) -> frozenset[str]:
                return frozenset()

        set_identity_provider(SessionTrackingProvider())

        app = FastAPI()

        @app.get("/whoami")
        async def whoami(caller=Depends(require_auth)):
            return {"user_id": caller.user_id}

        with TestClient(app) as client:
            response = client.get("/whoami", headers={"Authorization": "Bearer t"})

        assert response.status_code == 200
        assert response.json() == {"user_id": "biz-7"}
        # Opened and, crucially, closed — a generator dependency that never
        # finalises leaks a database session per request.
        assert opened == ["open", "close"]


class TestFailClosedDefaults:
    async def test_non_auth_construction_grants_nothing(self):
        """identity_from_token is used where no DB is available. Its unresolved
        fields must not read as "admin with permissions"."""
        user = auth_module.identity_from_token(_credentials())
        assert user.user_id is None
        assert user.is_platform_admin is False
        assert user.permissions == frozenset()


class TestCompliance:
    """ADR-0012: the auth path must not name an identity table. Enforced here
    because the failure mode is a silent re-coupling during a merge, which is
    exactly what the ADR exists to prevent."""

    def test_identity_package_imports_without_the_core_user_model(self, monkeypatch):
        """A deployment that retired `public.users` deletes `models/user.py`.

        Importing the identity package must still work there — it is imported at
        startup via `middleware/auth.py`, so a module-level dependency on a model
        the deployment deliberately removed takes the whole API down. Regression
        test: `identity/default.py` imported `User` at module scope, which would
        have broken tabsii the moment it took this seam.
        """
        import importlib
        import sys

        # None in sys.modules makes `import api.models.user` raise ImportError,
        # standing in for the file being absent.
        monkeypatch.setitem(sys.modules, "api.models.user", None)
        for module in ("api.identity", "api.identity.default"):
            monkeypatch.delitem(sys.modules, module, raising=False)

        reloaded = importlib.import_module("api.identity")
        assert reloaded.DefaultIdentityProvider is not None

    def test_auth_module_names_no_identity_table(self):
        """Asked over the AST, not with a substring search (#956, #957).

        The substring form this replaces passed only because `middleware/auth.py`
        happens never to mention those words. It is not a weaker guard than it
        looks — it is a guard that fires on *correct* code: `"import User"` also
        matches `from ..identity import UserProfile`, the DTO that replaced the
        model, and `"models.user"` matches any comment explaining the change.
        The identical idiom failed exactly that way in #949, on the fix it was
        meant to protect. A guard that fails on the fix gets deleted, so it is
        worse than no guard.

        The invariant is structural — does this module reach the Core user model?
        — so it is asked structurally.
        """
        import ast

        tree = ast.parse(Path(auth_module.__file__).read_text())

        imports = [
            f"line {node.lineno}: {ast.unparse(node)}"
            for node in ast.walk(tree)
            if (isinstance(node, ast.ImportFrom) and (node.module or "").endswith("models.user"))
            or (
                isinstance(node, ast.Import)
                and any(a.name.endswith("models.user") for a in node.names)
            )
        ]
        assert imports == [], f"auth.py reaches the Core user model: {imports}"

        # Raw SQL naming the table would bypass the seam just as effectively as
        # the ORM would. String constants only — prose in a docstring is fine.
        sql = [
            f"line {node.lineno}: {node.value!r}"
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and "from users" in node.value.lower()
        ]
        assert sql == [], f"auth.py queries the identity table directly: {sql}"
