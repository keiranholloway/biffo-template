"""Integration tests for the workflow dry-run endpoint
(POST /api/v1/admin/orchestration/test, issue #527 Phase 2; async since #726).

The dry-run no longer invokes the runtime synchronously — it queues a real
``agent_run`` marked ``dry_run`` and returns 202 + the id to poll, because a
preview of a real agent can run for minutes and no HTTP response can wait that
long (API Gateway caps every integration here at 29s).

So these tests cover what Core is now responsible for: the admin gate, that a
marked run is persisted with the draft's config faithfully snapshotted, that
``agent.run.requested`` is emitted so the runtime picks it up, tenant-scoped
prompt-library resolution, and the 422 shape when a draft's parts do not resolve.

The **"causes nothing"** guarantee no longer lives here. It moved to the one
place that decides it — the completion endpoint withholding
``agent.run.completed`` — and is tested in `test_internal_agents_router.py`.

StaticPool/in-memory-SQLite fixture. The get_db override commits *and* publishes
buffered events (like the real get_db), with the publisher spied, so event
assertions run through the real publish path rather than by construction.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api import dependencies as api_dependencies
from api.config import settings
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table on Base.metadata
from api.models.base import Base
from api.models.orchestration import WorkflowDefinition  # noqa: F401 — registers the table
from api.models.prompt_component import PromptComponent
from api.routers.admin import orchestration as admin_orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

_URL = "/api/v1/admin/orchestration/test"


def _caller(*, tenant_id: str = "default", roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"] if roles is None else roles,
        user_id="user-123",
    )


class SpyPublisher:
    """Records every event published, so a test can assert zero were."""

    def __init__(self) -> None:
        self.published: list = []

    def publish(self, event) -> None:
        self.published.append(event)


def _build_app(
    *, caller: AuthenticatedUser, publisher: SpyPublisher
) -> tuple[FastAPI, async_sessionmaker, AsyncEngine]:
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
        # Mirrors the real get_db: commit, then publish buffered events. The
        # publisher is spied, so an accidental emit would be caught here.
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            else:
                from api.events.emit import publish_pending

                await publish_pending(session)

    fastapi = FastAPI()
    fastapi.include_router(admin_orchestration.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: caller
    return fastapi, session_factory, engine


@pytest.fixture
def publisher(monkeypatch) -> SpyPublisher:
    spy = SpyPublisher()
    # publish_pending resolves the publisher via dependencies.get_event_publisher
    # at call time, so patching the attribute routes real publishes to the spy.
    monkeypatch.setattr(api_dependencies, "get_event_publisher", lambda: spy)
    return spy


@pytest.fixture
def app(publisher) -> Generator[tuple[FastAPI, async_sessionmaker, SpyPublisher]]:
    fastapi, session_factory, engine = _build_app(caller=_caller(), publisher=publisher)
    yield fastapi, session_factory, publisher
    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    fastapi, _, _ = app
    return TestClient(fastapi)


def _body(**overrides) -> dict:
    body = {
        "agent_name": "lead-enricher",
        "instructions": "Assess whether this lead is a good fit for our product.",
        "sample_event": {"company": "Acme Corp", "role": "VP Sales"},
    }
    body.update(overrides)
    return body


async def _all_runs(session_factory: async_sessionmaker) -> list[AgentRun]:
    async with session_factory() as session:
        return list((await session.scalars(select(AgentRun))).all())


async def _seed_component(
    session_factory: async_sessionmaker,
    *,
    tenant_id: str,
    name: str,
    body: str,
    variables: list[dict] | None = None,
) -> None:
    async with session_factory() as session:
        session.add(
            PromptComponent(
                tenant_id=tenant_id,
                name=name,
                description=None,
                body=body,
                variables=variables or [],
            )
        )
        await session.commit()


# ── the queued preview ──────────────────────────────────────────────────────


def test_dry_run_returns_202_with_the_run_to_poll(client):
    resp = client.post(_URL, json=_body())
    assert resp.status_code == 202
    payload = resp.json()
    assert payload["run_id"]
    # `pending`, not `running`: the runtime has not claimed it yet, and a client
    # polling on the run's own vocabulary must not be told otherwise.
    assert payload["status"] == "pending"


def test_the_run_is_persisted_and_marked_as_a_dry_run(app, client):
    _, session_factory, _ = app
    resp = client.post(_URL, json=_body())

    runs = asyncio.run(_all_runs(session_factory))
    assert len(runs) == 1
    assert runs[0].id == resp.json()["run_id"]
    # The mark is the entire "causes nothing" guarantee. Unmarked, this run would
    # emit `agent.run.completed` and fire the write-back it was only previewing.
    assert runs[0].dry_run is True


def test_the_draft_config_is_snapshotted_for_the_runtime(app, client):
    _, session_factory, _ = app
    client.post(_URL, json=_body(model="moonshotai/kimi-k3:online", max_turns=4))

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    # The keys the runtime actually reads (agent_runtime/plugin.py, loop.py). A
    # snapshot that omits them runs a differently-configured agent than the one
    # being previewed, which is the one thing a preview must not do.
    assert snapshot["instructions"] == _body()["instructions"]
    assert snapshot["model"] == "moonshotai/kimi-k3:online"
    assert snapshot["max_turns"] == 4


def test_the_sample_event_travels_as_the_input_payload(app, client):
    _, session_factory, _ = app
    client.post(_URL, json=_body())

    run = asyncio.run(_all_runs(session_factory))[0]
    # Unfenced and unredacted here on purpose: the runtime's messages.py is the
    # only path that turns a payload into a prompt, and it fences and redacts
    # there. Core doing it too would be a second implementation of a security
    # property — the duplication this move removed.
    assert run.input_payload == {"company": "Acme Corp", "role": "VP Sales"}


def test_the_requested_event_is_emitted_so_the_runtime_picks_it_up(app, client):
    _, _, publisher = app
    resp = client.post(_URL, json=_body())

    assert len(publisher.published) == 1
    event = publisher.published[0]
    assert event.detail_type == "agent.run.requested"
    # The runtime reads `run_id` off the payload and fetches the rest; without
    # this the run sits `pending` for ever and the preview never starts.
    assert event.payload["run_id"] == resp.json()["run_id"]


def test_an_unset_model_falls_back_to_the_platform_default(app, client):
    _, session_factory, _ = app
    client.post(_URL, json=_body())

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    assert snapshot["model"] == settings.agent_assistant_model


def test_a_dry_run_starts_no_causation_chain(app, client):
    _, session_factory, _ = app
    client.post(_URL, json=_body())

    run = asyncio.run(_all_runs(session_factory))[0]
    # A preview is requested by a person, not caused by another run: it must
    # neither be blamed for a loop nor be able to extend one past the ceiling.
    assert run.causation_id is None
    assert run.depth == 0


# ── prompt library resolution ───────────────────────────────────────────────


def test_prompt_library_parts_are_resolved_into_the_snapshot(app, client):
    _, session_factory, _ = app
    asyncio.run(
        _seed_component(
            session_factory,
            tenant_id="default",
            name="tone",
            body="Answer in a concise, factual tone.",
        )
    )
    resp = client.post(_URL, json=_body(instructions=[{"component": "tone"}]))
    assert resp.status_code == 202

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    # Resolved at create time (ADR-0015 §3/§4), so the runtime never sees a
    # component reference — same guarantee a real run gets, from the same code.
    assert "concise, factual tone" in snapshot["instructions"]


def test_a_missing_component_is_422_and_persists_no_run(app, client):
    _, session_factory, publisher = app
    resp = client.post(_URL, json=_body(instructions=[{"component": "nope"}]))

    assert resp.status_code == 422
    # Aborted before the row exists, so a broken draft leaves nothing to poll and
    # nothing on the bus — the same fail-loud posture a save would give.
    assert asyncio.run(_all_runs(session_factory)) == []
    assert publisher.published == []


def test_another_tenants_component_is_not_reachable(publisher):
    fastapi, session_factory, engine = _build_app(caller=_caller(), publisher=publisher)
    asyncio.run(
        _seed_component(
            session_factory, tenant_id="other-tenant", name="tone", body="Their private tone."
        )
    )
    try:
        resp = TestClient(fastapi).post(_URL, json=_body(instructions=[{"component": "tone"}]))
        # 422 "unresolvable", not 403: another tenant's component must be
        # indistinguishable from one that does not exist (ADR-0001).
        assert resp.status_code == 422
        assert asyncio.run(_all_runs(session_factory)) == []
    finally:
        asyncio.run(engine.dispose())


# ── the admin gate ──────────────────────────────────────────────────────────


def test_a_non_admin_caller_is_forbidden(publisher):
    fastapi, session_factory, engine = _build_app(
        caller=_caller(roles=["user"]), publisher=publisher
    )
    try:
        resp = TestClient(fastapi).post(_URL, json=_body())
        assert resp.status_code == 403
        assert asyncio.run(_all_runs(session_factory)) == []
    finally:
        asyncio.run(engine.dispose())
