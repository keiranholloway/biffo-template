"""Integration tests for the read-only run-history router
(/api/v1/orchestration/runs). Runs are seeded through the *real* engine path —
``dispatch_event`` claims them, ``record_result`` closes them — so the history a
caller reads is the history the engine actually writes.

Same StaticPool/in-memory-SQLite fixture as test_orchestration_admin_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    TriggerCatalog,
    WorkflowDefinition,
    WorkflowRun,
)
from api.orchestration import (
    create_definition,
    delete_definition,
    dispatch_event,
    record_result,
)
from api.routers import orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/orchestration/runs"


def _caller(roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id="default",
        roles=["admin"] if roles is None else roles,
    )


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

    fastapi = FastAPI()
    fastapi.include_router(orchestration.runs_router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: _caller()

    yield fastapi, session_factory

    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    fastapi, _ = app
    return TestClient(fastapi)


async def _seed(
    session_factory: async_sessionmaker,
    *,
    name: str = "Notify sales",
    detail_type: str = "demo.requested",
    idempotency_key: str = "demo-1",
    outcome: str | None = "succeeded",
    error: str | None = None,
    delete_definition_after: bool = False,
) -> tuple[str, str]:
    """Create a definition, fire one event at it, optionally record an outcome.

    Each seeded definition gets its own ``detail_type`` by default so one event
    claims exactly one run — dispatch matches *every* enabled definition on a
    trigger, which is correct but would make these fixtures cross-talk.

    Returns ``(definition_id, run_id)``.
    """
    async with session_factory() as session:
        definition = await create_definition(
            session,
            tenant_id="default",
            name=name,
            trigger_source="biffo.core",
            trigger_detail_type=detail_type,
            action_type="email",
            action_config={
                "from": "no-reply@example.com",
                "to": "sales@example.com",
                "subject": "New demo",
                "body": "Hi",
            },
            enabled=True,
        )
        claimed = await dispatch_event(
            session,
            tenant_id="default",
            source="biffo.core",
            detail_type=detail_type,
            idempotency_key=idempotency_key,
            event={"company": "Acme", "email": "buyer@acme.test"},
        )
        run_id = claimed[0].run_id
        if outcome is not None:
            await record_result(
                session,
                tenant_id="default",
                run_id=run_id,
                action_type="email",
                status=outcome,
                request={"to": "sales@example.com", "webhook_url": "https://secret"},
                response={"message_id": "ses-1"},
                error=error,
            )
        if delete_definition_after:
            await delete_definition(session, tenant_id="default", definition_id=definition.id)
        await session.commit()
        return definition.id, run_id


def test_lists_runs_with_definition_name_and_logs(app, client: TestClient):
    _, session_factory = app
    _, run_id = asyncio.run(_seed(session_factory))

    resp = client.get(_BASE)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == run_id
    assert row["definition_name"] == "Notify sales"
    assert row["status"] == "succeeded"
    assert row["trigger_event"]["company"] == "Acme"
    assert [log["status"] for log in row["logs"]] == ["succeeded"]
    assert row["logs"][0]["response"] == {"message_id": "ses-1"}


def test_action_log_never_exposes_the_request(app, client: TestClient):
    # `request` echoes the action config, which can carry a credential (a Google
    # Chat webhook URL embeds its own token). It must not reach the client.
    _, session_factory = app
    asyncio.run(_seed(session_factory))

    resp = client.get(_BASE)
    assert "request" not in resp.json()[0]["logs"][0]
    assert "https://secret" not in resp.text


def test_failed_run_surfaces_its_error(app, client: TestClient):
    _, session_factory = app
    asyncio.run(_seed(session_factory, outcome="failed", error="SES rejected the recipient"))

    row = client.get(_BASE).json()[0]
    assert row["status"] == "failed"
    assert row["logs"][0]["error"] == "SES rejected the recipient"


def test_pending_run_has_no_logs_yet(app, client: TestClient):
    _, session_factory = app
    asyncio.run(_seed(session_factory, outcome=None))

    row = client.get(_BASE).json()[0]
    assert row["status"] == "pending"
    assert row["logs"] == []


def test_filters_by_status_and_definition(app, client: TestClient):
    _, session_factory = app
    ok_def, ok_run = asyncio.run(_seed(session_factory, idempotency_key="demo-ok"))
    _, bad_run = asyncio.run(
        _seed(
            session_factory,
            name="Notify ops",
            detail_type="lead.captured",
            idempotency_key="lead-bad",
            outcome="failed",
        )
    )

    assert {r["id"] for r in client.get(_BASE).json()} == {ok_run, bad_run}

    failed = client.get(_BASE, params={"status": "failed"}).json()
    assert [r["id"] for r in failed] == [bad_run]

    mine = client.get(_BASE, params={"definition_id": ok_def}).json()
    assert [r["id"] for r in mine] == [ok_run]


def test_rejects_an_unknown_status(client: TestClient):
    assert client.get(_BASE, params={"status": "exploded"}).status_code == 422


def test_limit_is_bounded(client: TestClient):
    assert client.get(_BASE, params={"limit": 0}).status_code == 422
    assert client.get(_BASE, params={"limit": 500}).status_code == 422


def test_run_outlives_its_deleted_definition(app, client: TestClient):
    # The run is the audit record of what fired; deleting the rule must not
    # erase the history, it just leaves the name unknown.
    _, session_factory = app
    _, run_id = asyncio.run(_seed(session_factory, delete_definition_after=True))

    row = client.get(_BASE).json()[0]
    assert row["id"] == run_id
    assert row["definition_name"] is None


def test_is_tenant_scoped(app, client: TestClient):
    _, session_factory = app
    asyncio.run(_seed(session_factory))

    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: AuthenticatedUser(
        sub="other-sub",
        email="admin@other.test",
        username="other",
        tenant_id="other",
        roles=["admin"],
    )
    assert client.get(_BASE).json() == []


def test_requires_admin(app, client: TestClient):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=["user"])
    assert client.get(_BASE).status_code == 403
