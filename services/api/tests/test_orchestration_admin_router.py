"""Integration tests for the user-facing workflow-definition CRUD router
(/api/v1/orchestration/workflows). Drives real HTTP through FastAPI's TestClient
against in-memory SQLite. Auth is faked by overriding require_auth (require_admin
depends on it): an admin caller for the happy paths, a non-admin for the 403.

The StaticPool/in-memory-SQLite fixture mirrors test_core_crud_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    WorkflowDefinition,
    WorkflowRun,
)
from api.routers import orchestration

_BASE = "/api/v1/orchestration/workflows"


def _caller(
    tenant_id: str = "default", roles: list[str] | None = None
) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"] if roles is None else roles,
    )


def _valid_body(**over) -> dict:
    body = {
        "name": "Notify sales",
        "trigger_source": "biffo.core",
        "trigger_detail_type": "demo.requested",
        "action_type": "email",
        "action_config": {
            "from": "no-reply@example.com",
            "to": "sales@example.com",
            "subject": "New demo from {company}",
            "body": "Contact {email}",
        },
        "enabled": True,
    }
    body.update(over)
    return body


@pytest.fixture
def app() -> Generator[tuple[FastAPI, async_sessionmaker], None, None]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    fastapi = FastAPI()
    fastapi.include_router(orchestration.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: _caller()

    yield fastapi, session_factory

    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    fastapi, _ = app
    return TestClient(fastapi)


def test_create_then_list_and_get(client: TestClient):
    created = client.post(_BASE, json=_valid_body())
    assert created.status_code == 201
    row = created.json()
    assert row["name"] == "Notify sales"
    assert row["enabled"] is True
    assert row["id"]

    listed = client.get(_BASE)
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()] == [row["id"]]

    got = client.get(f"{_BASE}/{row['id']}")
    assert got.status_code == 200
    assert got.json()["action_config"]["to"] == "sales@example.com"


def test_create_rejects_invalid_action_config(client: TestClient):
    body = _valid_body(
        action_config={"from": "no-reply@example.com"}
    )  # missing to/subject/body
    resp = client.post(_BASE, json=body)
    assert resp.status_code == 422


def test_create_rejects_bad_email(client: TestClient):
    body = _valid_body(
        action_config={
            "from": "not-an-email",
            "to": "sales@example.com",
            "subject": "s",
            "body": "b",
        }
    )
    assert client.post(_BASE, json=body).status_code == 422


def test_create_rejects_unknown_trigger(client: TestClient):
    assert (
        client.post(_BASE, json=_valid_body(trigger_detail_type="nope")).status_code
        == 422
    )


def test_update_and_toggle(client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()

    updated = client.put(
        f"{_BASE}/{row['id']}", json=_valid_body(name="Renamed", enabled=True)
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"

    toggled = client.post(f"{_BASE}/{row['id']}/enabled", json={"enabled": False})
    assert toggled.status_code == 200
    assert toggled.json()["enabled"] is False


def test_delete(client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()
    assert client.delete(f"{_BASE}/{row['id']}").status_code == 204
    assert client.get(f"{_BASE}/{row['id']}").status_code == 404


def test_missing_returns_404(client: TestClient):
    assert client.get(f"{_BASE}/does-not-exist").status_code == 404
    assert client.delete(f"{_BASE}/does-not-exist").status_code == 404


def test_catalog(client: TestClient):
    resp = client.get(f"{_BASE}/catalog")
    assert resp.status_code == 200
    body = resp.json()
    assert any(t["detail_type"] == "demo.requested" for t in body["triggers"])
    assert any(a["type"] == "email" for a in body["actions"])


def test_tenant_isolation(app, client: TestClient):
    _, session_factory = app

    async def _seed_other_tenant() -> None:
        async with session_factory() as session:
            session.add(
                WorkflowDefinition(
                    tenant_id="other-tenant",
                    name="Other tenant workflow",
                    trigger_source="biffo.core",
                    trigger_detail_type="demo.requested",
                    action_type="email",
                    action_config={},
                    enabled=True,
                )
            )
            await session.commit()

    asyncio.run(_seed_other_tenant())

    # Caller is tenant "default" — must not see the other tenant's row.
    assert client.get(_BASE).json() == []


def test_non_admin_is_forbidden(app, client: TestClient):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=[])
    assert client.get(_BASE).status_code == 403
    assert client.post(_BASE, json=_valid_body()).status_code == 403
