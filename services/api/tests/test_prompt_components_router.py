"""Integration tests for the prompt-component admin CRUD router (ADR-0015 §1).

Drives real HTTP through FastAPI's TestClient against in-memory SQLite. Auth is
faked by overriding require_auth (require_admin depends on it): an admin caller
for the happy paths, a non-admin for the 403. The StaticPool/in-memory-SQLite
fixture mirrors test_orchestration_admin_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.prompt_component import PromptComponent  # noqa: F401 — registers the table
from api.routers.admin import prompt_components
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/admin/prompt-components"


def _caller(tenant_id: str = "default", roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"] if roles is None else roles,
    )


def _body(**over) -> dict:
    body = {
        "name": "house-style",
        "description": "Standard tone",
        "body": "State confidence per claim. Cite sources.",
        "variables": [],
    }
    body.update(over)
    return body


@pytest.fixture
def caller_box() -> dict:
    """Mutable holder so a test can swap the authenticated caller (tenant/role)."""
    return {"caller": _caller()}


@pytest.fixture
def app(caller_box) -> Generator[FastAPI]:
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

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    fastapi = FastAPI()
    fastapi.include_router(prompt_components.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: caller_box["caller"]

    yield fastapi

    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


def test_create_then_list_and_get(client: TestClient):
    created = client.post(_BASE, json=_body())
    assert created.status_code == 201
    row = created.json()
    assert row["name"] == "house-style"
    assert row["variables"] == []
    assert row["id"]

    listed = client.get(_BASE)
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()] == [row["id"]]

    got = client.get(f"{_BASE}/{row['id']}")
    assert got.status_code == 200
    assert got.json()["body"] == "State confidence per claim. Cite sources."


def test_update_changes_the_body_in_place(client: TestClient):
    row = client.post(_BASE, json=_body()).json()
    updated = client.put(f"{_BASE}/{row['id']}", json=_body(body="Be concise."))
    assert updated.status_code == 200
    assert updated.json()["body"] == "Be concise."


def test_delete_removes_the_component(client: TestClient):
    row = client.post(_BASE, json=_body()).json()
    assert client.delete(f"{_BASE}/{row['id']}").status_code == 204
    assert client.get(f"{_BASE}/{row['id']}").status_code == 404


def test_a_duplicate_name_is_a_409(client: TestClient):
    assert client.post(_BASE, json=_body()).status_code == 201
    dup = client.post(_BASE, json=_body(description="different, same name"))
    assert dup.status_code == 409


def test_renaming_onto_an_existing_name_is_a_409(client: TestClient):
    client.post(_BASE, json=_body(name="a"))
    row_b = client.post(_BASE, json=_body(name="b")).json()
    clash = client.put(f"{_BASE}/{row_b['id']}", json=_body(name="a"))
    assert clash.status_code == 409


def test_a_parameterised_component_round_trips_its_variables(client: TestClient):
    created = client.post(
        _BASE,
        json=_body(
            name="lead-scorer",
            body="Score leads for {{region}}.",
            variables=[{"name": "region", "required": True}],
        ),
    )
    assert created.status_code == 201
    assert created.json()["variables"] == [{"name": "region", "required": True}]


def test_a_malformed_variable_declaration_is_a_422(client: TestClient):
    resp = client.post(_BASE, json=_body(variables=[{"name": "not a name"}]))
    assert resp.status_code == 422


def test_a_component_in_another_tenant_is_invisible(client: TestClient, caller_box):
    # Author as tenant-a.
    caller_box["caller"] = _caller(tenant_id="tenant-a")
    row = client.post(_BASE, json=_body(name="secret-clause")).json()

    # tenant-b sees nothing and cannot fetch it by id (404, not 403 — it is
    # indistinguishable from a component that does not exist).
    caller_box["caller"] = _caller(tenant_id="tenant-b")
    assert client.get(_BASE).json() == []
    assert client.get(f"{_BASE}/{row['id']}").status_code == 404
    assert client.delete(f"{_BASE}/{row['id']}").status_code == 404

    # And tenant-b may reuse the name freely — uniqueness is per tenant.
    assert client.post(_BASE, json=_body(name="secret-clause")).status_code == 201


def test_a_non_admin_is_forbidden(client: TestClient, caller_box):
    caller_box["caller"] = _caller(roles=["viewer"])
    assert client.get(_BASE).status_code == 403
    assert client.post(_BASE, json=_body()).status_code == 403
