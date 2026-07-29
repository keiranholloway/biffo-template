"""Integration tests for plugin config seeding (biffo-template#912, M3).

The POST /api/v1/internal/plugins/me/config/seed endpoint for plugins to
guarantee their own agent configs exist at startup, insert-if-absent,
without overwriting admin-edited rows.

This is the linchpin that makes "prompts live in the database" work: plugins
cold-start knowing their configs exist, and an operator's edits survive every
redeploy.
"""

import asyncio
from collections.abc import AsyncGenerator

from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.plugin_chat_agent import PluginChatAgent  # noqa: F401
from api.models.plugin_chat_agent_history import PluginChatAgentHistory  # noqa: F401
from api.routers import internal_plugin_config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool


def _build_app(*, principal: ServicePrincipal | None = None):
    """Build a test app with optional ServicePrincipal override."""
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

    app = FastAPI()
    app.include_router(internal_plugin_config.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db

    if principal is not None:
        app.dependency_overrides[require_service_principal] = lambda: principal

    return app, session_factory, engine


async def _insert_plugin_agents(session_factory, agents: list[dict]) -> None:
    """Insert test plugin_chat_agent rows into the in-memory DB."""
    async with session_factory() as session:
        for agent_spec in agents:
            agent = PluginChatAgent(
                tenant_id=agent_spec.get("tenant_id", "default"),
                plugin_name=agent_spec["plugin_name"],
                agent_key=agent_spec.get("agent_key", "test-key"),
                agent_name=agent_spec.get("agent_name", "Test Agent"),
                role=agent_spec["role"],
                system_prompt=agent_spec.get("system_prompt", "Test prompt"),
                model=agent_spec.get("model", "test/model"),
                required_group=agent_spec.get("required_group", "founder"),
                active=agent_spec.get("active", True),
                max_history_messages=agent_spec.get("max_history_messages", 40),
                max_output_tokens=agent_spec.get("max_output_tokens", 256),
                timeout_seconds=agent_spec.get("timeout_seconds", 10.0),
            )
            session.add(agent)
        await session.commit()


async def _get_row_count(session_factory, **filters) -> int:
    """Count PluginChatAgent rows matching the filters."""
    async with session_factory() as session:
        query = select(func.count(PluginChatAgent.id)).where(
            *(getattr(PluginChatAgent, k) == v for k, v in filters.items())
        )
        return await session.scalar(query) or 0


async def _get_system_prompt(session_factory, **filters) -> str | None:
    """Fetch the system_prompt of a single row matching the filters."""
    async with session_factory() as session:
        query = select(PluginChatAgent.system_prompt).where(
            *(getattr(PluginChatAgent, k) == v for k, v in filters.items())
        )
        return await session.scalar(query)


async def _get_history_count(session_factory, **filters) -> int:
    """Count PluginChatAgentHistory rows matching the filters."""
    async with session_factory() as session:
        query = select(func.count(PluginChatAgentHistory.id)).where(
            *(getattr(PluginChatAgentHistory, k) == v for k, v in filters.items())
        )
        return await session.scalar(query) or 0


def test_seeding_creates_a_nonexistent_role():
    """Seeding a role that does not exist creates it with the supplied values."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "ideation-analyst",
                "agent_name": "Ideation Analyst",
                "role": "analyst",
                "system_prompt": "Analyze ideas.",
                "model": "claude-3-sonnet",
                "required_group": "founder",
                "active": True,
                "max_history_messages": 40,
                "max_output_tokens": 1024,
                "timeout_seconds": 20.0,
            }
        ],
    )

    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert len(result) == 1
    assert result[0]["role"] == "analyst"
    assert result[0]["created"] is True

    # Verify the row was actually created.
    row_count = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
            agent_key="ideation-analyst",
        )
    )
    assert row_count == 1

    asyncio.run(engine.dispose())


def test_seeding_a_nonexistent_role_preserves_admin_edits():
    """THE CRITICAL TEST: An existing row is never overwritten.

    Seed a row with prompt "ADMIN EDITED". Call seed again with the same
    agent_key carrying prompt "BUILT-IN DEFAULT". Assert the stored prompt
    is still "ADMIN EDITED" and the response reports it as not created.

    This is the test that protects the whole feature: cold-start must never
    silently revert an admin's edited prompt back to the built-in constant.
    """
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # First: seed a row.
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "plugin_name": "ideation",
                    "role": "analyst",
                    "agent_key": "ideation-analyst",
                    "system_prompt": "ADMIN EDITED",
                    "agent_name": "Ideation Analyst",
                    "model": "claude-3-sonnet",
                    "required_group": "founder",
                }
            ],
        )
    )

    # Second: call seed with a different prompt.
    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "ideation-analyst",
                "agent_name": "Different Name",
                "role": "analyst",
                "system_prompt": "BUILT-IN DEFAULT",
                "model": "claude-3-sonnet-different",
                "required_group": "founder",
                "active": False,
                "max_history_messages": 10,
                "max_output_tokens": 512,
                "timeout_seconds": 10.0,
            }
        ],
    )

    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert len(result) == 1
    assert result[0]["role"] == "analyst"
    # THIS IS THE KEY ASSERTION: created=False means it was already there.
    assert result[0]["created"] is False, (
        "Response must report the row as already existing, not created. "
        "If this fails, seeding is overwriting admin edits."
    )

    # Verify the prompt was NOT changed.
    prompt = asyncio.run(
        _get_system_prompt(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
            agent_key="ideation-analyst",
        )
    )
    assert prompt == "ADMIN EDITED", (
        "The stored prompt should still be 'ADMIN EDITED' — seeding must never "
        "overwrite existing rows. If this fails, admin edits are being silently "
        "reverted on every cold start, destroying the entire feature."
    )

    asyncio.run(engine.dispose())


def test_seeding_is_idempotent():
    """Calling seed twice creates rows only on the first call.

    Second call reports everything as already existing and the row count
    is unchanged.
    """
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    seed_data = [
        {
            "agent_key": "ideation-analyst",
            "agent_name": "Ideation Analyst",
            "role": "analyst",
            "system_prompt": "Analyze ideas.",
            "model": "claude-3-sonnet",
            "required_group": "founder",
        },
        {
            "agent_key": "ideation-challenger",
            "agent_name": "Ideation Challenger",
            "role": "challenger",
            "system_prompt": "Challenge ideas.",
            "model": "claude-3-sonnet",
            "required_group": "founder",
        },
    ]

    # First seed call.
    resp1 = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=seed_data,
    )
    assert resp1.status_code == 200
    result1 = resp1.json()
    assert len(result1) == 2
    created_count_1 = sum(1 for r in result1 if r["created"])
    assert created_count_1 == 2, "First call should create both rows"

    # Check the row count after first call.
    row_count_after_first = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
        )
    )
    assert row_count_after_first == 2

    # Second seed call — same data.
    resp2 = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=seed_data,
    )
    assert resp2.status_code == 200
    result2 = resp2.json()
    assert len(result2) == 2
    created_count_2 = sum(1 for r in result2 if r["created"])
    assert created_count_2 == 0, "Second call should create nothing"

    # Verify each result correctly reports the role and created status.
    assert {r["role"] for r in result2} == {"analyst", "challenger"}
    for r in result2:
        assert r["created"] is False

    # Row count should be unchanged.
    row_count_after_second = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
        )
    )
    assert row_count_after_second == 2

    asyncio.run(engine.dispose())


def test_seeding_respects_tenant_scoping():
    """A row belonging to another tenant does not count as existing.

    Seeding creates one for the caller's tenant, and the other tenant's row
    is untouched.
    """
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Insert a row for a *different* tenant.
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "tenant_id": "other-tenant",
                    "plugin_name": "ideation",
                    "agent_key": "ideation-analyst",
                    "role": "analyst",
                    "agent_name": "Other Tenant Analyst",
                    "system_prompt": "Other tenant prompt",
                    "model": "claude-3-sonnet",
                    "required_group": "founder",
                }
            ],
        )
    )

    # Seed the same key for the default tenant.
    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "ideation-analyst",
                "agent_name": "Default Tenant Analyst",
                "role": "analyst",
                "system_prompt": "Default tenant prompt",
                "model": "claude-3-sonnet",
                "required_group": "founder",
            }
        ],
    )

    assert resp.status_code == 200
    result = resp.json()
    assert result[0]["created"] is True, (
        "The row for another tenant should not block seeding in this tenant"
    )

    # Verify both tenants have a row now, with different values.
    count_default = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
            agent_key="ideation-analyst",
        )
    )
    count_other = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="other-tenant",
            plugin_name="ideation",
            agent_key="ideation-analyst",
        )
    )
    assert count_default == 1
    assert count_other == 1

    asyncio.run(engine.dispose())


def test_seeding_uses_resolved_plugin_name_not_caller_supplied():
    """A plugin only ever seeds under its own resolved plugin name.

    The plugin_name is derived from ServicePrincipal.logical_names, not from
    the request body. A malicious caller cannot seed another plugin's configs.
    """
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Try to seed (cannot actually pass plugin_name in request — there's no field —
    # but this test documents that the route resolves it from the principal).
    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "test-key",
                "agent_name": "Test Agent",
                "role": "test",
                "system_prompt": "Test prompt",
                "model": "test/model",
                "required_group": "founder",
            }
        ],
    )

    assert resp.status_code == 200
    result = resp.json()
    assert result[0]["created"] is True

    # Verify the created row belongs to "ideation", not any other plugin.
    row_count_ideation = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
            agent_key="test-key",
        )
    )
    assert row_count_ideation == 1

    # And no other plugin has this key.
    row_count_other = asyncio.run(
        _get_row_count(
            session_factory,
            agent_key="test-key",
        )
    )
    assert row_count_other == 1, "Only ideation's row should exist"

    asyncio.run(engine.dispose())


def test_seeding_an_empty_list_creates_nothing():
    """An empty list is a valid request that creates nothing and returns successfully."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[],
    )

    assert resp.status_code == 200
    result = resp.json()
    assert result == []

    # Verify nothing was created.
    row_count = asyncio.run(
        _get_row_count(
            session_factory,
            tenant_id="default",
            plugin_name="ideation",
        )
    )
    assert row_count == 0

    asyncio.run(engine.dispose())


def test_seeding_does_not_create_history_rows():
    """Seeding does not create PluginChatAgentHistory rows.

    History records admin edits; a seed-created row is the row's origin,
    not a change to it.
    """
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "ideation-analyst",
                "agent_name": "Ideation Analyst",
                "role": "analyst",
                "system_prompt": "Analyze ideas.",
                "model": "claude-3-sonnet",
                "required_group": "founder",
            }
        ],
    )

    assert resp.status_code == 200
    result = resp.json()
    assert result[0]["created"] is True

    # Verify no history row was created.
    history_count = asyncio.run(
        _get_history_count(
            session_factory,
            agent_key="ideation-analyst",
        )
    )
    assert history_count == 0, (
        "Seeding must not create history rows. History is for admin edits, "
        "not for the cold-start origin of a row."
    )

    asyncio.run(engine.dispose())


def test_seeding_returns_the_right_response_shape():
    """Response is a list of {role, created} objects, one per input definition."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Seed some roles.
    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "key-1",
                "agent_name": "Agent 1",
                "role": "role-1",
                "system_prompt": "Prompt 1",
                "model": "model-1",
                "required_group": "founder",
            },
            {
                "agent_key": "key-2",
                "agent_name": "Agent 2",
                "role": "role-2",
                "system_prompt": "Prompt 2",
                "model": "model-2",
                "required_group": "founder",
            },
        ],
    )

    assert resp.status_code == 200
    result = resp.json()
    assert len(result) == 2
    assert all("role" in r and "created" in r for r in result)
    assert {r["role"] for r in result} == {"role-1", "role-2"}
    assert all(r["created"] is True for r in result)

    asyncio.run(engine.dispose())


def test_seeding_uses_default_values_when_not_supplied():
    """Omitted optional fields use their defaults."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[
            {
                "agent_key": "ideation-analyst",
                "agent_name": "Ideation Analyst",
                "role": "analyst",
                "system_prompt": "Analyze ideas.",
                "model": "claude-3-sonnet",
                "required_group": "founder",
                # Omit the optional fields.
            }
        ],
    )

    assert resp.status_code == 200
    result = resp.json()
    assert result[0]["created"] is True

    asyncio.run(engine.dispose())


def test_no_principal_is_401():
    """A request with no SigV4 principal returns 401."""
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

    app = FastAPI()
    app.include_router(internal_plugin_config.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    # Deliberately do NOT override require_service_principal.

    client = TestClient(app)
    resp = client.post(
        "/api/v1/internal/plugins/me/config/seed",
        json=[],
    )

    assert resp.status_code == 401, resp.text
    asyncio.run(engine.dispose())
