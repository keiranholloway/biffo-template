"""Tests for plugin chat agent history (ADR-0017 seam #1 extension M2).

History records the previous values whenever an agent is edited, so the full
timeline of changes can be reconstructed with author, timestamp, and version.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.plugin_chat_agent import PluginChatAgent  # noqa: F401 — registers the table
from api.models.plugin_chat_agent_history import PluginChatAgentHistory  # noqa: F401
from api.routers.admin import plugin_chat_agents
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/admin/plugins/test-plugin/chat-agents"


def _caller(tenant_id: str = "default", email: str = "admin@example.com") -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email=email,
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"],
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
    """Body for PUT requests."""
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
    """Mutable holder so a test can swap the authenticated caller."""
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


def test_update_writes_history_with_previous_values(client: TestClient):
    """When an agent is edited, history records the previous values."""
    client.post(_BASE, json=_body()).json()

    # Update the agent
    updated = client.put(
        f"{_BASE}/test-agent",
        json=_update_body(system_prompt="Updated prompt"),
    )
    assert updated.status_code == 200

    # Fetch history
    hist_resp = client.get(f"{_BASE}/test-agent/history")
    assert hist_resp.status_code == 200
    history = hist_resp.json()

    assert len(history) == 1
    entry = history[0]
    # The previous value (what was there before the edit)
    assert entry["system_prompt"] == "You are a helpful assistant."
    # The new value is now in the current row
    current = client.get(f"{_BASE}/test-agent").json()
    assert current["system_prompt"] == "Updated prompt"


def test_history_entry_records_author_and_timestamp(client: TestClient):
    """History records changed_by (the admin's email) and created_at."""
    client.post(_BASE, json=_body())
    client.put(
        f"{_BASE}/test-agent",
        json=_update_body(system_prompt="Changed"),
    )

    hist_resp = client.get(f"{_BASE}/test-agent/history")
    history = hist_resp.json()

    entry = history[0]
    assert entry["changed_by"] == "admin@example.com"
    assert entry["created_at"] is not None  # ISO 8601 string


def test_unchanged_put_writes_no_history(client: TestClient):
    """A PUT with identical values does not create a history row."""
    client.post(_BASE, json=_body())

    # Update with identical values
    client.put(f"{_BASE}/test-agent", json=_update_body())

    hist_resp = client.get(f"{_BASE}/test-agent/history")
    history = hist_resp.json()

    # No history row should exist
    assert len(history) == 0


def test_successive_edits_produce_incrementing_versions(client: TestClient):
    """Multiple edits create version 1, 2, 3, etc."""
    client.post(_BASE, json=_body())

    # First edit
    client.put(
        f"{_BASE}/test-agent",
        json=_update_body(agent_name="Version 1"),
    )

    # Second edit
    client.put(
        f"{_BASE}/test-agent",
        json=_update_body(agent_name="Version 2"),
    )

    # Third edit
    client.put(
        f"{_BASE}/test-agent",
        json=_update_body(agent_name="Version 3"),
    )

    hist_resp = client.get(f"{_BASE}/test-agent/history")
    history = hist_resp.json()

    assert len(history) == 3
    # Newest first: version 3, 2, 1
    assert history[0]["version"] == 3
    assert history[1]["version"] == 2
    assert history[2]["version"] == 1


def test_history_endpoint_returns_newest_first(client: TestClient):
    """History is ordered by version descending (newest first)."""
    client.post(_BASE, json=_body())

    # Make 3 edits
    for i in range(1, 4):
        client.put(
            f"{_BASE}/test-agent",
            json=_update_body(agent_name=f"Edit {i}"),
        )

    hist_resp = client.get(f"{_BASE}/test-agent/history")
    history = hist_resp.json()

    versions = [entry["version"] for entry in history]
    assert versions == [3, 2, 1]


def test_history_endpoint_is_tenant_scoped(client: TestClient, caller_box):
    """History from another tenant is not visible."""
    # Create agent in tenant-a
    caller_box["caller"] = _caller(tenant_id="tenant-a")
    client.post(_BASE, json=_body()).json()

    # Edit it to create history
    client.put(
        f"{_BASE}/test-agent",
        json=_update_body(system_prompt="Secret prompt"),
    )

    # Switch to tenant-b
    caller_box["caller"] = _caller(tenant_id="tenant-b")

    # tenant-b cannot fetch history for tenant-a's agent (404)
    hist_resp = client.get(f"{_BASE}/test-agent/history")
    assert hist_resp.status_code == 404

    # Even if tenant-b creates its own agent with the same key
    client.post(_BASE, json=_body())
    hist_resp = client.get(f"{_BASE}/test-agent/history")
    assert hist_resp.status_code == 200
    history = hist_resp.json()

    # tenant-b's history is empty (no edits made)
    assert len(history) == 0


def test_history_endpoint_404_for_nonexistent_agent(client: TestClient):
    """Fetching history for a non-existent agent returns 404."""
    resp = client.get(f"{_BASE}/no-such-agent/history")
    assert resp.status_code == 404


def test_history_denormalization_survives_agent_deletion(client: TestClient):
    """History records plugin_name and agent_key so it survives row deletion."""
    agent = client.post(_BASE, json=_body()).json()

    # Edit to create history
    client.put(
        f"{_BASE}/test-agent",
        json=_update_body(system_prompt="Changed"),
    )

    # Verify history exists
    hist_resp = client.get(f"{_BASE}/test-agent/history")
    history = hist_resp.json()
    assert len(history) == 1
    entry = history[0]

    # These should be denormalised copies (not foreign keys)
    assert entry["plugin_name"] == "test-plugin"
    assert entry["agent_key"] == "test-agent"
    assert entry["plugin_chat_agent_id"] == agent["id"]
