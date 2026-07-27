"""The write-back executor (ADR-0027 §2/§5/§7).

These cover the security-critical path, so they are written around the refusals
rather than the happy path: the write must not happen when the owner's authority
has gone, when the session cannot be bound to them, when the same completion is
replayed, or when the caller was never named on the target.

The suite runs on SQLite, which has no row-level security — so the *policy*
half is asserted structurally here (the session is bound before the write; a
refusal aborts) and behaviourally in the instance's real-PostgreSQL E2E.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Generator
from typing import Any

import pytest
from api import writeback_targets as wb
from api.database import get_db
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.agent_run import AgentRun
from api.models.base import Base, TenantScopedModel
from api.models.orchestration import ActionLog, WorkflowDefinition, WorkflowRun
from api.routers import internal_orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import String, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.pool import StaticPool

_URL = "/api/v1/internal/orchestration/writeback"


class Note(TenantScopedModel):
    """A stand-in business table — deliberately not a real core model, because a
    write-back target is always an instance's own table."""

    __tablename__ = "wb_notes"

    brand_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    notes: Mapped[str | None] = mapped_column(String(500), nullable=True)


def _target(**over: Any) -> wb.WriteBackTarget:
    kwargs: dict[str, Any] = {
        "table": "wb_notes",
        "model": Note,
        "label": "Note",
        "permission_code": "notes.create",
        "allowed_principals": ("system:orchestrator",),
        "columns": (
            wb.WriteBackColumn(name="email", label="Email", type="email", required=True),
            wb.WriteBackColumn(name="notes", label="Notes", type="textarea", overwrite="append"),
        ),
        "operations": ("create", "update"),
        "derived": (
            wb.from_tenant(),
            wb.from_scope("brand_id", "brand"),
            wb.literal("source", "agent"),
        ),
        "row_selector": wb.RowSelector(payload_field="note_id"),
    }
    kwargs.update(over)
    return wb.WriteBackTarget(**kwargs)


class _NoPermissions:
    """An identity provider that answers without touching a database.

    The executor re-checks the workflow owner's *current* permissions through
    whichever provider is installed, so these tests must install one — otherwise
    they run against whatever the process happens to have. Neither real provider
    works here: the default reads `public.users` and an instance's reads its own
    tables (tabsii's queries `tabsii.user_role_assignments`), and this SQLite
    fixture has schema for neither.

    Returning an empty set is also the case worth pinning. The executor treats
    "no permissions resolved" as "this deployment does not model permissions
    that way" and lets the row policies decide, rather than as a denial — so
    these tests exercise the write path itself. The permission re-check is
    covered against real role assignments in the instance E2E, which is the only
    place it can mean anything.
    """

    async def resolve(self, db, user_id):  # noqa: ANN001, ANN201 — test double
        del db, user_id
        return frozenset()

    async def resolve_identity(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN201
        raise NotImplementedError

    async def sync_platform_admin(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN201
        return None

    async def resolve_permissions(self, db, user_id):  # noqa: ANN001, ANN201
        del db, user_id
        return frozenset()


@pytest.fixture(autouse=True)
def _identity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Install the no-database provider for every test in this module.

    Patched **on the consuming module** rather than on `api.identity`'s global.
    An instance installs its own provider as an import side effect of `api.main`
    (tabsii: `set_identity_provider(TabsiiIdentityProvider())`), and in a full
    suite run that can land after this fixture has set the global — which is
    exactly how these tests passed in isolation and failed once distributed.
    Patching the name the executor actually calls cannot be undone by whoever
    imports what, and in whichever order.
    """
    monkeypatch.setattr("api.writeback.get_identity_provider", lambda: _NoPermissions())


@pytest.fixture(autouse=True)
def _registry(app) -> Generator[None]:  # noqa: ANN001 — ordering: after the app exists
    saved_targets, saved_provider = dict(wb._targets), wb._provider  # noqa: SLF001
    wb._targets.clear()  # noqa: SLF001
    wb.register_writeback_target(_target())

    async def _bind(db: AsyncSession, user_id: str) -> bool:
        del db, user_id
        return True

    wb.register_principal_session_provider(_bind)
    yield
    wb._targets.clear()  # noqa: SLF001
    wb._targets.update(saved_targets)  # noqa: SLF001
    wb._provider = saved_provider  # noqa: SLF001


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
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    fastapi = FastAPI()
    fastapi.include_router(internal_orchestration.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-orchestrator-role/x"
    )
    yield fastapi, factory
    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app[0])


async def _seed(
    factory: async_sessionmaker,
    *,
    run_as: str | None = "user-a",
    status: str = "completed",
    result: dict | None = None,
    writeback: dict | None = None,
    scope: dict | None = None,
    existing_note: Note | None = None,
    input_payload: dict | None = None,
) -> str:
    """A definition -> workflow run -> completed agent run chain. Returns the
    agent run id."""
    async with factory() as session:
        definition = WorkflowDefinition(
            tenant_id="default",
            name="Record it",
            trigger_source="biffo.core",
            trigger_detail_type="demo.requested",
            action_type="agent",
            action_config={},
            enabled=True,
            scope=scope if scope is not None else {"level": "brand", "id": "b1"},
            run_as_user_id=run_as,
            run_as_kind="user" if run_as else "system",
        )
        session.add(definition)
        await session.flush()
        workflow_run = WorkflowRun(
            tenant_id="default",
            definition_id=definition.id,
            dedupe_key=f"trigger:{definition.id}",
            trigger_event={},
            status="dispatched",
        )
        session.add(workflow_run)
        await session.flush()
        agent_run = AgentRun(
            tenant_id="default",
            agent_name="recorder",
            status=status,
            workflow_run_id=workflow_run.id,
            definition_snapshot={
                "writeback": writeback
                if writeback is not None
                else {
                    "table": "wb_notes",
                    "operation": "create",
                    "columns": {"email": "{output.email}", "notes": "{output.notes}"},
                }
            },
            input_payload=input_payload or {},
            result=result if result is not None else {"email": "a@b.com", "notes": "Looks good"},
        )
        session.add(agent_run)
        if existing_note is not None:
            session.add(existing_note)
        await session.flush()
        await session.commit()
        return agent_run.id


def _post(client: TestClient, agent_run_id: str):
    return client.post(_URL, json={"agent_run_id": agent_run_id})


# ── The happy path ────────────────────────────────────────────────────────────


def test_a_completed_run_writes_its_row_with_core_set_columns(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory))

    body = _post(client, run_id).json()
    assert body["status"] == "written", body

    async def _read() -> Note:
        async with factory() as session:
            return (await session.execute(select(Note))).scalar_one()

    note = asyncio.run(_read())
    assert note.email == "a@b.com"
    assert note.notes == "Looks good"
    # Core-set, never from the model: the tenant seam, the scope the definition
    # was validated against, and the provenance marker.
    assert note.tenant_id == "default"
    assert note.brand_id == "b1"
    assert note.source == "agent"


def test_the_write_is_recorded_as_an_auditable_run(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory))
    _post(client, run_id)

    async def _logs() -> list[ActionLog]:
        async with factory() as session:
            return list((await session.execute(select(ActionLog))).scalars())

    logs = asyncio.run(_logs())
    assert [log.status for log in logs] == ["succeeded"]
    assert logs[0].action_type == "writeback"
    # The request is never recorded — it would echo config that can carry a
    # credential (#432).
    assert logs[0].request is None


# ── Exactly once ──────────────────────────────────────────────────────────────


def test_a_redelivered_completion_writes_exactly_one_row(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory))

    first = _post(client, run_id).json()
    second = _post(client, run_id).json()
    assert first["status"] == "written"
    assert second["status"] == "duplicate"

    async def _count() -> int:
        async with factory() as session:
            return len(list((await session.execute(select(Note))).scalars()))

    assert asyncio.run(_count()) == 1


# ── Refusals ──────────────────────────────────────────────────────────────────


def test_a_run_whose_workflow_records_no_owner_is_denied(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory, run_as=None))
    body = _post(client, run_id).json()
    assert body["status"] == "denied"
    assert "no owner" in body["reason"]


def test_the_write_is_refused_when_the_session_cannot_be_bound_to_the_owner(app, client):
    _, factory = app

    async def _refuse(db: AsyncSession, user_id: str) -> bool:
        del db, user_id
        return False

    wb.register_principal_session_provider(_refuse)
    run_id = asyncio.run(_seed(factory))

    body = _post(client, run_id).json()
    assert body["status"] == "denied"
    assert "could not be authorized" in body["reason"]

    async def _count() -> int:
        async with factory() as session:
            return len(list((await session.execute(select(Note))).scalars()))

    # The point of the seam: nothing is written on an unbound session.
    assert asyncio.run(_count()) == 0


def test_the_template_default_provider_refuses_so_nothing_is_written(app, client):
    _, factory = app
    wb._provider = wb._default_provider  # noqa: SLF001
    run_id = asyncio.run(_seed(factory))
    assert _post(client, run_id).json()["status"] == "denied"


def test_a_principal_the_target_never_named_cannot_even_tell_it_exists(app, client):
    fastapi, factory = app
    fastapi.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-someone-else-role/x"
    )
    run_id = asyncio.run(_seed(factory))
    assert _post(client, run_id).status_code == 404


def test_an_unknown_run_is_the_same_404(client):
    assert _post(client, "no-such-run").status_code == 404


def test_a_run_that_did_not_succeed_writes_nothing(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory, status="failed"))
    assert _post(client, run_id).json()["status"] == "skipped"


def test_a_run_with_no_writeback_declared_writes_nothing(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory, writeback={}))
    assert _post(client, run_id).json()["status"] == "skipped"


def test_a_run_returning_prose_rather_than_the_submitted_record_is_denied(app, client):
    _, factory = app
    run_id = asyncio.run(_seed(factory, result={"output": "I had a think about it."}))
    body = _post(client, run_id).json()
    assert body["status"] == "denied"
    assert "required column" in body["reason"]


def test_a_value_outside_the_declared_columns_is_never_written(app, client):
    _, factory = app
    # The model returns a column the workflow did not declare — and one it could
    # not declare, since brand_id is Core-set.
    run_id = asyncio.run(
        _seed(factory, result={"email": "a@b.com", "notes": "ok", "brand_id": "b-somewhere-else"})
    )
    assert _post(client, run_id).json()["status"] == "written"

    async def _read() -> Note:
        async with factory() as session:
            return (await session.execute(select(Note))).scalar_one()

    # The scope's brand, not the model's.
    assert asyncio.run(_read()).brand_id == "b1"


# ── Update ────────────────────────────────────────────────────────────────────


def test_an_update_amends_the_row_the_trigger_event_identified(app, client):
    _, factory = app
    existing = Note(id="note-9", tenant_id="default", email="old@b.com", notes="Typed by a person")
    run_id = asyncio.run(
        _seed(
            factory,
            writeback={
                "table": "wb_notes",
                "operation": "update",
                "columns": {"email": "x", "notes": "y"},
            },
            result={"email": "new@b.com", "notes": "And the agent's view"},
            existing_note=existing,
            input_payload={"note_id": "note-9"},
        )
    )
    assert _post(client, run_id).json()["status"] == "written"

    async def _read() -> Note:
        async with factory() as session:
            return (await session.execute(select(Note).where(Note.id == "note-9"))).scalar_one()

    note = asyncio.run(_read())
    # `email` is if_empty by default and was populated, so the human's value stands.
    assert note.email == "old@b.com"
    # `notes` is declared append, so the agent adds to it rather than replacing.
    assert note.notes == "Typed by a person\n\nAnd the agent's view"


def test_an_update_whose_trigger_carries_no_row_id_is_denied(app, client):
    _, factory = app
    run_id = asyncio.run(
        _seed(
            factory,
            writeback={"table": "wb_notes", "operation": "update", "columns": {"email": "x"}},
            input_payload={},
        )
    )
    body = _post(client, run_id).json()
    assert body["status"] == "denied"
    assert "no matching row" in body["reason"]
