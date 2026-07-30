"""The profile surface honours the ADR-0012 seam (#894).

`identity/base.py` says Biffo Core "does not assume it owns the identity record",
and `middleware/auth.py` respected that. Nothing else did: `routers/users.py`,
`routers/auth.py` and `routers/admin/users.py` each imported `models.user` at
module scope and queried `public.users` directly, so the 0.123.0+ profile feature
reintroduced one layer above the seam exactly the assumption the seam removes. A
deployment that legitimately retired `public.users` could not take the feature —
and could not even *import* those routers, so its API died at startup.

The first class here is the test that was missing: the profile endpoints served
entirely from a store that is not `public.users`, asserted by checking that the
Core table stays empty while the responses carry real data. The second pins the
default provider's own behaviour against a real (SQLite) database, including the
write path's field allow-list.

`routers/users.py` had **no test file at all** before this — neither endpoint, not
the 404, not the `is_active` asymmetry — so its coverage starts here.
"""

from collections.abc import AsyncGenerator, Sequence
from datetime import UTC, datetime
from importlib.util import find_spec

import pytest
from api.database import get_db
from api.events import pending_events
from api.identity import (
    DefaultIdentityProvider,
    UserProfile,
    get_identity_provider,
    set_identity_provider,
)
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.routers import auth as auth_router
from api.routers import users as users_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = pytest.mark.skipif(
    find_spec("api.models.user") is None,
    reason="deployment has retired the Core users model (ADR-0012)",
)

_NOW = datetime(2026, 7, 30, 9, 0, tzinfo=UTC)


def _profile(**overrides) -> UserProfile:
    base = {
        "id": "biz-42",
        "tenant_id": "default",
        "created_at": _NOW,
        "updated_at": _NOW,
        "email": "ada@example.com",
        "username": "ada",
        "is_active": True,
    }
    return UserProfile(**{**base, **overrides})


def _caller(sub: str = "sub-1") -> AuthenticatedUser:
    return AuthenticatedUser(
        sub=sub,
        email="ada@example.com",
        username="ada",
        roles=[],
        tenant_id="default",
    )


class BusinessSchemaProvider:
    """A deployment whose users live in its own schema, keyed by Cognito subject.

    Reads and writes a dict. It touches no Core table at all, which is the whole
    point: every assertion below is served from here while `public.users` stays
    empty.
    """

    def __init__(self, profiles: dict[str, UserProfile] | None = None) -> None:
        self.store: dict[str, UserProfile] = dict(profiles or {})
        self.calls: list[str] = []

    # --- auth path: not what this file tests, but required by the protocol ---
    def session(self) -> AsyncGenerator[AsyncSession]:
        raise AssertionError("db is injected in these tests")

    async def resolve(self, db, claims):
        raise AssertionError("require_auth is overridden in these tests")

    async def sync_platform_admin(self, db, user_id, is_member) -> None:
        return None

    async def resolve_permissions(self, db, user_id) -> frozenset[str]:
        return frozenset()

    # --- profile surface ----------------------------------------------------
    async def list_profiles(self, db, tenant_id: str) -> list[UserProfile]:
        self.calls.append("list_profiles")
        return [p for p in self.store.values() if p.tenant_id == tenant_id and p.is_active]

    async def get_profile_by_id(self, db, tenant_id: str, user_id: str) -> UserProfile | None:
        self.calls.append("get_profile_by_id")
        return next(
            (p for p in self.store.values() if p.id == user_id and p.tenant_id == tenant_id),
            None,
        )

    async def get_profile(self, db, subject: str) -> UserProfile | None:
        return self.store.get(subject)

    async def get_profiles(self, db, subjects: Sequence[str]) -> dict[str, UserProfile]:
        return {s: self.store[s] for s in subjects if s in self.store}

    async def upsert_profile(
        self, db, *, subject, tenant_id, email, username, fields=None
    ) -> tuple[UserProfile, bool]:
        self.calls.append("upsert_profile")
        created = subject not in self.store
        current = self.store.get(subject) or _profile(
            id=f"biz-{subject}", tenant_id=tenant_id, email=email, username=username
        )
        from dataclasses import replace

        self.store[subject] = replace(current, **(fields or {}))
        return self.store[subject], created

    async def set_active(self, db, subject: str, active: bool) -> None:
        from dataclasses import replace

        if subject in self.store:
            self.store[subject] = replace(self.store[subject], is_active=active)


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession]:
    """A real session, so `emit_event` has somewhere to buffer and so the
    `public.users`-stays-empty assertions mean something."""
    # Imported for its side effect — registering the users table on
    # Base.metadata — and inside the fixture rather than at module scope so
    # collection still succeeds on a deployment that retired the model.
    from api.models.user import User  # noqa: F401

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


@pytest.fixture(autouse=True)
def _restore_provider():
    original = get_identity_provider()
    yield
    set_identity_provider(original)


async def _core_users_count(db: AsyncSession) -> int:
    from api.models.user import User

    return (await db.execute(select(func.count()).select_from(User))).scalar_one()


def _app(db: AsyncSession, caller: AuthenticatedUser) -> FastAPI:
    app = FastAPI()
    app.include_router(users_router.router, prefix="/api/v1")
    app.include_router(auth_router.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: caller
    app.dependency_overrides[get_db] = lambda: db
    return app


class TestServedFromAStoreThatIsNotPublicUsers:
    """The behaviour #894 exists for, and which nothing covered."""

    async def test_list_users_comes_from_the_provider(self, db_session):
        provider = BusinessSchemaProvider(
            {
                "sub-1": _profile(id="biz-1", email="ada@example.com", username="ada"),
                "sub-2": _profile(id="biz-2", email="grace@example.com", username="grace"),
            }
        )
        set_identity_provider(provider)

        with TestClient(_app(db_session, _caller())) as client:
            body = client.get("/api/v1/users").json()

        assert [u["email"] for u in body] == ["ada@example.com", "grace@example.com"]
        assert provider.calls.count("list_profiles") == 1
        # The proof that the seam is honoured, not merely present.
        assert await _core_users_count(db_session) == 0

    async def test_list_users_hides_deactivated_and_other_tenants(self, db_session):
        set_identity_provider(
            BusinessSchemaProvider(
                {
                    "sub-1": _profile(id="biz-1", username="ada"),
                    "sub-2": _profile(id="biz-2", username="gone", is_active=False),
                    "sub-3": _profile(id="biz-3", username="elsewhere", tenant_id="other"),
                }
            )
        )
        with TestClient(_app(db_session, _caller())) as client:
            body = client.get("/api/v1/users").json()

        assert [u["username"] for u in body] == ["ada"]

    async def test_get_user_by_id_and_its_404(self, db_session):
        set_identity_provider(BusinessSchemaProvider({"sub-1": _profile(id="biz-1")}))

        with TestClient(_app(db_session, _caller())) as client:
            assert client.get("/api/v1/users/biz-1").json()["id"] == "biz-1"
            missing = client.get("/api/v1/users/nope")

        assert missing.status_code == 404
        assert missing.json()["detail"] == "User not found"

    async def test_get_user_by_id_still_returns_a_deactivated_user(self, db_session):
        """Pinning a pre-existing asymmetry rather than quietly changing it:
        `GET /users` filters on `is_active`, `GET /users/{id}` does not. Recorded
        here so a future change to either is a deliberate one."""
        set_identity_provider(
            BusinessSchemaProvider({"sub-1": _profile(id="biz-1", is_active=False)})
        )
        with TestClient(_app(db_session, _caller())) as client:
            assert client.get("/api/v1/users/biz-1").status_code == 200

    async def test_auth_me_creates_through_the_provider_and_emits_once(self, db_session):
        provider = BusinessSchemaProvider()
        set_identity_provider(provider)

        with TestClient(_app(db_session, _caller())) as client:
            first = client.get("/api/v1/auth/me")

        assert first.status_code == 200
        assert first.json()["email"] == "ada@example.com"
        # The event must be buffered on the *request* session — a provider
        # emitting it on its own session would buffer where nothing publishes.
        events = pending_events(db_session)
        assert [e.detail_type for e in events] == ["user.created"]
        assert await _core_users_count(db_session) == 0

    async def test_auth_me_does_not_re_emit_for_a_returning_user(self, db_session):
        provider = BusinessSchemaProvider({"sub-1": _profile()})
        set_identity_provider(provider)

        with TestClient(_app(db_session, _caller())) as client:
            assert client.get("/api/v1/auth/me").status_code == 200

        assert pending_events(db_session) == []
        assert provider.calls.count("upsert_profile") == 1

    async def test_auth_me_records_the_login(self, db_session):
        provider = BusinessSchemaProvider({"sub-1": _profile(last_login_at=None)})
        set_identity_provider(provider)

        with TestClient(_app(db_session, _caller())) as client:
            client.get("/api/v1/auth/me")

        assert provider.store["sub-1"].last_login_at is not None


class TestDefaultProviderProfileMethods:
    """The default must keep behaving exactly as the routers did before."""

    async def _seed(self, db: AsyncSession, **kwargs):
        from api.models.user import User

        user = User(**{"tenant_id": "default", "is_active": True, **kwargs})
        db.add(user)
        await db.flush()
        return user

    async def test_list_is_active_only_and_oldest_first(self, db_session):
        await self._seed(db_session, cognito_sub="s1", email="a@x.com", username="a")
        await self._seed(db_session, cognito_sub="s2", email="b@x.com", username="b")
        await self._seed(
            db_session, cognito_sub="s3", email="c@x.com", username="c", is_active=False
        )

        profiles = await DefaultIdentityProvider().list_profiles(db_session, "default")

        assert [p.username for p in profiles] == ["a", "b"]

    async def test_upsert_creates_a_fully_materialised_profile(self, db_session):
        """The DTO must carry id and timestamps. Before the seam, `/auth/me`
        returned a live uncommitted ORM object that FastAPI serialised before the
        commit, which is why the flush/refresh there was load-bearing."""
        profile, created = await DefaultIdentityProvider().upsert_profile(
            db_session,
            subject="s9",
            tenant_id="default",
            email="new@x.com",
            username="new",
            fields={"last_login_at": _NOW},
        )

        assert created is True
        assert profile.id and profile.created_at and profile.updated_at
        assert profile.is_active is True
        assert profile.last_login_at == _NOW

    async def test_upsert_updates_without_rewriting_identity_columns(self, db_session):
        await self._seed(db_session, cognito_sub="s1", email="orig@x.com", username="orig")

        profile, created = await DefaultIdentityProvider().upsert_profile(
            db_session,
            subject="s1",
            tenant_id="default",
            email="attacker@x.com",
            username="attacker",
            fields={"job_role": "Founder"},
        )

        assert created is False
        assert profile.job_role == "Founder"
        # Cognito owns these; a login must not quietly rewrite them.
        assert profile.email == "orig@x.com"
        assert profile.username == "orig"

    async def test_upsert_rejects_a_field_outside_the_allow_list(self, db_session):
        """The pre-seam admin router `setattr`'d whatever the request carried."""
        with pytest.raises(ValueError, match="not writable profile fields"):
            await DefaultIdentityProvider().upsert_profile(
                db_session,
                subject="s1",
                tenant_id="default",
                email="a@x.com",
                username="a",
                fields={"is_active": False, "cognito_sub": "hijack"},
            )

    async def test_set_active_on_a_missing_record_is_success(self, db_session):
        # A user Cognito knows about who has never logged in has no record;
        # suspending them must still work. Pinned because a provider that 404'd
        # here would break suspend and delete.
        await DefaultIdentityProvider().set_active(db_session, "never-logged-in", False)

    async def test_set_active_mirrors_onto_an_existing_record(self, db_session):
        await self._seed(db_session, cognito_sub="s1", email="a@x.com", username="a")

        await DefaultIdentityProvider().set_active(db_session, "s1", False)

        profile = await DefaultIdentityProvider().get_profile(db_session, "s1")
        assert profile is not None
        assert profile.is_active is False

    async def test_get_profiles_batches_and_omits_the_absent(self, db_session):
        await self._seed(db_session, cognito_sub="s1", email="a@x.com", username="a")

        found = await DefaultIdentityProvider().get_profiles(db_session, ["s1", "missing", ""])

        assert set(found) == {"s1"}


class TestCompliance:
    """`middleware/auth.py` has been guarded this way since the seam landed
    (`test_identity_seam.py`); the profile routers were not, which is how they
    drifted back to `public.users` a release after the ADR was accepted."""

    @pytest.mark.parametrize(
        "module",
        ["api.routers.users", "api.routers.auth", "api.routers.admin.users"],
    )
    def test_profile_routers_do_not_import_the_core_user_model(self, module: str) -> None:
        """Checked over the AST, not with a substring search.

        `test_identity_seam.py` greps `middleware/auth.py` for `"import User"`,
        which works there only because that file happens never to mention it. Here
        the same grep matched `from ..identity import UserProfile, ...` — a
        legitimate import of the very DTO that *replaced* the model — and matched
        prose in a comment explaining the change. A guard that fires on the fix it
        is meant to protect gets deleted by the next person, so this one asks the
        question it actually means: is the `User` model imported?
        """
        import ast
        import importlib
        from pathlib import Path

        source_file = importlib.import_module(module).__file__
        assert source_file is not None, f"{module} has no source file to inspect"
        tree = ast.parse(Path(source_file).read_text())

        offenders = [
            f"line {node.lineno}: from {'.' * node.level}{node.module or ''} import "
            + ", ".join(a.name for a in node.names)
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("models.user")
        ]
        offenders += [
            f"line {node.lineno}: import {alias.name}"
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
            if alias.name.endswith("models.user")
        ]

        # Not merely untidy: a module-scope import of a model a deployment
        # deleted takes the whole API down at startup, over a class the request
        # path would never have touched.
        assert offenders == [], f"{module} still imports the Core user model: {offenders}"
