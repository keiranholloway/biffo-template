"""Core-side prompt resolution at run-creation (ADR-0015 §3/§4/§5/§6).

The heart of the ADR: a definition's ordered prompt parts are composed and
variable-substituted into final strings, Core-side, and frozen into the run's
``definition_snapshot`` — which the runtime then consumes unchanged. These tests
exercise resolution directly against an in-memory SQLite session (asyncio_mode =
auto), plus the two router edges: run-creation fail-loud (internal agents API)
and author-time validation (orchestration builder API).
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api import agent_runs
from api import prompt_library as lib
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table
from api.models.base import Base
from api.models.prompt_component import PromptComponent
from api.prompt_parts import PromptPartsError
from api.routers import orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

TENANT = "default"


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


async def _seed(session: AsyncSession, **over) -> PromptComponent:
    fields = dict(
        tenant_id=TENANT,
        name="house-style",
        description=None,
        body="State confidence per claim. Cite sources. Be concise.",
        variables=[],
    )
    fields.update(over)
    component = PromptComponent(**fields)
    session.add(component)
    await session.flush()
    return component


# ── Composition + substitution (ADR-0015 worked scenarios) ───────────────────


async def test_house_style_component_composes_in_order_before_inline(db_session):
    """Worked scenario 1: a no-variable shared component + a bespoke inline part."""
    await _seed(db_session)
    snapshot = {
        "model": "anthropic/claude-opus-4-8",
        "instructions": [
            {"component": "house-style"},
            {"inline": "Assess this demo request for legitimacy and brand size."},
        ],
    }

    resolved = await lib.resolve_definition_snapshot(
        db_session, tenant_id=TENANT, snapshot=snapshot
    )

    assert resolved["instructions"] == (
        "State confidence per claim. Cite sources. Be concise.\n\n"
        "Assess this demo request for legitimacy and brand size."
    )
    # Every other snapshot field is preserved byte-for-byte.
    assert resolved["model"] == "anthropic/claude-opus-4-8"


async def test_parameterised_family_substitutes_the_authored_value(db_session):
    """Worked scenario 2: one component, one definition per member with values."""
    await _seed(
        db_session,
        name="lead-scorer",
        body="Score leads for {{region}}. Prioritise operators HQ'd in {{region}}.",
        variables=[{"name": "region", "required": True}],
    )

    midlands = await lib.resolve_definition_snapshot(
        db_session,
        tenant_id=TENANT,
        snapshot={"instructions": [{"component": "lead-scorer", "values": {"region": "Midlands"}}]},
    )
    london = await lib.resolve_definition_snapshot(
        db_session,
        tenant_id=TENANT,
        snapshot={"instructions": [{"component": "lead-scorer", "values": {"region": "London"}}]},
    )

    assert midlands["instructions"] == (
        "Score leads for Midlands. Prioritise operators HQ'd in Midlands."
    )
    assert london["instructions"] == (
        "Score leads for London. Prioritise operators HQ'd in London."
    )


async def test_goals_resolve_too_and_absent_fields_are_left_alone(db_session):
    await _seed(db_session, name="rubric", body="Give a confidence-rated verdict.")
    snapshot = {
        "instructions": "Assess the lead.",
        "goals": [{"component": "rubric"}],
    }

    resolved = await lib.resolve_definition_snapshot(
        db_session, tenant_id=TENANT, snapshot=snapshot
    )

    assert resolved["instructions"] == "Assess the lead."
    assert resolved["goals"] == "Give a confidence-rated verdict."


async def test_a_plain_string_prompt_round_trips_unchanged(db_session):
    """The pre-library shape: a plain string is one inline part, resolving to itself."""
    snapshot = {"instructions": "Enrich the demo request.", "model": "x"}
    resolved = await lib.resolve_definition_snapshot(
        db_session, tenant_id=TENANT, snapshot=snapshot
    )
    assert resolved["instructions"] == "Enrich the demo request."


# ── The resolved snapshot is what lands on the run (and what the runtime reads) ─


async def test_create_run_freezes_the_resolved_prompt_into_the_snapshot(db_session):
    await _seed(db_session)
    run, _ = await agent_runs.create_run(
        db_session,
        tenant_id=TENANT,
        agent_name="demo-enricher",
        definition_snapshot={
            "model": "anthropic/claude-opus-4-8",
            "instructions": [{"component": "house-style"}, {"inline": "Do the task."}],
        },
        max_depth=10,
    )

    # What the runtime reads is `str(snapshot.get("instructions"))` — a plain
    # string, fully composed. It never sees a component.
    stored = run.definition_snapshot["instructions"]
    assert isinstance(stored, str)
    assert stored == "State confidence per claim. Cite sources. Be concise.\n\nDo the task."


# ── Fail-loud (ADR-0015 §6) ──────────────────────────────────────────────────


async def test_a_missing_component_aborts_resolution(db_session):
    with pytest.raises(lib.PromptComponentMissingError, match="does not exist"):
        await lib.resolve_definition_snapshot(
            db_session,
            tenant_id=TENANT,
            snapshot={"instructions": [{"component": "never-created"}]},
        )


async def test_a_missing_required_variable_aborts_resolution(db_session):
    await _seed(
        db_session,
        name="lead-scorer",
        body="Score leads for {{region}}.",
        variables=[{"name": "region", "required": True}],
    )
    with pytest.raises(PromptPartsError, match="requires value"):
        await lib.resolve_definition_snapshot(
            db_session,
            tenant_id=TENANT,
            snapshot={"instructions": [{"component": "lead-scorer"}]},
        )


async def test_create_run_aborts_when_a_referenced_component_is_missing(db_session):
    with pytest.raises(PromptPartsError):
        await agent_runs.create_run(
            db_session,
            tenant_id=TENANT,
            agent_name="x",
            definition_snapshot={"instructions": [{"component": "gone"}]},
            max_depth=10,
        )


# ── Tenant isolation of resolution ───────────────────────────────────────────


async def test_resolution_is_tenant_scoped(db_session):
    # A component in tenant-a is invisible to tenant-b's resolution.
    await _seed(db_session, tenant_id="tenant-a", name="shared")
    with pytest.raises(lib.PromptComponentMissingError):
        await lib.resolve_definition_snapshot(
            db_session,
            tenant_id="tenant-b",
            snapshot={"instructions": [{"component": "shared"}]},
        )


# ── The trust boundary: values come ONLY from the definition (ADR-0015 §5) ────


async def test_runtime_event_data_never_fills_a_variable(db_session):
    """§5, by construction: resolution reads values from the definition's parts and
    the component's declared default — never from the triggering event payload.

    A component whose `{{region}}` has a default is resolved via ``create_run``
    with an ``input_payload`` that also carries ``region``. The default wins; the
    payload value never reaches the prompt. There is no parameter, on any
    resolution function, that could carry event/tool data into ``values``."""
    await _seed(
        db_session,
        name="lead-scorer",
        body="Score leads for {{region}}.",
        variables=[{"name": "region", "required": True, "default": "UK"}],
    )

    run, _ = await agent_runs.create_run(
        db_session,
        tenant_id=TENANT,
        agent_name="scorer",
        definition_snapshot={"instructions": [{"component": "lead-scorer"}]},
        input_payload={"region": "INJECTED-FROM-EVENT"},
        max_depth=10,
    )

    assert run.definition_snapshot["instructions"] == "Score leads for UK."
    assert "INJECTED-FROM-EVENT" not in run.definition_snapshot["instructions"]


def test_resolution_functions_take_no_runtime_data_parameter():
    """A structural guard on §5: the resolution surface accepts a snapshot and a
    tenant, and nothing that could be an event payload / tool result. If someone
    later adds such a parameter, this fails and forces a revisit of §5/§7."""
    import inspect

    resolution_fns = (
        lib.resolve_definition_snapshot,
        lib.resolve_prompt_field,
        lib.validate_agent_prompts,
    )
    for fn in resolution_fns:
        params = set(inspect.signature(fn).parameters)
        assert not (
            params & {"input_payload", "payload", "event", "tool_result", "runtime", "values"}
        ), f"{fn.__name__} exposes a runtime-data parameter — reopens the §5 injection vector"


# ── Author-time validation through the orchestration builder API (ADR-0015 §6) ─


@pytest.fixture
def orch_app() -> Generator[FastAPI]:
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

    async def _seed_component() -> None:
        async with session_factory() as session:
            session.add(
                PromptComponent(
                    tenant_id=TENANT,
                    name="house-style",
                    body="Be concise.",
                    variables=[],
                )
            )
            await session.commit()

    asyncio.run(_seed_component())

    fastapi = FastAPI()
    fastapi.include_router(orchestration.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: AuthenticatedUser(
        sub="a", email="a@x.com", username="a", tenant_id=TENANT, roles=["admin"]
    )
    yield fastapi
    asyncio.run(engine.dispose())


@pytest.fixture
def orch_client(orch_app) -> TestClient:
    return TestClient(orch_app)


def _agent_definition(instructions) -> dict:
    return {
        "name": "scorer",
        "trigger_source": "biffo.core",
        "trigger_detail_type": "demo.requested",
        "action_type": "agent",
        "action_config": {"agent_name": "scorer", "instructions": instructions},
        "enabled": True,
    }


_WORKFLOWS = "/api/v1/orchestration/workflows"


def test_author_time_accepts_a_definition_referencing_an_existing_component(orch_client):
    resp = orch_client.post(_WORKFLOWS, json=_agent_definition([{"component": "house-style"}]))
    assert resp.status_code == 201


def test_author_time_rejects_a_reference_to_a_missing_component(orch_client):
    resp = orch_client.post(_WORKFLOWS, json=_agent_definition([{"component": "no-such"}]))
    assert resp.status_code == 422
    assert "no-such" in resp.json()["detail"]


def test_author_time_rejects_an_undeclared_value_key(orch_client):
    resp = orch_client.post(
        _WORKFLOWS,
        json=_agent_definition([{"component": "house-style", "values": {"region": "x"}}]),
    )
    assert resp.status_code == 422


def test_author_time_rejects_a_malformed_part_shape(orch_client):
    # Both inline and component on one part — caught by the body schema (422).
    resp = orch_client.post(
        _WORKFLOWS, json=_agent_definition([{"inline": "x", "component": "house-style"}])
    )
    assert resp.status_code == 422
