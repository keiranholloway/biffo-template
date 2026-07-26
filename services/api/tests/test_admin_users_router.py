"""Tests for the admin user-management router (/api/v1/admin/users).

Drives the HTTP layer via TestClient against a moto fake Cognito pool and an
in-memory SQLite DB (for the is_active mirror), mirroring the harness in
test_core_crud_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import boto3
import pytest
from api.cognito import CognitoAdmin
from api.database import get_db
from api.dependencies import get_cognito_admin
from api.events.emit import is_declared, pending_events
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.user import User
from api.routers.admin import users as admin_users
from fastapi import FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

REGION = "us-east-1"
_BASE = "/api/v1/admin/users"


def _caller(roles: list[str]) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id="default",
        roles=roles,
    )


@pytest.fixture
def harness() -> Generator[dict]:
    with mock_aws():
        client = boto3.client("cognito-idp", region_name=REGION)
        pool_id = client.create_user_pool(PoolName="test")["UserPool"]["Id"]
        for group in ("admin", "editor", "viewer"):
            client.create_group(UserPoolId=pool_id, GroupName=group)
        cog = CognitoAdmin(client=client, user_pool_id=pool_id, region=REGION)

        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        asyncio.run(_create_tables(engine))
        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        # Capture the events the request buffered on the session (emit_event, ADR-0002)
        # after commit — the real get_db publishes these, here we just record them so
        # tests can assert what would go on the bus.
        published: list = []

        async def override_get_db() -> AsyncGenerator[AsyncSession]:
            async with session_factory() as session:
                try:
                    yield session
                    await session.commit()
                    published.extend(pending_events(session))
                except Exception:
                    await session.rollback()
                    raise

        app = FastAPI()
        app.include_router(admin_users.router, prefix="/api/v1")
        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_cognito_admin] = lambda: cog
        app.dependency_overrides[require_auth] = lambda: _caller(["admin"])

        yield {
            "app": app,
            "client": TestClient(app),
            "cog": cog,
            "session_factory": session_factory,
            "published": published,
        }

        asyncio.run(engine.dispose())


async def _create_tables(engine) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _seed_db_user(session_factory, *, cognito_sub: str, email: str) -> None:
    async with session_factory() as session:
        session.add(User(cognito_sub=cognito_sub, email=email, username=email, is_active=True))
        await session.commit()


async def _db_is_active(session_factory, cognito_sub: str) -> bool | None:
    async with session_factory() as session:
        result = await session.execute(
            select(User.is_active).where(User.cognito_sub == cognito_sub)
        )
        return result.scalar_one_or_none()


# --- create ------------------------------------------------------------------


def test_create_user_returns_201(harness):
    resp = harness["client"].post(
        _BASE,
        json={
            "email": "alice@example.com",
            "given_name": "Alice",
            "family_name": "Anderson",
            "suppress_invite_email": True,
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["email"] == "alice@example.com"
    assert body["sub"]
    assert body["groups"] == []


def test_create_user_with_initial_groups(harness):
    resp = harness["client"].post(
        _BASE,
        json={
            "email": "bob@example.com",
            "given_name": "Bob",
            "family_name": "Baker",
            "groups": ["editor"],
            "suppress_invite_email": True,
        },
    )
    assert resp.status_code == 201
    assert resp.json()["groups"] == ["editor"]


def test_create_duplicate_user_returns_409(harness):
    payload = {
        "email": "carol@example.com",
        "given_name": "Carol",
        "family_name": "Chen",
        "suppress_invite_email": True,
    }
    assert harness["client"].post(_BASE, json=payload).status_code == 201
    assert harness["client"].post(_BASE, json=payload).status_code == 409


# --- authorization -----------------------------------------------------------


def test_non_admin_caller_is_forbidden(harness):
    harness["app"].dependency_overrides[require_auth] = lambda: _caller([])
    resp = harness["client"].post(
        _BASE,
        json={
            "email": "eve@example.com",
            "given_name": "Eve",
            "family_name": "Ellis",
            "suppress_invite_email": True,
        },
    )
    assert resp.status_code == 403


# --- read --------------------------------------------------------------------


def test_list_and_get_users(harness):
    harness["cog"].create_user(
        email="dave@example.com", given_name="Dave", family_name="Davis", suppress_invite_email=True
    )

    listing = harness["client"].get(_BASE)
    assert listing.status_code == 200
    emails = {u["email"] for u in listing.json()["users"]}
    assert "dave@example.com" in emails

    got = harness["client"].get(f"{_BASE}/dave@example.com")
    assert got.status_code == 200
    assert got.json()["email"] == "dave@example.com"


def test_get_missing_user_returns_404(harness):
    assert harness["client"].get(f"{_BASE}/nobody@example.com").status_code == 404


# --- group membership --------------------------------------------------------


def test_add_and_remove_group(harness):
    harness["cog"].create_user(
        email="heidi@example.com",
        given_name="Heidi",
        family_name="Hill",
        suppress_invite_email=True,
    )

    added = harness["client"].post(f"{_BASE}/heidi@example.com/groups", json={"group": "editor"})
    assert added.status_code == 200
    assert "editor" in added.json()["groups"]

    removed = harness["client"].delete(f"{_BASE}/heidi@example.com/groups/editor")
    assert removed.status_code == 200
    assert "editor" not in removed.json()["groups"]


# --- suspend / reactivate / delete + DB mirror -------------------------------


def test_suspend_disables_and_mirrors_is_active(harness):
    user = harness["cog"].create_user(
        email="frank@example.com",
        given_name="Frank",
        family_name="Foster",
        suppress_invite_email=True,
    )
    asyncio.run(
        _seed_db_user(harness["session_factory"], cognito_sub=user["sub"], email=user["email"])
    )

    resp = harness["client"].post(f"{_BASE}/frank@example.com/suspend")
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False
    assert asyncio.run(_db_is_active(harness["session_factory"], user["sub"])) is False


def test_reactivate_enables_and_mirrors_is_active(harness):
    user = harness["cog"].create_user(
        email="grace@example.com",
        given_name="Grace",
        family_name="Green",
        suppress_invite_email=True,
    )
    asyncio.run(
        _seed_db_user(harness["session_factory"], cognito_sub=user["sub"], email=user["email"])
    )
    harness["client"].post(f"{_BASE}/grace@example.com/suspend")

    resp = harness["client"].post(f"{_BASE}/grace@example.com/reactivate")
    assert resp.status_code == 200
    assert resp.json()["enabled"] is True
    assert asyncio.run(_db_is_active(harness["session_factory"], user["sub"])) is True


def test_delete_removes_from_cognito_and_deactivates_db_row(harness):
    user = harness["cog"].create_user(
        email="ivan@example.com",
        given_name="Ivan",
        family_name="Ivanov",
        suppress_invite_email=True,
    )
    asyncio.run(
        _seed_db_user(harness["session_factory"], cognito_sub=user["sub"], email=user["email"])
    )

    resp = harness["client"].delete(f"{_BASE}/ivan@example.com")
    assert resp.status_code == 204
    assert harness["client"].get(f"{_BASE}/ivan@example.com").status_code == 404
    assert asyncio.run(_db_is_active(harness["session_factory"], user["sub"])) is False


def test_suspend_without_db_row_still_succeeds(harness):
    """A user provisioned but never logged in has no DB row — the mirror is a
    no-op, not an error."""
    harness["cog"].create_user(
        email="judy@example.com", given_name="Judy", family_name="Jones", suppress_invite_email=True
    )
    resp = harness["client"].post(f"{_BASE}/judy@example.com/suspend")
    assert resp.status_code == 200


# --- lifecycle state-change events (ADR-0002, #225) --------------------------


def _only_event(harness):
    published = harness["published"]
    assert len(published) == 1, f"expected exactly one event, got {published}"
    event = published[0]
    # Every emitted event must be declared in code — the compliance gate.
    assert is_declared(event.source, event.detail_type)
    return event


def test_suspend_emits_user_suspended_event(harness):
    user = harness["cog"].create_user(
        email="kate@example.com", given_name="Kate", family_name="King", suppress_invite_email=True
    )
    harness["client"].post(f"{_BASE}/kate@example.com/suspend")

    event = _only_event(harness)
    assert (event.source, event.detail_type) == ("biffo.core", "user.suspended")
    assert event.payload["cognito_sub"] == user["sub"]
    assert event.payload["email"] == "kate@example.com"
    assert event.tenant_id == "default"


def test_reactivate_emits_user_reactivated_event(harness):
    harness["cog"].create_user(
        email="leo@example.com", given_name="Leo", family_name="Lopez", suppress_invite_email=True
    )
    harness["client"].post(f"{_BASE}/leo@example.com/suspend")
    harness["published"].clear()  # drop the suspend event; assert only reactivate

    harness["client"].post(f"{_BASE}/leo@example.com/reactivate")

    event = _only_event(harness)
    assert (event.source, event.detail_type) == ("biffo.core", "user.reactivated")


def test_delete_emits_user_deleted_event(harness):
    user = harness["cog"].create_user(
        email="mia@example.com", given_name="Mia", family_name="Moore", suppress_invite_email=True
    )
    harness["client"].delete(f"{_BASE}/mia@example.com")

    event = _only_event(harness)
    assert (event.source, event.detail_type) == ("biffo.core", "user.deleted")
    assert event.payload["cognito_sub"] == user["sub"]


def test_suspend_without_db_row_still_emits(harness):
    """The event reflects the admin action, so it fires even when no DB mirror
    row exists to update."""
    harness["cog"].create_user(
        email="nina@example.com", given_name="Nina", family_name="Novak", suppress_invite_email=True
    )
    harness["client"].post(f"{_BASE}/nina@example.com/suspend")

    event = _only_event(harness)
    assert event.detail_type == "user.suspended"
