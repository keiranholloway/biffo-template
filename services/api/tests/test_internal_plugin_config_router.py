"""Integration tests for the internal plugin config read endpoint
(/api/v1/internal/plugins/me/config/{role}, ADR-0009).

The SigV4-only path a plugin's Lambda uses to read one of its own admin-set
plugin_chat_agents rows. No forwarded user token needed — the data being read
is not founder-owned. The plugin's identity is derived from its verified
ServicePrincipal.logical_names, not from a path parameter (fail-closed against
cross-plugin reads).

Tests exercise the SigV4 gate, identity resolution from ARN, per-plugin
isolation, active-flag filtering, and edge cases (ambiguous identity,
non-conforming ARN).
"""

import asyncio
from collections.abc import AsyncGenerator

import pytest
from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.plugin_chat_agent import PluginChatAgent  # noqa: F401 — registers the table
from api.routers import internal_plugin_config
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
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


# ── happy path: caller's own plugin config ────────────────────────────────


def test_a_plugin_reads_its_own_config_by_role():
    """A SigV4-authenticated caller whose ARN resolves to system:ideation
    successfully reads the role="analyst" row for plugin_name="ideation"."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Insert the ideation plugin's analyst config.
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "plugin_name": "ideation",
                    "role": "analyst",
                    "agent_key": "ideation-analyst",
                    "agent_name": "Ideation Analyst",
                    "system_prompt": "Analyze ideas.",
                    "model": "claude-3-sonnet",
                    "required_group": "founder",
                    "active": True,
                }
            ],
        )
    )

    resp = client.get("/api/v1/internal/plugins/me/config/analyst")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["plugin_name"] == "ideation"
    assert body["role"] == "analyst"
    assert body["agent_key"] == "ideation-analyst"
    assert body["agent_name"] == "Ideation Analyst"
    assert body["system_prompt"] == "Analyze ideas."
    assert body["model"] == "claude-3-sonnet"
    assert body["active"] is True
    asyncio.run(engine.dispose())


def test_a_nonexistent_role_returns_404():
    """Requesting a role that has no matching row → 404."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Insert only the "analyst" role, not "reviewer".
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "plugin_name": "ideation",
                    "role": "analyst",
                }
            ],
        )
    )

    resp = client.get("/api/v1/internal/plugins/me/config/reviewer")

    assert resp.status_code == 404, resp.text
    asyncio.run(engine.dispose())


# ── cross-plugin isolation ───────────────────────────────────────────────


def test_cross_plugin_isolation_ideation_cannot_read_other_plugin_config():
    """A caller identified as ideation cannot read a config row for a different
    plugin, even if the role matches."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Insert an analyst role for ideation AND for another-plugin.
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "plugin_name": "ideation",
                    "role": "analyst",
                    "agent_key": "ideation-analyst",
                },
                {
                    "plugin_name": "other-plugin",
                    "role": "analyst",
                    "agent_key": "other-analyst",
                },
            ],
        )
    )

    resp = client.get("/api/v1/internal/plugins/me/config/analyst")

    # The call succeeds and returns the ideation row, not the other-plugin row.
    assert resp.status_code == 200
    body = resp.json()
    assert body["plugin_name"] == "ideation"
    assert body["agent_key"] == "ideation-analyst"
    asyncio.run(engine.dispose())


# ── active flag filtering ────────────────────────────────────────────────


def test_an_inactive_row_is_not_returned():
    """A row with active=False is not returned, even if the role matches."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Insert an inactive analyst role.
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "plugin_name": "ideation",
                    "role": "analyst",
                    "active": False,
                }
            ],
        )
    )

    resp = client.get("/api/v1/internal/plugins/me/config/analyst")

    assert resp.status_code == 404, resp.text
    asyncio.run(engine.dispose())


# ── identity resolution edge cases ───────────────────────────────────────


def test_no_principal_is_401():
    """A request with no SigV4 principal (no require_service_principal override,
    or override that raises 401) returns 401."""
    # Build without overriding require_service_principal — it will look for
    # AWS event context that won't exist in a test, so it raises 401.
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
    # Deliberately do NOT override require_service_principal — it will fail.

    client = TestClient(app)
    resp = client.get("/api/v1/internal/plugins/me/config/analyst")

    assert resp.status_code == 401, resp.text
    asyncio.run(engine.dispose())


def test_empty_logical_names_is_403():
    """A principal whose ARN resolves to an empty logical_names set
    (non-conforming ARN, no conforming plugin role) returns 403."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/some-non-plugin-role/session"
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    resp = client.get("/api/v1/internal/plugins/me/config/analyst")

    assert resp.status_code == 403, resp.text
    assert "Could not resolve a single plugin identity" in resp.json()["detail"]
    asyncio.run(engine.dispose())


def test_multiple_logical_names_is_403():
    """A principal with more than one logical name (shouldn't happen for real
    callers, but the endpoint must not crash) returns 403."""
    from api.routers.internal_plugin_config import _own_plugin_name

    # Create a mock principal with multiple logical names:
    class MockPrincipal:
        logical_names = frozenset({"system:ideation", "system:other"})

    with pytest.raises(HTTPException) as exc:
        _own_plugin_name(MockPrincipal())  # type: ignore[arg-type]

    assert exc.value.status_code == 403
    assert "Could not resolve a single plugin identity" in exc.value.detail


# ── actual integration: multiple logical names via app override ─────────────


def test_shared_host_with_asserted_plugin_succeeds():
    """The shared plugin host (ADR-0021 §1a) asserts a plugin identity via the
    X-Biffo-Plugin header. The principal resolves to that asserted plugin, which
    is singular."""
    principal = ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-host-role/session",
        asserted_plugin="ideation",  # Host acting as ideation.
    )
    app, session_factory, engine = _build_app(principal=principal)
    client = TestClient(app)

    # Insert ideation's analyst config.
    asyncio.run(
        _insert_plugin_agents(
            session_factory,
            [
                {
                    "plugin_name": "ideation",
                    "role": "analyst",
                    "agent_key": "ideation-analyst",
                }
            ],
        )
    )

    resp = client.get("/api/v1/internal/plugins/me/config/analyst")

    assert resp.status_code == 200
    body = resp.json()
    assert body["plugin_name"] == "ideation"
    asyncio.run(engine.dispose())
