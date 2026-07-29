"""Tests for agent-run creation with registry resolution (biffo-template#910).

When an orchestration workflow's agent action has no ``instructions``, Core
resolves them from the plugin_chat_agents registry by agent_name.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.config import settings
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table
from api.models.base import Base
from api.models.plugin_chat_agent import PluginChatAgent
from api.routers import internal_agents
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

TENANT = "default"


@pytest.fixture
def app() -> Generator[tuple[FastAPI, async_sessionmaker]]:
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

    def fake_service_principal():
        from api.middleware.service_auth import ServicePrincipal

        return ServicePrincipal(
            tenant_id=TENANT,
            principal_arn="arn:aws:iam::123456789012:role/test-principal",
        )

    fastapi = FastAPI()
    fastapi.include_router(internal_agents.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: AuthenticatedUser(
        sub="test", email="test@example.com", username="test", tenant_id=TENANT, roles=["admin"]
    )
    from api.middleware.service_auth import require_service_principal

    fastapi.dependency_overrides[require_service_principal] = fake_service_principal

    yield fastapi, session_factory

    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    fastapi, _ = app
    return TestClient(fastapi)


async def _seed_agent(session: AsyncSession, **over) -> PluginChatAgent:
    """Seed a plugin chat agent for testing registry resolution."""
    fields = dict(
        tenant_id=TENANT,
        plugin_name="test-plugin",
        agent_key="demo-enricher",
        agent_name="demo-enricher",
        role="agent",
        system_prompt="You are a helpful demo enrichment assistant.",
        model="anthropic/claude-opus-4-8",
        required_group="default",
        active=True,
    )
    fields.update(over)
    agent = PluginChatAgent(**fields)
    session.add(agent)
    await session.flush()
    return agent


def test_create_request_omitting_instructions_resolves_from_registry(app, client):
    """When instructions are missing, resolve them from plugin_chat_agents."""
    fastapi, session_factory = app

    async def seed_and_post():
        async with session_factory() as session:
            await _seed_agent(session)
            await session.commit()

    asyncio.run(seed_and_post())

    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "demo-enricher",
            "definition_snapshot": {"model": "anthropic/claude-opus-4-8"},
            "input_payload": {"demo_request_id": "d1"},
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    # The resolved prompt text should be in the stored snapshot
    assert (
        body["definition_snapshot"]["instructions"]
        == "You are a helpful demo enrichment assistant."
    )
    assert body["agent_name"] == "demo-enricher"


def test_create_request_with_instructions_keeps_them_precedence(app, client):
    """When instructions are in the config, they take precedence over registry."""
    fastapi, session_factory = app

    async def seed_and_post():
        async with session_factory() as session:
            await _seed_agent(session)
            await session.commit()

    asyncio.run(seed_and_post())

    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "demo-enricher",
            "definition_snapshot": {
                "instructions": "Custom inline instructions.",
                "model": "anthropic/claude-opus-4-8",
            },
            "input_payload": {"demo_request_id": "d1"},
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    # The custom instructions should be preserved, not overwritten
    assert body["definition_snapshot"]["instructions"] == "Custom inline instructions."


def test_model_resolves_from_registry_when_snapshot_has_none(app, client):
    """A missing model resolves from the registry — even with instructions inline.

    The seeded model is deliberately **not** ``settings.agent_default_model``.
    Seeding the default here would make the assertion pass whether the value came
    from the registry or from the fallback, which is exactly how an editable but
    inert model field survives its own test.
    """
    fastapi, session_factory = app

    registry_model = "anthropic/claude-opus-4-8"
    assert registry_model != settings.agent_default_model

    async def seed_and_post():
        async with session_factory() as session:
            await _seed_agent(session, model=registry_model)
            await session.commit()

    asyncio.run(seed_and_post())

    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "demo-enricher",
            # Instructions supplied inline: the registry must still be consulted
            # for the model, which is the case that used to fall through to the
            # default without ever reading the row.
            "definition_snapshot": {
                "instructions": "Do the task.",
            },
            "input_payload": {},
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["definition_snapshot"]["model"] == registry_model
    # The inline prompt still wins over the registry's.
    assert body["definition_snapshot"]["instructions"] == "Do the task."


def test_model_stays_when_snapshot_has_one(app, client):
    """When model is in the snapshot, leave it alone."""
    fastapi, session_factory = app

    async def seed_and_post():
        async with session_factory() as session:
            await _seed_agent(session, model="moonshotai/kimi-k3")
            await session.commit()

    asyncio.run(seed_and_post())

    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "demo-enricher",
            "definition_snapshot": {
                "instructions": "Do the task.",
                "model": "anthropic/claude-opus-4-8",
            },
            "input_payload": {},
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    # The explicit model should be preserved
    assert body["definition_snapshot"]["model"] == "anthropic/claude-opus-4-8"


def test_no_active_registry_row_returns_422(app, client):
    """Missing or inactive registry row should return 422."""
    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "nonexistent-agent",
            "definition_snapshot": {},
            "input_payload": {},
        },
    )

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "nonexistent-agent" in detail


def test_tenant_scoping_prevents_cross_tenant_resolution(app, client):
    """A registry row in another tenant should not be resolved."""
    fastapi, session_factory = app

    async def seed_and_post():
        async with session_factory() as session:
            # Seed agent for a different tenant
            await _seed_agent(session, tenant_id="other-tenant")
            await session.commit()

    asyncio.run(seed_and_post())

    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "demo-enricher",
            "definition_snapshot": {},
            "input_payload": {},
        },
    )

    # Should be 422 because the agent doesn't exist in the caller's tenant
    assert resp.status_code == 422


def test_default_model_when_no_registry_and_instructions_inline(app, client):
    """When no model and no registry row, but instructions inline, use agent_default_model."""
    fastapi, session_factory = app

    resp = client.post(
        "/api/v1/internal/agent-runs",
        json={
            "agent_name": "nonexistent-agent",
            "definition_snapshot": {
                "instructions": "Do the task inline.",
            },
            "input_payload": {},
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    # The model should be filled from the default — read from settings rather than
    # restated, so this test cannot drift from the value it is asserting about.
    assert body["definition_snapshot"]["model"] == settings.agent_default_model
    # Instructions should be preserved
    assert body["definition_snapshot"]["instructions"] == "Do the task inline."
