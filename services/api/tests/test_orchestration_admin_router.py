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


# ── agent action surfaces the runtime's declared tools (ADR-0014 §7) ──────────


def _agent_action(client: TestClient) -> dict:
    body = client.get(f"{_BASE}/catalog").json()
    return next(a for a in body["actions"] if a["type"] == "agent")


def test_catalog_surfaces_agent_runtime_tools_as_available_tools(client: TestClient):
    # The agent runtime's manifest declares web_search; Core reads it off the
    # discovered manifest (never importing the runtime) and surfaces it so Part B
    # can build a tool picker from the runtime's own registry.
    agent = _agent_action(client)
    tools = agent["available_tools"]
    by_name = {t["name"]: t for t in tools}
    assert "web_search" in by_name
    assert by_name["web_search"]["description"]
    # Parameters ride along so the picker can label/describe the tool fully.
    assert by_name["web_search"]["parameters"]["type"] == "object"


def test_available_tools_is_not_a_config_field(client: TestClient):
    # The builder renders config_fields by type and does not yet understand a tool
    # picker; the tools must ride as SEPARATE data it ignores, never a config_field
    # (a multiselect field arrives in Part B). If this regresses, the builder page
    # could render nothing for the unknown field type.
    agent = _agent_action(client)
    field_names = {f["name"] for f in agent["config_fields"]}
    assert "tools" not in field_names
    assert "available_tools" not in field_names


def test_agent_config_fields_are_unchanged_by_surfacing_tools(client: TestClient):
    # Regression: surfacing available_tools must leave the agent action's
    # config_fields byte-for-byte identical to WORKFLOW_ACTIONS, so the current
    # builder behaviour is unaffected.
    from api.schemas.orchestration import WORKFLOW_ACTIONS

    canonical = next(a for a in WORKFLOW_ACTIONS if a["type"] == "agent")
    agent = _agent_action(client)
    assert agent["config_fields"] == canonical["config_fields"]


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


# --- trigger-aware "Only when…" field metadata (#505) ------------------------


def test_every_catalog_trigger_carries_a_fields_list(client: TestClient):
    # Advisory metadata for the condition editor: present (possibly empty) on
    # every trigger so the portal can always read it.
    body = client.get(f"{_BASE}/catalog").json()
    for t in body["triggers"]:
        assert isinstance(t["fields"], list)


def test_declared_event_fields_flow_through_the_catalog(client: TestClient):
    from api.events.registry import EventField, EventType, register_event

    register_event(
        EventType(
            source="test.core",
            detail_type="order.placed",
            label="Order placed",
            fields=(
                EventField(name="status", label="Status", type="enum", values=("new", "shipped")),
                EventField(name="total", label="Total", type="number"),
            ),
        )
    )

    body = client.get(f"{_BASE}/catalog").json()
    trigger = next(t for t in body["triggers"] if t["detail_type"] == "order.placed")
    by_name = {f["name"]: f for f in trigger["fields"]}
    assert by_name["status"] == {
        "name": "status",
        "label": "Status",
        "type": "enum",
        "values": ["new", "shipped"],
    }
    assert by_name["total"]["type"] == "number"
    assert by_name["total"]["values"] == []


def test_crud_trigger_fields_are_derived_from_the_table_columns(client: TestClient, monkeypatch):
    # A CRUD trigger's fields are its model's columns. Use a real shipped model so
    # the derivation runs against genuine SQLAlchemy metadata.
    from api.models.plugin_table import PermissionRule, TablePermissions
    from api.models.prompt_component import PromptComponent  # noqa: F401 — registers on Base

    registry = {"prompt_components": TablePermissions(create=PermissionRule(allowed=True))}
    monkeypatch.setattr("api.routers.orchestration.get_permissions_registry", lambda **_: registry)

    body = client.get(f"{_BASE}/catalog").json()
    trigger = next(t for t in body["triggers"] if t["detail_type"] == "prompt_components.created")
    names = {f["name"] for f in trigger["fields"]}
    # User columns are surfaced; auto-managed ones are not.
    assert {"name", "body", "description"} <= names
    assert not ({"id", "tenant_id", "created_at", "updated_at"} & names)


def test_crud_trigger_with_no_locatable_model_yields_empty_fields(client: TestClient, monkeypatch):
    # Degrade gracefully: a table with no model still lists as a trigger, just
    # with no field metadata (UI falls back to free text) — never a crash.
    from api.models.plugin_table import PermissionRule, TablePermissions

    registry = {"widgets": TablePermissions(create=PermissionRule(allowed=True))}
    monkeypatch.setattr("api.routers.orchestration.get_permissions_registry", lambda **_: registry)

    body = client.get(f"{_BASE}/catalog").json()
    trigger = next(t for t in body["triggers"] if t["detail_type"] == "widgets.created")
    assert trigger["fields"] == []


def test_trigger_filter_stays_permissive_for_undeclared_fields(client: TestClient):
    # #505 is advisory UI metadata, NOT a new server constraint: a filter on a
    # field the trigger does not declare must still be accepted, exactly as before.
    resp = client.post(_BASE, json=_valid_body(trigger_filter={"not_a_declared_field": "x"}))
    assert resp.status_code == 201, resp.text
    assert resp.json()["trigger_filter"] == {"not_a_declared_field": "x"}


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
    # Deliberately minimal in M1 — tools and read scope are M2/M3. `goals` (ADR-0014)
    # is the one optional acceptance-criteria field folded into the system prompt.
    # `delivery` (ADR-0020) is the optional deliver-on-completion sub-config.
    assert set(fields) == {
        "agent_name",
        "instructions",
        "goals",
        "model",
        "max_turns",
        "delivery",
    }
    # The delivery field is optional and structured (type "delivery"): absent ⇒ no
    # delivery, which is today's behaviour.
    assert fields["delivery"]["type"] == "delivery"
    assert fields["delivery"]["required"] is False
    assert fields["agent_name"]["required"] and fields["instructions"]["required"]
    # goals is an OPTIONAL textarea — a simple agent must be definable without it,
    # and its teaching label is the only affordance today (no catalog placeholder).
    assert fields["goals"]["type"] == "textarea"
    assert fields["goals"]["required"] is False
    assert fields["goals"]["label"]
    # goals sits right after instructions in the field order.
    order = [f["name"] for f in action["config_fields"]]
    assert order.index("goals") == order.index("instructions") + 1
    # The model default is deliberately a low-cost model (#414). Assert the exact
    # slug so a future silent switch back to an expensive default is caught here.
    assert fields["model"]["required"]
    assert fields["model"]["default"] == "moonshotai/kimi-k3"
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


def test_agent_workflow_omitting_model_resolves_to_the_low_cost_default():
    """Omitting ``model`` still validates — the required field is satisfied by the
    catalog default (#414) — and resolves to the low-cost model, never Anthropic.

    Constructs the schema body directly so the assertion is on the model that a
    blank field resolves to, not merely on the 2xx the router returns.
    """
    from api.schemas.orchestration import (
        WORKFLOW_ACTIONS,
        WorkflowDefinitionBody,
        _effective,
    )

    body = WorkflowDefinitionBody(
        name="Enrich demo",
        trigger_source="biffo.core",
        trigger_detail_type="demo.requested",
        action_type="agent",
        action_config={"agent_name": "demo-enricher", "instructions": "Enrich {company}."},
    )

    agent_action = next(a for a in WORKFLOW_ACTIONS if a["type"] == "agent")
    resolved = _effective(agent_action["config_fields"], body.action_config, "model")
    assert resolved == "moonshotai/kimi-k3"
    assert "anthropic" not in resolved


def test_agent_workflow_accepts_an_explicit_model():
    """An explicitly chosen model validates cleanly and wins over the default."""
    from api.schemas.orchestration import (
        WORKFLOW_ACTIONS,
        WorkflowDefinitionBody,
        _effective,
    )

    body = WorkflowDefinitionBody(
        name="Enrich demo",
        trigger_source="biffo.core",
        trigger_detail_type="demo.requested",
        action_type="agent",
        action_config={
            "agent_name": "demo-enricher",
            "instructions": "Enrich {company}.",
            "model": "anthropic/claude-opus-4-8",
        },
    )

    agent_action = next(a for a in WORKFLOW_ACTIONS if a["type"] == "agent")
    resolved = _effective(agent_action["config_fields"], body.action_config, "model")
    assert resolved == "anthropic/claude-opus-4-8"


def test_agent_model_field_offers_curated_options(client: TestClient):
    agent = _agent_action(client)
    model = next(f for f in agent["config_fields"] if f["name"] == "model")
    assert model["type"] == "select"
    # Marked open so its options are suggestions, not an allowlist.
    assert model["open"] is True
    values = {o["value"] for o in model["options"]}
    assert {
        "moonshotai/kimi-k3",
        "moonshotai/kimi-k3:online",
        "anthropic/claude-opus-4-8",
    } <= values


def test_agent_workflow_accepts_an_off_list_model(client: TestClient):
    """The correctness trap: a model outside the curated list must still save.

    Otherwise editing an agent stored with such a model would 422 on every save,
    silently locking the author out of a model they legitimately chose.
    """
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent",
            action_config={
                "agent_name": "demo-enricher",
                "instructions": "Enrich {company}.",
                "model": "some-vendor/experimental-model-v9",
            },
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_config"]["model"] == "some-vendor/experimental-model-v9"


def test_non_open_select_still_rejects_off_list_values(client: TestClient):
    """The relaxation is scoped to open selects: WhatsApp's message_type (no
    ``open``) still enforces its allowlist."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="whatsapp",
            action_config={"to": "+1", "message_type": "carrier-pigeon", "message": "hi"},
        ),
    )
    assert resp.status_code == 422


# ── Secret redaction (#432) ──────────────────────────────────────────────────
#
# A Google Chat webhook URL embeds its own bearer token, so the whole string is a
# credential. It must never leave the admin boundary in clear — not on a response,
# and above all not on the WORKFLOW_DEFINITION_* events, which carry the row onto
# the bus to every subscriber. And an unchanged save (which round-trips the
# redaction sentinel) must keep the stored secret rather than overwrite it.

from api.schemas.orchestration import SECRET_SENTINEL  # noqa: E402

_REAL_WEBHOOK = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=REAL-SECRET"


def _gchat_body(**over) -> dict:
    body = _valid_body(
        action_type="google_chat",
        action_config={"webhook_url": _REAL_WEBHOOK, "message": "New demo"},
    )
    body.update(over)
    return body


def _stored_webhook(session_factory, definition_id: str) -> str | None:
    """The webhook as actually persisted — unredacted — read straight from the row,
    since every API read masks it."""

    async def _read() -> str | None:
        async with session_factory() as session:
            row = await session.get(WorkflowDefinition, definition_id)
            assert row is not None
            return row.action_config.get("webhook_url")

    return asyncio.run(_read())


def test_secret_redacted_on_read(client: TestClient):
    created = client.post(_BASE, json=_gchat_body())
    assert created.status_code == 201
    row = created.json()
    # The secret is masked; the non-secret sibling is untouched.
    assert row["action_config"]["webhook_url"] == SECRET_SENTINEL
    assert row["action_config"]["message"] == "New demo"

    got = client.get(f"{_BASE}/{row['id']}").json()
    assert got["action_config"]["webhook_url"] == SECRET_SENTINEL
    listed = client.get(_BASE).json()
    assert listed[0]["action_config"]["webhook_url"] == SECRET_SENTINEL


def test_secret_redacted_in_emitted_event(app):
    # The path that matters most: the row is emitted onto the bus, and the token
    # must not ride along to every subscriber, archive and replay.
    fastapi, _ = app
    client = TestClient(fastapi)
    client.post(_BASE, json=_gchat_body())
    published = fastapi.state.published
    created_events = [e for e in published if e.detail_type.endswith("workflow_definition.created")]
    assert created_events, "expected a WORKFLOW_DEFINITION_CREATED event"
    assert created_events[-1].payload["action_config"]["webhook_url"] == SECRET_SENTINEL
    assert _REAL_WEBHOOK not in str(created_events[-1].payload)


def test_unchanged_update_keeps_stored_secret(app):
    fastapi, session_factory = app
    client = TestClient(fastapi)
    row = client.post(_BASE, json=_gchat_body()).json()
    # The portal round-trips what a read gave it: the sentinel, not the real URL.
    redacted_body = _gchat_body(
        name="Renamed",
        action_config={"webhook_url": SECRET_SENTINEL, "message": "Changed"},
    )
    updated = client.put(f"{_BASE}/{row['id']}", json=redacted_body)
    assert updated.status_code == 200
    # The non-secret change landed; the secret was kept, not clobbered.
    assert updated.json()["action_config"]["message"] == "Changed"
    assert _stored_webhook(session_factory, row["id"]) == _REAL_WEBHOOK


def test_update_with_new_secret_overwrites(app):
    fastapi, session_factory = app
    client = TestClient(fastapi)
    row = client.post(_BASE, json=_gchat_body()).json()
    new_url = "https://chat.googleapis.com/v1/spaces/BBB/messages?key=k2&token=ROTATED"
    client.put(
        f"{_BASE}/{row['id']}",
        json=_gchat_body(action_config={"webhook_url": new_url, "message": "New demo"}),
    )
    assert _stored_webhook(session_factory, row["id"]) == new_url


def test_create_rejects_the_sentinel_as_a_secret(client: TestClient):
    # The marker must never be accepted as a real value — nothing is stored to keep.
    resp = client.post(
        _BASE,
        json=_gchat_body(action_config={"webhook_url": SECRET_SENTINEL, "message": "x"}),
    )
    assert resp.status_code == 422


def test_create_requires_the_secret(client: TestClient):
    resp = client.post(_BASE, json=_gchat_body(action_config={"message": "no webhook"}))
    assert resp.status_code == 422


# ── Standalone Slack action (ADR-0020, #527) ─────────────────────────────────


def test_create_slack_workflow(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="slack",
            action_config={
                "webhook_url": "https://hooks.slack.com/services/T/B/x",
                "message": "New demo from {company}",
            },
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_type"] == "slack"


def test_slack_requires_webhook_url(client: TestClient):
    resp = client.post(
        _BASE, json=_valid_body(action_type="slack", action_config={"message": "hi"})
    )
    assert resp.status_code == 422


def test_slack_rejects_non_https_webhook(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="slack",
            action_config={"webhook_url": "http://insecure/x", "message": "hi"},
        ),
    )
    assert resp.status_code == 422


# ── Agent-action delivery sub-config (ADR-0020, #527) ────────────────────────
#
# `delivery` is an optional `{ type, config }` on the agent action. Absent ⇒ no
# delivery (today's behaviour). Present ⇒ well-formed for its declared destination
# type, validated against that destination's own config_fields — the message field
# optional (it defaults to {output}), the address/webhook fields still required.


def _agent_body(action_config: dict, **over) -> dict:
    base = {"agent_name": "demo-enricher", "instructions": "Enrich {company}."}
    base.update(action_config)
    return _valid_body(action_type="agent", action_config=base, **over)


def test_agent_workflow_without_delivery_still_valid(client: TestClient):
    """Absent delivery is the norm — an agent that delivers nothing."""
    resp = client.post(_BASE, json=_agent_body({}))
    assert resp.status_code == 201, resp.text
    assert "delivery" not in resp.json()["action_config"]


def test_agent_delivery_email_round_trips(client: TestClient):
    delivery = {
        "type": "email",
        "config": {
            "from": "no-reply@example.com",
            "to": "sales@example.com",
            "subject": "Result",
            "body": "The agent said: {output}",
        },
    }
    resp = client.post(_BASE, json=_agent_body({"delivery": delivery}))
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_config"]["delivery"] == delivery


def test_agent_delivery_body_is_optional_defaults_to_output(client: TestClient):
    """The destination's message/body is optional in a delivery — it defaults to
    {output} at render time — but the address fields are still required."""
    resp = client.post(
        _BASE,
        json=_agent_body(
            {
                "delivery": {
                    "type": "email",
                    "config": {
                        "from": "no-reply@example.com",
                        "to": "sales@example.com",
                        "subject": "Result",
                    },
                }
            }
        ),
    )
    assert resp.status_code == 201, resp.text


def test_agent_delivery_email_missing_recipient_rejected(client: TestClient):
    resp = client.post(
        _BASE,
        json=_agent_body(
            {"delivery": {"type": "email", "config": {"from": "no-reply@example.com"}}}
        ),
    )
    assert resp.status_code == 422


def test_agent_delivery_rejects_unknown_type(client: TestClient):
    resp = client.post(
        _BASE,
        json=_agent_body({"delivery": {"type": "carrier-pigeon", "config": {}}}),
    )
    assert resp.status_code == 422


def test_agent_delivery_rejects_non_object_config(client: TestClient):
    resp = client.post(
        _BASE,
        json=_agent_body({"delivery": {"type": "slack", "config": "not-an-object"}}),
    )
    assert resp.status_code == 422


def test_agent_delivery_slack_requires_webhook(client: TestClient):
    resp = client.post(
        _BASE,
        json=_agent_body({"delivery": {"type": "slack", "config": {"message": "{output}"}}}),
    )
    assert resp.status_code == 422


def test_agent_delivery_slack_rejects_non_https_webhook(client: TestClient):
    resp = client.post(
        _BASE,
        json=_agent_body({"delivery": {"type": "slack", "config": {"webhook_url": "http://x/y"}}}),
    )
    assert resp.status_code == 422


def test_agent_delivery_survives_in_definition_snapshot():
    """`delivery` is preserved verbatim when the run snapshot is resolved — it is
    not a prompt field, so ``resolve_definition_snapshot`` leaves it untouched, and
    the orchestrator's snapshot (built from action_config) carries it (ADR-0020)."""
    from api.agent_runs import create_run
    from api.models.agent_run import AgentRun  # noqa: F401 — registers table
    from sqlalchemy.ext.asyncio import create_async_engine as _cae

    engine = _cae(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    delivery = {"type": "slack", "config": {"webhook_url": "https://hooks.slack.com/x"}}
    snapshot = {"model": "m", "instructions": "do it", "delivery": delivery}

    async def _run() -> dict:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            run = await create_run(
                session,
                tenant_id="default",
                agent_name="a",
                definition_snapshot=snapshot,
                max_depth=8,
            )
            await session.commit()
            return run.definition_snapshot

    stored = asyncio.run(_run())
    asyncio.run(engine.dispose())
    assert stored["delivery"] == delivery


# ── Nested delivery secret redaction (#432, ADR-0020) ────────────────────────
#
# A delivery to Slack/Google Chat carries a webhook credential inside
# delivery.config. It is redacted on every read and kept-on-unchanged exactly like
# a top-level secret — the #432 bug class must not reopen through the nested seam.

_REAL_SLACK = "https://hooks.slack.com/services/T/B/REAL-SECRET-TOKEN"


def _agent_slack_delivery_body(webhook: str = _REAL_SLACK, **over) -> dict:
    return _agent_body(
        {"delivery": {"type": "slack", "config": {"webhook_url": webhook, "message": "{output}"}}},
        **over,
    )


def _stored_delivery_webhook(session_factory, definition_id: str) -> str | None:
    async def _read() -> str | None:
        async with session_factory() as session:
            row = await session.get(WorkflowDefinition, definition_id)
            assert row is not None
            return row.action_config["delivery"]["config"].get("webhook_url")

    return asyncio.run(_read())


def test_delivery_secret_redacted_on_read(client: TestClient):
    created = client.post(_BASE, json=_agent_slack_delivery_body())
    assert created.status_code == 201, created.text
    config = created.json()["action_config"]["delivery"]["config"]
    assert config["webhook_url"] == SECRET_SENTINEL
    assert config["message"] == "{output}"


def test_delivery_secret_redacted_in_emitted_event(app):
    fastapi, _ = app
    client = TestClient(fastapi)
    client.post(_BASE, json=_agent_slack_delivery_body())
    created_events = [
        e for e in fastapi.state.published if e.detail_type.endswith("workflow_definition.created")
    ]
    assert created_events
    assert _REAL_SLACK not in str(created_events[-1].payload)


def test_delivery_unchanged_update_keeps_stored_secret(app):
    fastapi, session_factory = app
    client = TestClient(fastapi)
    row = client.post(_BASE, json=_agent_slack_delivery_body()).json()
    # The portal round-trips the sentinel it was given on read.
    redacted = _agent_slack_delivery_body(webhook=SECRET_SENTINEL, name="Renamed")
    updated = client.put(f"{_BASE}/{row['id']}", json=redacted)
    assert updated.status_code == 200, updated.text
    assert _stored_delivery_webhook(session_factory, row["id"]) == _REAL_SLACK


def test_delivery_update_with_new_secret_overwrites(app):
    fastapi, session_factory = app
    client = TestClient(fastapi)
    row = client.post(_BASE, json=_agent_slack_delivery_body()).json()
    rotated = "https://hooks.slack.com/services/T/B/ROTATED"
    client.put(f"{_BASE}/{row['id']}", json=_agent_slack_delivery_body(webhook=rotated))
    assert _stored_delivery_webhook(session_factory, row["id"]) == rotated


def test_delivery_create_rejects_the_sentinel_as_a_secret(client: TestClient):
    resp = client.post(_BASE, json=_agent_slack_delivery_body(webhook=SECRET_SENTINEL))
    assert resp.status_code == 422


def test_delivery_workflow_is_tenant_isolated(app, client: TestClient):
    """A delivery-bearing definition (webhook and all) rides on a tenant-scoped
    row — another tenant never reads it, so its delivery secret cannot leak
    cross-tenant either (ADR-0001)."""
    _, session_factory = app

    async def _seed_other_tenant() -> None:
        async with session_factory() as session:
            session.add(
                WorkflowDefinition(
                    tenant_id="other-tenant",
                    name="Other tenant delivery",
                    trigger_source="biffo.core",
                    trigger_detail_type="demo.requested",
                    action_type="agent",
                    action_config={
                        "agent_name": "a",
                        "instructions": "go",
                        "delivery": {
                            "type": "slack",
                            "config": {"webhook_url": _REAL_SLACK, "message": "{output}"},
                        },
                    },
                    enabled=True,
                )
            )
            await session.commit()

    asyncio.run(_seed_other_tenant())
    # Caller is tenant "default" — the other tenant's delivery row is invisible.
    assert client.get(_BASE).json() == []
