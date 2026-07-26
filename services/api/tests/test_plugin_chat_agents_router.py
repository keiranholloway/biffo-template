"""Integration tests for the plugin-chat-agent admin CRUD router (ADR-0017 seam #1 extension).

Drives real HTTP through FastAPI's TestClient against in-memory SQLite. Auth is
faked by overriding require_auth (require_admin depends on it): an admin caller
for the happy paths, a non-admin for the 403. The StaticPool/in-memory-SQLite
fixture mirrors test_prompt_components_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.plugin_chat_agent import PluginChatAgent  # noqa: F401 — registers the table
from api.routers.admin import plugin_chat_agents
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/admin/plugins/test-plugin/chat-agents"


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
        "agent_key": "test-agent",
        "agent_name": "Test Agent",
        "role": "founder",
        "system_prompt": "You are a helpful assistant.",
        "model": "anthropic/claude-sonnet-4",
        "required_group": "founder",
        "active": True,
        "max_history_messages": 40,
        "max_output_tokens": 1024,
        "timeout_seconds": 20.0,
    }
    body.update(over)
    return body


def _update_body(**over) -> dict:
    """Body for PUT requests (no agent_key, which is in the path)."""
    body = {
        "agent_name": "Test Agent",
        "role": "founder",
        "system_prompt": "You are a helpful assistant.",
        "model": "anthropic/claude-sonnet-4",
        "required_group": "founder",
        "active": True,
        "max_history_messages": 40,
        "max_output_tokens": 1024,
        "timeout_seconds": 20.0,
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
    fastapi.include_router(plugin_chat_agents.router, prefix="/api/v1")
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
    assert row["agent_key"] == "test-agent"
    assert row["agent_name"] == "Test Agent"
    assert row["id"]

    listed = client.get(_BASE)
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()] == [row["id"]]

    got = client.get(f"{_BASE}/test-agent")
    assert got.status_code == 200
    assert got.json()["system_prompt"] == "You are a helpful assistant."


def test_update_changes_the_agent_in_place(client: TestClient):
    row = client.post(_BASE, json=_body()).json()
    updated = client.put(
        f"{_BASE}/{row['agent_key']}",
        json=_update_body(system_prompt="Be concise and direct."),
    )
    assert updated.status_code == 200
    assert updated.json()["system_prompt"] == "Be concise and direct."


def test_delete_removes_the_agent(client: TestClient):
    row = client.post(_BASE, json=_body()).json()
    assert client.delete(f"{_BASE}/{row['agent_key']}").status_code == 204
    assert client.get(f"{_BASE}/{row['agent_key']}").status_code == 404


def test_a_duplicate_agent_key_is_a_409(client: TestClient):
    assert client.post(_BASE, json=_body()).status_code == 201
    dup = client.post(_BASE, json=_body(agent_name="Different Name"))
    assert dup.status_code == 409


def test_list_is_ordered_by_agent_key(client: TestClient):
    client.post(_BASE, json=_body(agent_key="z-agent"))
    client.post(_BASE, json=_body(agent_key="a-agent"))
    client.post(_BASE, json=_body(agent_key="m-agent"))

    listed = client.get(_BASE).json()
    assert [r["agent_key"] for r in listed] == ["a-agent", "m-agent", "z-agent"]


def test_an_agent_in_another_tenant_is_invisible(client: TestClient, caller_box):
    # Author as tenant-a.
    caller_box["caller"] = _caller(tenant_id="tenant-a")
    row = client.post(_BASE, json=_body(agent_key="secret-agent")).json()

    # tenant-b sees nothing and cannot fetch it by key (404, not 403 — it is
    # indistinguishable from an agent that does not exist).
    caller_box["caller"] = _caller(tenant_id="tenant-b")
    assert client.get(_BASE).json() == []
    assert client.get(f"{_BASE}/{row['agent_key']}").status_code == 404
    assert client.delete(f"{_BASE}/{row['agent_key']}").status_code == 404

    # And tenant-b may reuse the key freely — uniqueness is per tenant.
    assert client.post(_BASE, json=_body(agent_key="secret-agent")).status_code == 201


def test_a_non_admin_is_forbidden(client: TestClient, caller_box):
    caller_box["caller"] = _caller(roles=["viewer"])
    assert client.get(_BASE).status_code == 403
    assert client.post(_BASE, json=_body()).status_code == 403


def test_get_update_delete_nonexistent_agent_is_404(client: TestClient):
    assert client.get(f"{_BASE}/no-such-agent").status_code == 404
    assert client.put(f"{_BASE}/no-such-agent", json=_update_body()).status_code == 404
    assert client.delete(f"{_BASE}/no-such-agent").status_code == 404


def test_inactive_agents_are_still_stored_but_visible(client: TestClient):
    """Inactive agents are stored and returned like any other; live resolution
    respects the active flag to hide them from runtime lookups."""
    created = client.post(_BASE, json=_body(active=False))
    assert created.status_code == 201
    row = created.json()
    assert row["active"] is False

    listed = client.get(_BASE).json()
    assert len(listed) == 1
    assert listed[0]["active"] is False
