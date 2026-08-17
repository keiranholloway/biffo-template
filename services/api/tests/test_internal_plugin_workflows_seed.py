"""Integration tests for plugin workflow seeding (biffo-template#1593).

The POST /api/v1/internal/plugins/me/workflows/seed endpoint lets a plugin
declare its own orchestration WorkflowDefinition rows, scoped to its own
verified identity and upserted (not insert-only) so a re-declared definition
never freezes at first write the way internal_plugin_config's /seed does.

Four things this suite has to prove, because they are the whole point of the
issue rather than incidental behaviour:

1. A plugin declares a workflow -> it exists.
2. The SAME plugin re-declares it with a changed value -> the stored row
   updates. This is the assertion that distinguishes this route from
   internal_plugin_config's insert-only /seed.
3. Plugin A attempting to write plugin B's definition is refused.
4. The existing Cognito-admin route (orchestration.py) still works, untouched.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    TriggerCatalog,
    WorkflowDefinition,
    WorkflowRun,
)
from api.routers import internal_plugin_workflows, orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_SEED_URL = "/api/v1/internal/plugins/me/workflows/seed"

# A permanently-declared registry event (events/registry.py), same fixture
# trigger test_orchestration_admin_router.py uses — real, not invented, so
# _require_known_trigger passes without needing a TriggerCatalog row.
_TRIGGER_SOURCE = "biffo.core"
_TRIGGER_DETAIL_TYPE = "demo.requested"


def _definition(definition_key: str = "fan-in", **over) -> dict:
    body = {
        "definition_key": definition_key,
        "name": "Synthesis fan-in",
        "trigger_source": _TRIGGER_SOURCE,
        "trigger_detail_type": _TRIGGER_DETAIL_TYPE,
        "action_type": "email",
        "action_config": {
            "from": "no-reply@example.com",
            "to": "ops@example.com",
            "subject": "Synthesis complete",
            "body": "Run finished",
        },
        "enabled": True,
    }
    body.update(over)
    return body


def _principal(plugin: str = "marketing") -> ServicePrincipal:
    return ServicePrincipal(
        principal_arn=f"arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-{plugin}-role/session"
    )


def _build_app(*, principal: ServicePrincipal | None = None):
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
    app.include_router(internal_plugin_workflows.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db

    if principal is not None:
        app.dependency_overrides[require_service_principal] = lambda: principal

    return app, session_factory, engine


async def _get_row(session_factory, **filters) -> WorkflowDefinition | None:
    async with session_factory() as session:
        query = select(WorkflowDefinition).where(
            *(getattr(WorkflowDefinition, k) == v for k, v in filters.items())
        )
        return await session.scalar(query)


async def _get_fan_in_row(session_factory, owner_plugin: str) -> WorkflowDefinition | None:
    """This suite's one recurring lookup: the "fan-in" row a given plugin owns."""
    return await _get_row(
        session_factory, tenant_id="default", owner_plugin=owner_plugin, definition_key="fan-in"
    )


async def _get_row_count(session_factory, **filters) -> int:
    async with session_factory() as session:
        query = select(func.count(WorkflowDefinition.id)).where(
            *(getattr(WorkflowDefinition, k) == v for k, v in filters.items())
        )
        return await session.scalar(query) or 0


def test_declaring_a_workflow_creates_it():
    """1. A plugin declares a workflow -> it exists."""
    app, session_factory, engine = _build_app(principal=_principal("marketing"))
    client = TestClient(app)

    resp = client.post(_SEED_URL, json=[_definition()])

    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert len(result) == 1
    assert result[0]["definition_key"] == "fan-in"
    assert result[0]["created"] is True

    row = asyncio.run(_get_fan_in_row(session_factory, "marketing"))
    assert row is not None
    assert row.action_config["to"] == "ops@example.com"

    asyncio.run(engine.dispose())


def test_redeclaring_with_a_changed_value_updates_the_stored_row():
    """2. THE CRITICAL TEST: re-declaring the same key with a changed value
    updates the stored row — the assertion that distinguishes this route from
    internal_plugin_config's insert-only /seed.

    Fails without the fix: an insert-only route would report `created=False`
    and leave the stale value in place, reproducing the exact bug (#1593)
    this route exists to close (marketing's frozen model/timeout snapshot).
    """
    app, session_factory, engine = _build_app(principal=_principal("marketing"))
    client = TestClient(app)

    first = client.post(
        _SEED_URL,
        json=[
            _definition(
                action_config={
                    "from": "no-reply@example.com",
                    "to": "ops@example.com",
                    "subject": "STALE SUBJECT",
                    "body": "stale body",
                }
            )
        ],
    )
    assert first.status_code == 200, first.text
    assert first.json()[0]["created"] is True

    second = client.post(
        _SEED_URL,
        json=[
            _definition(
                action_config={
                    "from": "no-reply@example.com",
                    "to": "ops@example.com",
                    "subject": "FRESH SUBJECT",
                    "body": "fresh body",
                }
            )
        ],
    )
    assert second.status_code == 200, second.text
    result = second.json()
    assert result[0]["created"] is False, "second call should report an update, not a create"
    assert result[0]["definition_id"] == first.json()[0]["definition_id"], (
        "must be the SAME row, not a second one"
    )

    row = asyncio.run(_get_fan_in_row(session_factory, "marketing"))
    assert row is not None
    assert row.action_config["subject"] == "FRESH SUBJECT", (
        "the stored row must reflect the re-declared value — an insert-only "
        "route would leave 'STALE SUBJECT' in place, which is the bug this "
        "route exists to close"
    )
    row_count = asyncio.run(
        _get_row_count(session_factory, tenant_id="default", owner_plugin="marketing")
    )
    assert row_count == 1, "re-declaring must update in place, not create a second row"

    asyncio.run(engine.dispose())


def test_plugin_a_cannot_write_plugin_bs_definition():
    """3. Plugin A cannot write plugin B's definition — the scope comes from
    the verified ServicePrincipal, never the request body (there is no field
    to supply another plugin's name in the first place, which is itself part
    of the guarantee: the only way to test this is to seed as two different
    principals and confirm they land in two disjoint rows)."""
    app, session_factory, engine = _build_app(principal=_principal("marketing"))
    client = TestClient(app)

    # Plugin A (marketing) seeds a definition under key "fan-in".
    resp_a = client.post(_SEED_URL, json=[_definition(name="Marketing's workflow")])
    assert resp_a.status_code == 200, resp_a.text
    assert resp_a.json()[0]["created"] is True

    # Plugin B (idea-scout) seeds a definition under the SAME key.
    app.dependency_overrides[require_service_principal] = lambda: _principal("idea-scout")
    resp_b = client.post(_SEED_URL, json=[_definition(name="Idea Scout's workflow")])
    assert resp_b.status_code == 200, resp_b.text
    # Refused to touch A's row: B's call creates its OWN row rather than
    # updating marketing's, because the pre-read is scoped to owner_plugin.
    assert resp_b.json()[0]["created"] is True, (
        "plugin B must get its own new row, not report an update to plugin A's"
    )
    assert resp_b.json()[0]["definition_id"] != resp_a.json()[0]["definition_id"]

    # Marketing's row is untouched by idea-scout's call.
    row_a = asyncio.run(_get_fan_in_row(session_factory, "marketing"))
    assert row_a is not None
    assert row_a.name == "Marketing's workflow", (
        "plugin B must not be able to overwrite plugin A's row"
    )

    row_b = asyncio.run(_get_fan_in_row(session_factory, "idea-scout"))
    assert row_b is not None
    assert row_b.name == "Idea Scout's workflow"

    total = asyncio.run(_get_row_count(session_factory, tenant_id="default"))
    assert total == 2, "each plugin owns its own row under the same key"

    asyncio.run(engine.dispose())


def test_no_principal_is_401():
    app, _, engine = _build_app(principal=None)
    client = TestClient(app)
    resp = client.post(_SEED_URL, json=[_definition()])
    assert resp.status_code == 401, resp.text
    asyncio.run(engine.dispose())


def test_seeding_an_empty_list_creates_nothing():
    app, session_factory, engine = _build_app(principal=_principal("marketing"))
    client = TestClient(app)

    resp = client.post(_SEED_URL, json=[])

    assert resp.status_code == 200
    assert resp.json() == []
    assert asyncio.run(_get_row_count(session_factory, tenant_id="default")) == 0
    asyncio.run(engine.dispose())


def test_unknown_trigger_is_rejected():
    app, session_factory, engine = _build_app(principal=_principal("marketing"))
    client = TestClient(app)

    resp = client.post(
        _SEED_URL,
        json=[_definition(trigger_source="nonexistent.source", trigger_detail_type="nope")],
    )

    assert resp.status_code == 422, resp.text
    assert asyncio.run(_get_row_count(session_factory, tenant_id="default")) == 0
    asyncio.run(engine.dispose())


# ── 4. The existing Cognito-admin route still works, untouched ──────────────


def _admin_caller() -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        roles=["admin"],
        tenant_id="default",
        permissions=frozenset(),
    )


@pytest.fixture
def admin_app() -> Generator[tuple[FastAPI, async_sessionmaker]]:
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
    fastapi.include_router(orchestration.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: _admin_caller()

    yield fastapi, session_factory

    asyncio.run(engine.dispose())


def test_cognito_admin_write_still_works(admin_app):
    """4. A Cognito-admin write via the existing orchestration.py router still
    works, completely unaffected by this route's addition — admin-authored
    rows carry no owner_plugin and are never touched by the seed path."""
    fastapi, session_factory = admin_app
    client = TestClient(fastapi)

    resp = client.post(
        "/api/v1/orchestration/workflows",
        json={
            "name": "Notify sales",
            "trigger_source": _TRIGGER_SOURCE,
            "trigger_detail_type": _TRIGGER_DETAIL_TYPE,
            "action_type": "email",
            "action_config": {
                "from": "no-reply@example.com",
                "to": "sales@example.com",
                "subject": "New demo",
                "body": "Contact",
            },
            "enabled": True,
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Notify sales"

    row = asyncio.run(_get_row(session_factory, tenant_id="default", name="Notify sales"))
    assert row is not None
    assert row.owner_plugin is None, "an admin-authored row must never carry owner_plugin"
    assert row.definition_key is None
