"""The plugin-workflow-seed race, against REAL Postgres (biffo-template#1593/#1633).

Why this file exists as well as the sqlite tests in
``test_internal_plugin_workflows_seed.py``: **the concurrent cold-start race is a
property of genuine parallel transactions, and sqlite is not that.** A single
connection (the ``StaticPool`` fixture the sqlite suite uses) cannot express two
overlapping writers at all, so that suite's
``test_a_pre_read_race_falls_back_to_updating_the_winners_row`` proves the
``except IntegrityError`` branch's own logic by *simulating* the interleaving —
patching ``_existing_by_key`` to return what a concurrent pre-read would have
seen. This file proves the same branch fires, unforced, under real concurrent
Postgres sessions — the thing #1593's own reasoning names as load-bearing
(simultaneous Lambda cold starts racing past the pre-read after a deploy, #924)
and the prosecutor's pre-merge gate on PR #1633 explicitly demonstrated live
before asking for it to be captured as a test.

**This file does not move the required "Error-branch coverage" gate.** That gate
reads ``coverage.json`` from the plain ``uv run pytest --cov`` run in
``ci.yml``'s `python` job, which provisions no Postgres — `test_*_pg.py` modules
skip there via ``pytest.mark.skipif`` below, exactly as this repo's other
`test_*_pg.py` files already do. `scripts/second_coverage_lane.py --check`
confirms this repo declares no second coverage lane (no workflow here publishes
the `rls-coverage` artefact the gate would otherwise combine), so the sqlite
suite's coverage is what the gate actually judges. This file exists for the
same reason its sibling `test_media_generation_idempotency_pg.py` and
`test_agent_run_claim_race.py` do: proving the guarantee holds under the
database the code actually runs against is a stronger claim than a passing
gate, not a redundant one.

Two fixtures, deliberately, mirroring ``test_media_generation_idempotency_pg.py``:
``schema`` builds ``orchestration_workflow_definitions`` from ORM metadata inside
a throwaway Postgres schema private to this run, so these tests neither depend on
the lane database's migration state nor leave rows in a database reused across
sessions. ``app`` wires the real FastAPI router (not a call to the domain
function directly) over that schema, so the concurrency test below drives the
same code path a real cold-start burst does — request in, router out — rather
than a lower-level function.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.orchestration import WorkflowDefinition
from api.routers import internal_plugin_workflows
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Table, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

TENANT = "default"
_SEED_URL = "/api/v1/internal/plugins/me/workflows/seed"

# A permanently-declared registry event (events/registry.py), same fixture the
# sqlite suite uses, so `_require_known_trigger` passes without a TriggerCatalog
# row or table.
_TRIGGER_SOURCE = "biffo.core"
_TRIGGER_DETAIL_TYPE = "demo.requested"


def _pg_dsn() -> str | None:
    # Both names, deliberately: `scripts/pg-test-db.sh --export` sets both
    # (tabsii-platform#755), and different consumers read one or the other.
    return os.environ.get("BIFFO_TEST_PG_DSN") or os.environ.get("TABSII_TEST_PG_DSN")


pytestmark = pytest.mark.skipif(
    _pg_dsn() is None,
    reason='no real Postgres DSN -- eval "$(sh scripts/pg-test-db.sh --export)"',
)

# Deliberately NOT marked `serial`. Every test here works inside a schema whose
# name carries a fresh uuid4 fragment, so two workers cannot collide on an
# object name.


def _principal(plugin: str = "marketing") -> ServicePrincipal:
    return ServicePrincipal(
        principal_arn=f"arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-{plugin}-role/session"
    )


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


@pytest_asyncio.fixture
async def schema() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    """``orchestration_workflow_definitions`` in a throwaway Postgres schema."""
    dsn = _pg_dsn()
    assert dsn is not None  # narrows for pyright; skipif already checked
    name = f"wfseed_{uuid.uuid4().hex[:10]}"

    table = WorkflowDefinition.__table__
    assert isinstance(table, Table)  # narrows for pyright; declarative always is

    engine = create_async_engine(dsn)
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{name}"'))
        await conn.execute(text(f'SET search_path TO "{name}"'))
        # checkfirst=False and tables=[table]: only this one table (plus its
        # own uq_orch_def_owner_key index, attached via __table_args__), same
        # pattern as test_media_generation_idempotency_pg.py.
        await conn.run_sync(Base.metadata.create_all, tables=[table], checkfirst=False)
    await engine.dispose()

    # A fresh engine pinned to the schema, so every session below resolves the
    # unqualified table name to this run's copy.
    scoped = create_async_engine(dsn, connect_args={"server_settings": {"search_path": name}})
    yield async_sessionmaker(scoped, expire_on_commit=False)
    await scoped.dispose()

    cleanup = create_async_engine(dsn)
    async with cleanup.begin() as conn:
        await conn.execute(text(f'DROP SCHEMA "{name}" CASCADE'))
    await cleanup.dispose()


@pytest_asyncio.fixture
async def app(schema: async_sessionmaker[AsyncSession]) -> FastAPI:
    """The real router, wired to the throwaway schema via `get_db`."""

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with schema() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    fastapi_app = FastAPI()
    fastapi_app.include_router(internal_plugin_workflows.router, prefix="/api/v1")
    fastapi_app.dependency_overrides[get_db] = override_get_db
    fastapi_app.dependency_overrides[require_service_principal] = lambda: _principal("marketing")
    return fastapi_app


async def _count(session_factory: async_sessionmaker[AsyncSession]) -> int:
    async with session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(WorkflowDefinition)) or 0)


# --- the migration's NULL-semantics claim, on the engine production runs ----


@pytest.mark.asyncio
async def test_two_admin_rows_both_null_null_do_not_collide(schema) -> None:
    """0020's own docstring: admin rows are always ``(owner_plugin,
    definition_key) = (NULL, NULL)`` together, and a composite unique index
    with a NULL participant does not constrain the row *at all* on Postgres —
    unlike a single-nullable-column index, no COALESCE trick is needed here.
    Confirmed against the real engine, not merely read from the migration's
    comment.
    """
    async with schema() as s1:
        s1.add(
            WorkflowDefinition(
                tenant_id=TENANT,
                name="Admin rule A",
                trigger_source=_TRIGGER_SOURCE,
                trigger_detail_type=_TRIGGER_DETAIL_TYPE,
                action_type="email",
                action_config={},
            )
        )
        await s1.commit()

    async with schema() as s2:
        s2.add(
            WorkflowDefinition(
                tenant_id=TENANT,
                name="Admin rule B",
                trigger_source=_TRIGGER_SOURCE,
                trigger_detail_type=_TRIGGER_DETAIL_TYPE,
                action_type="email",
                action_config={},
            )
        )
        await s2.commit()

    assert await _count(schema) == 2


@pytest.mark.asyncio
async def test_two_plugin_rows_under_the_same_natural_key_raise_integrity_error(schema) -> None:
    """The constraint itself, direct: two rows sharing (tenant_id, owner_plugin,
    definition_key) collide on Postgres, which is what makes the router's
    ``except IntegrityError`` branch meaningful rather than dead code."""
    async with schema() as s1:
        s1.add(
            WorkflowDefinition(
                tenant_id=TENANT,
                owner_plugin="marketing",
                definition_key="fan-in",
                name="First",
                trigger_source=_TRIGGER_SOURCE,
                trigger_detail_type=_TRIGGER_DETAIL_TYPE,
                action_type="email",
                action_config={},
            )
        )
        await s1.commit()

    with pytest.raises(IntegrityError):
        async with schema() as s2:
            s2.add(
                WorkflowDefinition(
                    tenant_id=TENANT,
                    owner_plugin="marketing",
                    definition_key="fan-in",
                    name="Second",
                    trigger_source=_TRIGGER_SOURCE,
                    trigger_detail_type=_TRIGGER_DETAIL_TYPE,
                    action_type="email",
                    action_config={},
                )
            )
            await s2.commit()


# --- the untested branch: genuinely concurrent cold starts through the router


@pytest.mark.asyncio
async def test_concurrent_seed_requests_race_the_pre_read_without_500_or_duplicate(
    app: FastAPI, schema
) -> None:
    """THE branch CI flagged as never having executed anywhere.

    Five genuinely concurrent ``POST /internal/plugins/me/workflows/seed``
    requests for a brand-new ``definition_key`` — real async Postgres sessions,
    real router, real HTTP layer (`httpx.AsyncClient` over `ASGITransport`, not
    `TestClient`, which would serialise them). A burst this size is what a
    fresh deploy replacing every warm Lambda at once (#924) actually produces.

    Fails without the `except IntegrityError` handler (or with a bare
    ``raise``): the losers' unhandled `IntegrityError` would surface as 500s
    instead of 200s, which the status assertions below catch; a check-then-act
    implementation with no SAVEPOINT retry would instead leave duplicate rows,
    which the row-count assertion catches.
    """
    transport = ASGITransport(app=app)

    async def post(subject: str):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                _SEED_URL,
                json=[
                    _definition(
                        action_config={
                            "from": "no-reply@example.com",
                            "to": "ops@example.com",
                            "subject": subject,
                            "body": "body",
                        }
                    )
                ],
            )

    responses = await asyncio.gather(*(post(f"Request {i}") for i in range(5)))

    for i, resp in enumerate(responses):
        assert resp.status_code == 200, f"request {i}: {resp.text}"

    # Exactly one row survives the race, never five.
    assert await _count(schema) == 1

    bodies = [r.json()[0] for r in responses]
    definition_ids = {b["definition_id"] for b in bodies}
    assert len(definition_ids) == 1, "every request must land on the SAME row"

    created_flags = [b["created"] for b in bodies]
    assert created_flags.count(True) == 1, (
        f"exactly one request may win the insert, got {created_flags}"
    )
    assert created_flags.count(False) == 4, (
        f"the other four must report an update via the retry path, got {created_flags}"
    )

    # Whichever request's write landed last wins (the router's own docstring),
    # so the stored row's subject must be SOME participant's declared value —
    # never a partial/corrupted merge of more than one.
    async with schema() as session:
        row = await session.scalar(
            select(WorkflowDefinition).where(
                WorkflowDefinition.tenant_id == TENANT,
                WorkflowDefinition.owner_plugin == "marketing",
                WorkflowDefinition.definition_key == "fan-in",
            )
        )
    assert row is not None
    subjects = {f"Request {i}" for i in range(5)}
    assert row.action_config["subject"] in subjects
