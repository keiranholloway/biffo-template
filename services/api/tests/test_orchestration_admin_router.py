"""Integration tests for the user-facing workflow-definition CRUD router
(/api/v1/orchestration/workflows). Drives real HTTP through FastAPI's TestClient
against in-memory SQLite. Auth is faked by overriding require_auth (require_admin
depends on it): an admin caller for the happy paths, a non-admin for the 403.

The StaticPool/in-memory-SQLite fixture mirrors test_core_crud_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.events.emit import is_declared, pending_events
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.models.orchestration import (  # noqa: F401 — registers tables on Base.metadata
    ActionLog,
    TriggerCatalog,
    WorkflowDefinition,
    WorkflowRun,
)
from api.orchestration import observe_trigger
from api.routers import orchestration
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_BASE = "/api/v1/orchestration/workflows"


def _caller(tenant_id: str = "default", roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"] if roles is None else roles,
    )


def _valid_body(**over) -> dict:
    body = {
        "name": "Notify sales",
        "trigger_source": "biffo.core",
        "trigger_detail_type": "demo.requested",
        "action_type": "email",
        "action_config": {
            "from": "no-reply@example.com",
            "to": "sales@example.com",
            "subject": "New demo from {company}",
            "body": "Contact {email}",
        },
        "enabled": True,
    }
    body.update(over)
    return body


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

    # Record events buffered on the session post-commit (emit_event, ADR-0002) so
    # tests can assert what would reach the bus — the real get_db publishes them.
    published: list = []

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
                published.extend(pending_events(session))
            except Exception:
                await session.rollback()
                raise

    fastapi = FastAPI()
    fastapi.include_router(orchestration.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: _caller()
    fastapi.state.published = published

    yield fastapi, session_factory

    asyncio.run(engine.dispose())


@pytest.fixture
def client(app) -> TestClient:
    fastapi, _ = app
    return TestClient(fastapi)


def test_create_then_list_and_get(client: TestClient):
    created = client.post(_BASE, json=_valid_body())
    assert created.status_code == 201
    row = created.json()
    assert row["name"] == "Notify sales"
    assert row["enabled"] is True
    assert row["id"]

    listed = client.get(_BASE)
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()] == [row["id"]]

    got = client.get(f"{_BASE}/{row['id']}")
    assert got.status_code == 200
    assert got.json()["action_config"]["to"] == "sales@example.com"


def test_trigger_filter_round_trips(client: TestClient):
    # A payload filter is optional; when set it persists and comes back on read,
    # so the builder can edit it (#226).
    created = client.post(_BASE, json=_valid_body(trigger_filter={"status": "won"}))
    assert created.status_code == 201, created.text
    assert created.json()["trigger_filter"] == {"status": "won"}

    got = client.get(f"{_BASE}/{created.json()['id']}")
    assert got.json()["trigger_filter"] == {"status": "won"}


def test_trigger_filter_defaults_to_null(client: TestClient):
    created = client.post(_BASE, json=_valid_body())
    assert created.status_code == 201
    assert created.json()["trigger_filter"] is None


def test_update_can_set_and_clear_trigger_filter(client: TestClient):
    row = client.post(_BASE, json=_valid_body(trigger_filter={"status": "won"})).json()

    cleared = client.put(f"{_BASE}/{row['id']}", json=_valid_body(trigger_filter=None))
    assert cleared.status_code == 200
    assert cleared.json()["trigger_filter"] is None


def test_create_rejects_invalid_action_config(client: TestClient):
    body = _valid_body(action_config={"from": "no-reply@example.com"})  # missing to/subject/body
    resp = client.post(_BASE, json=body)
    assert resp.status_code == 422


def test_create_rejects_bad_email(client: TestClient):
    body = _valid_body(
        action_config={
            "from": "not-an-email",
            "to": "sales@example.com",
            "subject": "s",
            "body": "b",
        }
    )
    assert client.post(_BASE, json=body).status_code == 422


def test_create_rejects_unknown_trigger(client: TestClient):
    assert client.post(_BASE, json=_valid_body(trigger_detail_type="nope")).status_code == 422


def test_update_and_toggle(client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()

    updated = client.put(f"{_BASE}/{row['id']}", json=_valid_body(name="Renamed", enabled=True))
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"

    toggled = client.post(f"{_BASE}/{row['id']}/enabled", json={"enabled": False})
    assert toggled.status_code == 200
    assert toggled.json()["enabled"] is False


def test_delete(client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()
    assert client.delete(f"{_BASE}/{row['id']}").status_code == 204
    assert client.get(f"{_BASE}/{row['id']}").status_code == 404


def test_missing_returns_404(client: TestClient):
    assert client.get(f"{_BASE}/does-not-exist").status_code == 404
    assert client.delete(f"{_BASE}/does-not-exist").status_code == 404


def test_catalog(client: TestClient):
    resp = client.get(f"{_BASE}/catalog")
    assert resp.status_code == 200
    body = resp.json()
    assert any(t["detail_type"] == "demo.requested" for t in body["triggers"])
    # declared events are tagged so the UI can badge them
    assert all(
        t["origin"] == "declared" for t in body["triggers"] if t["detail_type"] == "demo.requested"
    )
    assert any(a["type"] == "email" for a in body["actions"])


# ── chat actions: google_chat + whatsapp ─────────────────────────────────────


def test_catalog_offers_chat_actions(client: TestClient):
    body = client.get(f"{_BASE}/catalog").json()
    types = {a["type"] for a in body["actions"]}
    assert {"email", "google_chat", "whatsapp"} <= types


def test_create_google_chat_workflow(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="google_chat",
            action_config={
                "webhook_url": "https://chat.googleapis.com/v1/spaces/A/messages?key=k",
                "message": "New demo from {company}",
            },
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_type"] == "google_chat"


def test_google_chat_requires_webhook_url(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(action_type="google_chat", action_config={"message": "hi"}),
    )
    assert resp.status_code == 422


def test_google_chat_rejects_non_https_webhook(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="google_chat",
            action_config={"webhook_url": "http://insecure/x", "message": "hi"},
        ),
    )
    assert resp.status_code == 422


def test_create_whatsapp_workflow(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={"to": "+15551234567", "message": "Hi {company}"},
        ),
    )
    assert resp.status_code == 201, resp.text


def test_whatsapp_requires_recipient(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(action_type="whatsapp", action_config={"message": "hi"}),
    )
    assert resp.status_code == 422


def test_create_whatsapp_template_workflow(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={
                "to": "+15551234567",
                "message_type": "template",
                "template_name": "demo_booked",
                "language_code": "en_US",
                "template_params": "{company}",
            },
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_config"]["message_type"] == "template"


def test_whatsapp_template_requires_template_name(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={"to": "+1", "message_type": "template"},
        ),
    )
    assert resp.status_code == 422


def test_whatsapp_template_does_not_require_the_text_message(client: TestClient):
    """`message` only applies to the text branch — a template send omits it."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={
                "to": "+1",
                "message_type": "template",
                "template_name": "demo_booked",
            },
        ),
    )
    assert resp.status_code == 201, resp.text


def test_whatsapp_template_language_defaults_when_omitted(client: TestClient):
    """`language_code` is required but carries a catalog default, so omitting
    it is accepted — the handler sends en_US."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={
                "to": "+1",
                "message_type": "template",
                "template_name": "demo_booked",
            },
        ),
    )
    assert resp.status_code == 201, resp.text


def test_whatsapp_rejects_unknown_message_type(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={"to": "+1", "message_type": "image", "message": "hi"},
        ),
    )
    assert resp.status_code == 422


def test_whatsapp_defaults_to_the_text_branch(client: TestClient):
    """A definition saved before message_type existed still validates as text —
    i.e. `message` is still required when the toggle is absent."""
    resp = client.post(
        _BASE,
        json=_valid_body(action_type="whatsapp", action_config={"to": "+1", "message": "hi"}),
    )
    assert resp.status_code == 201, resp.text

    resp = client.post(_BASE, json=_valid_body(action_type="whatsapp", action_config={"to": "+1"}))
    assert resp.status_code == 422


def _observe(session_factory, source: str, detail_type: str) -> None:
    async def _run() -> None:
        async with session_factory() as session:
            await observe_trigger(
                session, tenant_id="default", source=source, detail_type=detail_type
            )
            await session.commit()

    asyncio.run(_run())


def test_observed_trigger_appears_in_catalog_and_is_selectable(app, client: TestClient):
    _, session_factory = app
    # An event the code registry does not name is seen on the bus...
    _observe(session_factory, "biffo.core", "brand.approved")

    body = client.get(f"{_BASE}/catalog").json()
    observed = [t for t in body["triggers"] if t["detail_type"] == "brand.approved"]
    assert observed and observed[0]["origin"] == "observed"

    # ...and is now a valid pick (validation accepts registry ∪ observed).
    created = client.post(_BASE, json=_valid_body(trigger_detail_type="brand.approved"))
    assert created.status_code == 201


def test_observe_trigger_is_idempotent(app):
    _, session_factory = app
    _observe(session_factory, "biffo.core", "unit.onboarded")
    _observe(session_factory, "biffo.core", "unit.onboarded")

    async def _count() -> int:
        from sqlalchemy import func, select

        async with session_factory() as session:
            result = await session.execute(select(func.count()).select_from(TriggerCatalog))
            return result.scalar_one()

    assert asyncio.run(_count()) == 1


def test_unknown_trigger_not_observed_is_rejected(client: TestClient):
    # Not in the registry and never observed -> 422.
    resp = client.post(_BASE, json=_valid_body(trigger_detail_type="never.seen"))
    assert resp.status_code == 422


def test_tenant_isolation(app, client: TestClient):
    _, session_factory = app

    async def _seed_other_tenant() -> None:
        async with session_factory() as session:
            session.add(
                WorkflowDefinition(
                    tenant_id="other-tenant",
                    name="Other tenant workflow",
                    trigger_source="biffo.core",
                    trigger_detail_type="demo.requested",
                    action_type="email",
                    action_config={},
                    enabled=True,
                )
            )
            await session.commit()

    asyncio.run(_seed_other_tenant())

    # Caller is tenant "default" — must not see the other tenant's row.
    assert client.get(_BASE).json() == []


def test_non_admin_is_forbidden(app, client: TestClient):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=[])
    assert client.get(_BASE).status_code == 403
    assert client.post(_BASE, json=_valid_body()).status_code == 403


def test_catalog_includes_declared_crud_events(client: TestClient, monkeypatch):
    from api.models.plugin_table import PermissionRule, TablePermissions

    registry = {
        "widgets": TablePermissions(
            create=PermissionRule(allowed=True), update=PermissionRule(allowed=True)
        )
    }
    # The catalog endpoint reads the permissions registry directly (imported name).
    monkeypatch.setattr("api.routers.orchestration.get_permissions_registry", lambda **_: registry)

    body = client.get(f"{_BASE}/catalog").json()
    by_dt = {t["detail_type"]: t for t in body["triggers"]}
    # Every allowed CRUD op is a declared trigger, shown before it ever fires.
    assert by_dt["widgets.created"]["origin"] == "declared"
    assert by_dt["widgets.updated"]["origin"] == "declared"
    # delete not allowed -> not offered
    assert "widgets.deleted" not in by_dt
    # registry business events are still present
    assert "demo.requested" in by_dt


# --- workflow-definition state-change events (ADR-0002, #225) ----------------


def _published(app) -> list:
    fastapi, _ = app
    return fastapi.state.published


def test_create_emits_workflow_definition_created(app, client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()

    events = _published(app)
    assert len(events) == 1
    event = events[0]
    assert (event.source, event.detail_type) == (
        "biffo.core",
        "workflow_definition.created",
    )
    assert is_declared(event.source, event.detail_type)  # compliance gate
    assert event.payload["id"] == row["id"]
    assert event.payload["name"] == "Notify sales"


def test_update_emits_workflow_definition_updated(app, client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()
    _published(app).clear()

    client.put(f"{_BASE}/{row['id']}", json=_valid_body(name="Renamed"))

    events = _published(app)
    assert len(events) == 1
    assert events[0].detail_type == "workflow_definition.updated"
    assert events[0].payload["name"] == "Renamed"


def test_toggle_emits_workflow_definition_updated(app, client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()
    _published(app).clear()

    client.post(f"{_BASE}/{row['id']}/enabled", json={"enabled": False})

    events = _published(app)
    assert len(events) == 1
    assert events[0].detail_type == "workflow_definition.updated"
    assert events[0].payload["enabled"] is False


def test_delete_emits_workflow_definition_deleted(app, client: TestClient):
    row = client.post(_BASE, json=_valid_body()).json()
    _published(app).clear()

    assert client.delete(f"{_BASE}/{row['id']}").status_code == 204

    events = _published(app)
    assert len(events) == 1
    assert events[0].detail_type == "workflow_definition.deleted"
    assert events[0].payload["id"] == row["id"]


def test_create_accepts_a_declared_crud_trigger(client: TestClient, monkeypatch):
    from api.models.plugin_table import PermissionRule, TablePermissions

    registry = {"widgets": TablePermissions(create=PermissionRule(allowed=True))}
    # is_known_trigger -> is_declared lazily imports get_permissions_registry
    # from api.permissions, so patch it there.
    monkeypatch.setattr("api.permissions.get_permissions_registry", lambda **_: registry)

    resp = client.post(_BASE, json=_valid_body(trigger_detail_type="widgets.created"))
    assert resp.status_code == 201, resp.text


# ── agent action (ADR-0014 §4): a worker is bound by a workflow definition ───


def test_catalog_offers_the_agent_action_with_its_m1_fields(client: TestClient):
    body = client.get(f"{_BASE}/catalog").json()
    action = next(a for a in body["actions"] if a["type"] == "agent")
    fields = {f["name"]: f for f in action["config_fields"]}
    # Deliberately minimal in M1 — tools and read scope are M2/M3.
    assert set(fields) == {"agent_name", "instructions", "model", "max_turns"}
    assert fields["agent_name"]["required"] and fields["instructions"]["required"]
    assert fields["model"]["default"]
    assert fields["max_turns"]["default"] == 1


def test_create_agent_workflow(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent",
            action_config={
                "agent_name": "demo-enricher",
                "instructions": "Enrich the inbound demo request for {company}.",
            },
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_type"] == "agent"


def test_agent_workflow_requires_instructions(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(action_type="agent", action_config={"agent_name": "demo-enricher"}),
    )
    assert resp.status_code == 422
