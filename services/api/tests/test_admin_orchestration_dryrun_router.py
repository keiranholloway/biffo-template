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
from api import writeback_targets as wb
from api.config import settings
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table on Base.metadata
from api.models.base import Base
from api.models.orchestration import WorkflowDefinition  # noqa: F401 — registers the table
from api.models.prompt_component import PromptComponent
from api.routers.admin import orchestration as admin_orchestration
from api.schemas.agent_dryrun import WorkflowDryRunRequest
from api.schemas.orchestration import WORKFLOW_ACTIONS
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


# ── the write-back contract, and the drift guard that keeps it (#749) ────────
#
# "Test workflow" is the ONLY gate an author sees before enabling a live agent
# workflow. It used to hand the model a four-key snapshot with no `writeback`,
# so a write-back workflow was previewed without its submit tool, answered in
# prose, and passed — while prose is exactly the result shape `writeback.py`
# reads as *no columns*, refuses to write, and records a refusal for. The
# preview asserted success for the one outcome that writes nothing.


@pytest.fixture
def leads_target():
    """A registered write-back target, restored afterwards.

    The registry is a module-level global (the ceiling lives in code, ADR-0027
    §3), so a test that registers must put it back or it leaks into the rest of
    the suite.
    """
    saved = dict(wb._targets)  # noqa: SLF001
    target = wb.WriteBackTarget(
        table="leads",
        # The registry only ever holds the reference; any mapped class will do.
        model=AgentRun,
        label="Lead",
        permission_code="leads.update",
        allowed_principals=("system:orchestrator",),
        columns=(
            wb.WriteBackColumn(name="notes", label="Notes", type="textarea", overwrite="append"),
            wb.WriteBackColumn(
                name="rating", label="Rating", type="enum", values=("hot", "warm", "cold")
            ),
        ),
        operations=("update",),
        row_selector=wb.RowSelector(payload_field="lead_id"),
    )
    wb.register_writeback_target(target)
    yield target
    wb._targets.clear()  # noqa: SLF001
    wb._targets.update(saved)  # noqa: SLF001


_WRITEBACK = {"table": "leads", "operation": "update", "columns": {"notes": "{output.notes}"}}


def test_a_previewed_writeback_run_is_offered_the_submit_tool(app, client, leads_target):
    _, session_factory, _ = app
    resp = client.post(_URL, json=_body(writeback=_WRITEBACK))
    assert resp.status_code == 202

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    # The declaration itself travels, because it is what `writeback.py` reads off
    # the completed run to decide what to write.
    assert snapshot["writeback"] == _WRITEBACK
    # And the generated contract is on the snapshot, so the runtime offers it and
    # the model must answer with typed columns rather than prose.
    tool = snapshot["output_tools"][0]
    assert tool["function"]["name"] == "submit_leads_record"
    # Narrowed to what this workflow declared: `rating` was never mapped, so the
    # preview does not offer it either.
    assert set(tool["function"]["parameters"]["properties"]) == {"notes"}


def test_the_preview_is_offered_exactly_what_a_live_run_would_be(app, client, leads_target):
    """The parity assertion, not a hardcoded expectation.

    Both paths must resolve the contract through the SAME helper — the live one
    in ``routers/internal_agents`` on the way in, this one here. Naming the
    helper rather than the tool means a change to how the contract is generated
    moves the preview with it, which is the drift this issue is about.
    """
    _, session_factory, _ = app
    client.post(_URL, json=_body(writeback=_WRITEBACK))

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    live = wb.apply_writeback_output_tool({"writeback": _WRITEBACK})
    assert snapshot["output_tools"] == live["output_tools"]


def test_a_writeback_with_no_contract_is_refused_rather_than_previewed(app, client):
    """No target registered, so no submit tool could be generated.

    A live run here would be handed nothing, answer in prose and write nothing.
    Queuing the preview anyway is how the green test in #749 happened, so this
    fails loudly instead — before any spend, and with the run never created.
    """
    _, session_factory, publisher = app
    resp = client.post(_URL, json=_body(writeback=_WRITEBACK))

    assert resp.status_code == 422
    assert "write nothing" in resp.json()["detail"]
    assert asyncio.run(_all_runs(session_factory)) == []
    assert publisher.published == []


def test_declared_tools_reach_the_snapshot(app, client):
    _, session_factory, _ = app
    client.post(_URL, json=_body(tools=["web_search"], max_turns=3))

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    # `declared_tools(snapshot)` in the runtime reads this key. Omitted, a
    # tool-using worker was previewed with no tools at all — the same class of
    # infidelity as the missing write-back.
    assert snapshot["tools"] == ["web_search"]


# ── the drift guard ─────────────────────────────────────────────────────────
#
# The preview is a subset of the agent action by construction, so it drifts every
# time the action grows a field — silently, and in the direction of a preview
# that proves less than it appears to. These two tests make the catalog the
# authority: a new `config_field` fails the suite until someone decides whether
# the preview must carry it.

#: Agent-action fields a preview deliberately does NOT send, each with its reason.
#: Keep this the complete exception list — the guard below asserts equality, not
#: containment, so an unlisted new field is a failure rather than an omission.
_NOT_PREVIEWED: dict[str, str] = {
    # ADR-0020 delivery fires from `agent.run.completed`, which a dry run never
    # emits — that withheld event IS the "causes nothing" guarantee. Sending it
    # would preview a step that cannot run.
    "delivery": "a preview never delivers; the completed event is withheld",
}

#: Sent, but it lands on the run row rather than in the snapshot — `create_run`
#: takes it as its own argument, and `AgentRun.agent_name` is where the runtime
#: reads it from.
_ON_THE_RUN_NOT_THE_SNAPSHOT = frozenset({"agent_name"})


def _agent_action_field_names() -> set[str]:
    action = next(a for a in WORKFLOW_ACTIONS if a["type"] == "agent")
    return {field["name"] for field in action["config_fields"]}


def test_every_agent_action_field_is_previewed_or_explicitly_excluded():
    fields = _agent_action_field_names()
    # The exception list must describe fields that exist, or it is documenting a
    # decision about nothing.
    assert set(_NOT_PREVIEWED) <= fields
    declared = set(WorkflowDryRunRequest.model_fields)
    assert fields - declared == set(_NOT_PREVIEWED), (
        "The agent action gained a config field the dry-run does not accept. "
        "Either declare it on WorkflowDryRunRequest and carry it onto the "
        "snapshot, or add it to _NOT_PREVIEWED with the reason a preview is "
        "honest without it."
    )


def test_every_previewed_field_actually_reaches_the_snapshot(app, client, leads_target):
    """Declaring the field is half of it; the snapshot is what the runtime reads.

    The original bug was not a missing schema field alone — the service built its
    own four-key dict, so a field could be accepted and then dropped on the floor
    without a single test noticing.
    """
    _, session_factory, _ = app
    resp = client.post(
        _URL,
        json=_body(
            goals="A confidence-rated verdict.",
            model="moonshotai/kimi-k3",
            max_turns=3,
            tools=["web_search"],
            writeback=_WRITEBACK,
        ),
    )
    assert resp.status_code == 202

    snapshot = asyncio.run(_all_runs(session_factory))[0].definition_snapshot
    expected = _agent_action_field_names() - set(_NOT_PREVIEWED) - _ON_THE_RUN_NOT_THE_SNAPSHOT
    assert expected <= set(snapshot), (
        f"The dry-run snapshot is missing {sorted(expected - set(snapshot))}. A preview "
        "that omits a field runs a differently-configured agent than the one being "
        "previewed, which is the one thing a preview must not do."
    )
