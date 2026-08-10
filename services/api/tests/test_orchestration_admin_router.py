"""Integration tests for the user-facing workflow-definition CRUD router
(/api/v1/orchestration/workflows). Drives real HTTP through FastAPI's TestClient
against in-memory SQLite. Auth is faked by overriding require_auth (require_admin
depends on it): an admin caller for the happy paths, a non-admin for the 403.

The StaticPool/in-memory-SQLite fixture mirrors test_core_crud_router.py.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator
from contextlib import contextmanager

import pytest
from api import writeback_targets as wb
from api.database import get_db
from api.events.emit import is_declared, pending_events
from api.events.registry import EventField, EventType, register_event
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

# A brand-scoped fixture trigger, for the reachability tests below. Before #848
# these used the real ``lead.captured`` (its payload happened to carry
# ``brand_id``) — coupling a template test to a franchising-specific curated
# event, which is exactly the boundary #848 fixes. Registered once at module
# scope, same "test.source" convention as test_event_registry.py's synthetic
# events: it carries `fields`, so it satisfies the payload-metadata guard in
# test_event_registry_fields.py rather than needing registry cleanup.
_BRAND_SCOPED_TRIGGER = register_event(
    EventType(
        source="test.source",
        detail_type="test.brand_scoped_event",
        label="Test brand-scoped event",
        description="Fixture only: a payload carrying brand_id, for scope-reachability tests.",
        fields=(EventField(name="brand_id", label="Brand"),),
    )
)


@pytest.fixture(autouse=True)
def _pristine_scope_resolver_registry():
    """Reset the scope-resolver registry to nothing-registered around every
    test in this file (docs/implementation/0003-hierarchy-scoped-workflows).

    Most of this file's tests use ``demo.requested`` (the default trigger in
    ``_valid_body``) together with a brand/region/unit scope, which only
    stays valid under Phase 4's trigger-reachability check
    (``_require_scope_reachable``) when no resolver is registered at all —
    true throughout biffo-template's own suite (nothing here ever registers
    one), but NOT guaranteed once this file runs inside a real instance's
    test process: an instance's own domain module (e.g. tabsii's
    ``domains/tabsii/scope_resolver.py``) registers its real resolver at
    *import* time, and ``scope_resolvers._levels``/``_resolver`` are
    module-global state that persists for the rest of that pytest session
    regardless of which test file is executing. Without this reset, this
    file's tests pass in isolation but fail the moment they share a process
    with an instance's own registered resolver — exactly the class of bug
    already fixed once for ``test_scope_resolvers.py``'s own tests.
    """
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr._levels, sr._resolver = (), sr._default_resolver  # noqa: SLF001
    yield
    sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def _caller(
    tenant_id: str = "default",
    roles: list[str] | None = None,
    user_id: str | None = None,
    permissions: frozenset[str] | None = None,
) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"] if roles is None else roles,
        user_id=user_id,
        permissions=permissions or frozenset(),
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


def test_schedule_config_defaults_to_null(client: TestClient):
    created = client.post(_BASE, json=_valid_body())
    assert created.status_code == 201
    assert created.json()["schedule_config"] is None


def test_schedule_config_round_trips(client: TestClient):
    schedule = {"type": "fixed_delay", "delay_seconds": 1209600}
    created = client.post(_BASE, json=_valid_body(schedule_config=schedule))
    assert created.status_code == 201, created.text
    assert created.json()["schedule_config"] == schedule

    got = client.get(f"{_BASE}/{created.json()['id']}")
    assert got.json()["schedule_config"] == schedule


def test_update_can_set_and_clear_schedule_config(client: TestClient):
    schedule = {"type": "fixed_delay", "delay_seconds": 60}
    row = client.post(_BASE, json=_valid_body(schedule_config=schedule)).json()

    cleared = client.put(f"{_BASE}/{row['id']}", json=_valid_body(schedule_config=None))
    assert cleared.status_code == 200
    assert cleared.json()["schedule_config"] is None


def test_create_rejects_unknown_schedule_type(client: TestClient):
    body = _valid_body(schedule_config={"type": "cron", "delay_seconds": 60})
    assert client.post(_BASE, json=body).status_code == 422


def test_create_rejects_non_positive_delay(client: TestClient):
    body = _valid_body(schedule_config={"type": "fixed_delay", "delay_seconds": 0})
    assert client.post(_BASE, json=body).status_code == 422


def test_create_rejects_delay_over_one_year(client: TestClient):
    body = _valid_body(
        schedule_config={"type": "fixed_delay", "delay_seconds": 365 * 24 * 60 * 60 + 1}
    )
    assert client.post(_BASE, json=body).status_code == 422


def test_scope_defaults_to_null(client: TestClient):
    created = client.post(_BASE, json=_valid_body())
    assert created.status_code == 201
    assert created.json()["scope"] is None


def test_scope_round_trips(client: TestClient):
    scope = {"level": "brand", "id": "b1"}
    created = client.post(_BASE, json=_valid_body(scope=scope))
    assert created.status_code == 201, created.text
    assert created.json()["scope"] == scope

    got = client.get(f"{_BASE}/{created.json()['id']}")
    assert got.json()["scope"] == scope


def test_update_can_set_and_clear_scope(client: TestClient):
    scope = {"level": "brand", "id": "b1"}
    row = client.post(_BASE, json=_valid_body(scope=scope)).json()

    cleared = client.put(f"{_BASE}/{row['id']}", json=_valid_body(scope=None))
    assert cleared.status_code == 200
    assert cleared.json()["scope"] is None


def test_create_rejects_scope_missing_level(client: TestClient):
    body = _valid_body(scope={"id": "b1"})
    assert client.post(_BASE, json=body).status_code == 422


def test_create_rejects_scope_missing_id(client: TestClient):
    body = _valid_body(scope={"level": "brand"})
    assert client.post(_BASE, json=body).status_code == 422


def test_create_rejects_empty_scope_level(client: TestClient):
    body = _valid_body(scope={"level": "", "id": "b1"})
    assert client.post(_BASE, json=body).status_code == 422


def test_create_accepts_any_level_name_when_no_resolver_registered(client: TestClient):
    # Shape-only validation when the instance has registered no resolver at
    # all — the template cannot know what levels "should" exist. Explicitly
    # reset to that pristine state rather than asserting whatever happens to
    # be ambient: on a real instance that registers its own resolver at import
    # time (e.g. tabsii's scope_resolver_tabsii.py), that registration has
    # already run somewhere else in this same test process.
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr._levels, sr._resolver = (), sr._default_resolver  # noqa: SLF001
    try:
        body = _valid_body(scope={"level": "anything", "id": "b1"})
        assert client.post(_BASE, json=body).status_code == 201
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def test_create_rejects_a_level_not_among_a_registered_resolvers_levels(client: TestClient):
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr.register_scope_resolver(sr._default_resolver, levels=("brand", "region", "unit"))  # noqa: SLF001
    try:
        body = _valid_body(scope={"level": "franchisee", "id": "f1"})
        assert client.post(_BASE, json=body).status_code == 422

        body = _valid_body(scope={"level": "brand", "id": "b1"})
        assert client.post(_BASE, json=body).status_code == 201
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def test_create_rejects_scope_unreachable_by_trigger(client: TestClient):
    """demo.requested's payload carries no brand/region/unit id, so a
    brand-scoped workflow on it would create but silently never fire
    (Phase 4, docs/implementation/0003-hierarchy-scoped-workflows) — the API
    catches that dead combination at authoring time instead."""
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr.register_scope_resolver(sr._default_resolver, levels=("tenant", "brand", "region", "unit"))  # noqa: SLF001
    try:
        body = _valid_body(
            trigger_detail_type="demo.requested", scope={"level": "brand", "id": "b1"}
        )
        resp = client.post(_BASE, json=body)
        assert resp.status_code == 422, resp.text
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def test_create_allows_scope_reachable_by_trigger(client: TestClient):
    """A trigger whose payload carries brand_id — a brand-scoped workflow on
    it is a live combination, not a dead one."""
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr.register_scope_resolver(sr._default_resolver, levels=("tenant", "brand", "region", "unit"))  # noqa: SLF001
    try:
        body = _valid_body(
            trigger_detail_type=_BRAND_SCOPED_TRIGGER.detail_type,
            trigger_source=_BRAND_SCOPED_TRIGGER.source,
            scope={"level": "brand", "id": "b1"},
        )
        resp = client.post(_BASE, json=body)
        assert resp.status_code == 201, resp.text
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def test_update_rejects_scope_unreachable_by_trigger(client: TestClient):
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    row = client.post(_BASE, json=_valid_body(trigger_detail_type="demo.requested")).json()
    sr.register_scope_resolver(sr._default_resolver, levels=("tenant", "brand", "region", "unit"))  # noqa: SLF001
    try:
        body = _valid_body(
            trigger_detail_type="demo.requested", scope={"level": "brand", "id": "b1"}
        )
        resp = client.put(f"{_BASE}/{row['id']}", json=body)
        assert resp.status_code == 422, resp.text
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def test_create_allows_any_scope_when_no_resolver_registered_even_on_a_tenant_only_trigger(
    client: TestClient,
):
    """Reachability has nothing to check against when no resolver is
    registered at all — mirrors _validate_scope's own leniency in that case."""
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr._levels, sr._resolver = (), sr._default_resolver  # noqa: SLF001
    try:
        body = _valid_body(
            trigger_detail_type="demo.requested", scope={"level": "brand", "id": "b1"}
        )
        assert client.post(_BASE, json=body).status_code == 201
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


def test_catalog_carries_reachable_levels_per_trigger(client: TestClient):
    from api import scope_resolvers as sr

    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    sr.register_scope_resolver(sr._default_resolver, levels=("tenant", "brand", "region", "unit"))  # noqa: SLF001
    try:
        triggers = {t["detail_type"]: t for t in client.get(f"{_BASE}/catalog").json()["triggers"]}
        assert triggers["demo.requested"]["reachable_levels"] == ["tenant"]
        assert triggers[_BRAND_SCOPED_TRIGGER.detail_type]["reachable_levels"] == [
            "tenant",
            "brand",
        ]
    finally:
        sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


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


def test_create_accepts_payload_template_to(client: TestClient):
    body = _valid_body(
        action_config={
            "from": "no-reply@example.com",
            "to": "{email}",
            "subject": "s",
            "body": "b",
        }
    )
    assert client.post(_BASE, json=body).status_code == 201


def test_create_accepts_payload_template_to_with_extra_text(client: TestClient):
    body = _valid_body(
        action_config={
            "from": "no-reply@example.com",
            "to": "{email} <notifications@example.com>",
            "subject": "s",
            "body": "b",
        }
    )
    assert client.post(_BASE, json=body).status_code == 201


def test_create_still_rejects_bad_literal_to(client: TestClient):
    body = _valid_body(
        action_config={
            "from": "no-reply@example.com",
            "to": "not-an-email",
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


# ── payload_template on content fields drives the portal's insert-field
#    picker (#609): `_render` already fills these identically to `to` —
#    this only makes the catalog say so, so the portal can offer the same
#    picker there too. ──────────────────────────────────────────────────────


def _field(action: dict, name: str) -> dict:
    return next(f for f in action["config_fields"] if f["name"] == name)


def test_catalog_flags_email_content_fields_as_payload_template(client: TestClient):
    body = client.get(f"{_BASE}/catalog").json()
    email = next(a for a in body["actions"] if a["type"] == "email")
    assert _field(email, "subject")["payload_template"] is True
    assert _field(email, "body")["payload_template"] is True


def test_catalog_flags_chat_message_fields_as_payload_template(client: TestClient):
    body = client.get(f"{_BASE}/catalog").json()
    for action_type in ("google_chat", "slack"):
        action = next(a for a in body["actions"] if a["type"] == action_type)
        assert _field(action, "message")["payload_template"] is True


def test_catalog_flags_whatsapp_message_fields_as_payload_template(client: TestClient):
    body = client.get(f"{_BASE}/catalog").json()
    whatsapp = next(a for a in body["actions"] if a["type"] == "whatsapp")
    assert _field(whatsapp, "message")["payload_template"] is True
    assert _field(whatsapp, "template_params")["payload_template"] is True


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


def test_tools_is_now_a_validated_config_field(client: TestClient):
    # ADR-0014 §7 / #569: `tools` gained an authoring-time-validated config_field
    # (previously it was deliberately absent, so a declared tool name went
    # unchecked until run time). `available_tools` is a DIFFERENT thing — live
    # discovery metadata the router attaches for the portal's picker *options* —
    # and must stay out of config_fields, since it carries no action_config value
    # of its own.
    agent = _agent_action(client)
    field_names = {f["name"] for f in agent["config_fields"]}
    assert "tools" in field_names
    assert "available_tools" not in field_names
    tools_field = next(f for f in agent["config_fields"] if f["name"] == "tools")
    assert tools_field["type"] == "tools"
    assert tools_field["required"] is False


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


def test_non_admin_with_no_registered_authorizer_sees_nothing_and_cannot_create(
    app, client: TestClient
):
    # Phase 3 (docs/implementation/0003-hierarchy-scoped-workflows): a non-admin
    # is no longer an outright 403 on list — they're authenticated and see
    # whatever the registered scope authorizer lets them see. The default
    # (fail-closed, nothing registered) authorizes nothing, so list is an empty
    # 200, not a blanket 403; create/update/delete still refuse (403) since the
    # default authorizes no scope at all, including the unscoped default.
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=[])

    assert client.post(_BASE, json=_valid_body()).status_code == 403

    resp = client.get(_BASE)
    assert resp.status_code == 200
    assert resp.json() == []


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


def test_a_model_can_decline_to_be_offered_as_a_crud_trigger(client: TestClient, monkeypatch):
    """``__trigger_exclude__`` withholds a table's ops from the picker.

    A table whose meaningful changes have purpose-built events wants authors on
    those, not on a raw ``updated`` that fires on every edit.
    """
    from api.models.plugin_table import PermissionRule, TablePermissions

    registry = {
        "widgets": TablePermissions(
            create=PermissionRule(allowed=True),
            update=PermissionRule(allowed=True),
            delete=PermissionRule(allowed=True),
        )
    }
    monkeypatch.setattr("api.routers.orchestration.get_permissions_registry", lambda **_: registry)
    # Unknown names alongside real ones: builder metadata must not raise on a typo.
    monkeypatch.setattr(
        "api.routers.orchestration.trigger_excluded_ops",
        lambda table: frozenset({"update", "delete"}) if table == "widgets" else frozenset(),
    )

    by_dt = {t["detail_type"]: t for t in client.get(f"{_BASE}/catalog").json()["triggers"]}

    assert "widgets.updated" not in by_dt
    assert "widgets.deleted" not in by_dt
    # The op that did not opt out is untouched.
    assert by_dt["widgets.created"]["origin"] == "declared"


def test_declining_a_trigger_does_not_stop_the_event(monkeypatch):
    """The exclusion hides a trigger; it must never silence the bus.

    ``is_declared`` is what the compliance gate consults, and any existing
    subscriber still depends on the event arriving. Removing it from the picker
    and removing it from the bus are different changes, and only the first is
    intended here.
    """
    from api.events.emit import is_declared
    from api.events.event_fields import trigger_excluded_ops
    from api.models.plugin_table import PermissionRule, TablePermissions

    registry = {"widgets": TablePermissions(update=PermissionRule(allowed=True))}
    # is_declared resolves the registry lazily from api.permissions.
    monkeypatch.setattr("api.permissions.get_permissions_registry", lambda **_: registry)

    class _Excluded:
        __tablename__ = "widgets"
        __trigger_exclude__ = ("update",)

    monkeypatch.setattr("api.events.event_fields._model_for_table", lambda _t: _Excluded)

    assert trigger_excluded_ops("widgets") == frozenset({"update"})
    assert is_declared("biffo.core", "widgets.updated") is True


def test_trigger_exclude_ignores_unknown_operations(monkeypatch):
    """A typo in a ClassVar must not take down the catalog."""
    from api.events.event_fields import trigger_excluded_ops

    class _Typo:
        __tablename__ = "widgets"
        __trigger_exclude__ = ("updated", "destroy")  # neither is a CRUD op name

    monkeypatch.setattr("api.events.event_fields._model_for_table", lambda _t: _Typo)
    assert trigger_excluded_ops("widgets") == frozenset()


def test_trigger_exclude_absent_by_default(monkeypatch):
    from api.events.event_fields import trigger_excluded_ops

    class _Plain:
        __tablename__ = "widgets"

    monkeypatch.setattr("api.events.event_fields._model_for_table", lambda _t: _Plain)
    assert trigger_excluded_ops("widgets") == frozenset()
    # An unlocatable model is not an error either.
    monkeypatch.setattr("api.events.event_fields._model_for_table", lambda _t: None)
    assert trigger_excluded_ops("no_such_table") == frozenset()


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
    # `goals` (ADR-0014) is the one optional acceptance-criteria field folded into
    # the system prompt. `delivery` (ADR-0020) is the optional deliver-on-completion
    # sub-config. `tools` (ADR-0014 §7, #569) is the declared tool list, validated
    # against KNOWN_AGENT_TOOLS. `writeback` (ADR-0027) is the optional
    # record-the-result sub-config. Read scope stays deliberately absent —
    # ADR-0014's third amendment defers it; no worker needs table reads yet.
    assert set(fields) == {
        "agent_name",
        "instructions",
        "goals",
        "model",
        "max_turns",
        "tools",
        "delivery",
        "writeback",
    }
    # The delivery field is optional and structured (type "delivery"): absent ⇒ no
    # delivery, which is today's behaviour.
    assert fields["delivery"]["type"] == "delivery"
    assert fields["delivery"]["required"] is False
    assert fields["agent_name"]["required"]
    # instructions is now optional (biffo-template#910): omitting it triggers registry
    # resolution at run-creation time. agent_name is still required.
    assert fields["instructions"]["required"] is False
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


def test_agent_workflow_instructions_are_optional(client: TestClient):
    # Instructions are now optional at the workflow level (biffo-template#910) —
    # omitting them triggers registry resolution at run-creation time.
    resp = client.post(
        _BASE,
        json=_valid_body(action_type="agent", action_config={"agent_name": "demo-enricher"}),
    )
    assert resp.status_code == 201


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
        # Dotted, matching OpenRouter's real catalogue slug — the dashed
        # "anthropic/claude-opus-4-8" this test asserted until biffo-template#822
        # was a well-formed but nonexistent id, the incident that guard is
        # filed under; fixed alongside the cli/ guard that now catches it.
        "anthropic/claude-opus-4.8",
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


# ── Agent tools (ADR-0014 §7, #569) ──────────────────────────────────────────
#
# `tools` is a declared list of runtime tool names, validated at save time
# against KNOWN_AGENT_TOOLS (a reproduced mirror of the runtime's TOOL_REGISTRY
# — Core cannot import the runtime's Python, ADR-0002). Before this, a declared
# tool name was never checked until run time.


def test_agent_workflow_accepts_a_known_tool(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent",
            action_config={
                "agent_name": "demo-enricher",
                "instructions": "Enrich {company}.",
                "tools": ["web_search"],
            },
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_config"]["tools"] == ["web_search"]


def test_agent_workflow_rejects_an_unregistered_tool(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent",
            action_config={
                "agent_name": "demo-enricher",
                "instructions": "Enrich {company}.",
                "tools": ["read_database"],
            },
        ),
    )
    assert resp.status_code == 422
    assert "read_database" in resp.text


def test_agent_workflow_without_tools_still_valid(client: TestClient):
    """Absent `tools` is the norm — default-deny, a worker that uses none."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent",
            action_config={"agent_name": "demo-enricher", "instructions": "Enrich {company}."},
        ),
    )
    assert resp.status_code == 201, resp.text
    assert "tools" not in resp.json()["action_config"]


def test_agent_workflow_accepts_a_comma_separated_tools_string(client: TestClient):
    """Mirrors `agent_runtime.tools.declared_tools()`'s leniency: a single-text-
    input authoring form naturally produces a comma-separated string, and that
    must validate exactly as the list form does — not just at run time."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent",
            action_config={
                "agent_name": "demo-enricher",
                "instructions": "Enrich {company}.",
                "tools": "web_search",
            },
        ),
    )
    assert resp.status_code == 201, resp.text


def _fan_in_config(**over) -> dict:
    config = {
        "expect_agents": "researcher-a,researcher-b",
        "agent_name": "synthesiser",
        "instructions": "Rank what they found.",
    }
    config.update(over)
    return config


def _candidates_tool(name: str = "submit_idea_candidates") -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": "Submit the ranked candidates. Call this exactly once.",
            "parameters": {"type": "object", "properties": {"candidates": {"type": "array"}}},
        },
    }


def test_fan_in_accepts_and_round_trips_an_output_tool(client: TestClient):
    """#729: a fan-in agent could be *told* to call a tool but never given one,
    so it answered in prose and the caller's extractor rejected the result."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent_fan_in",
            action_config=_fan_in_config(output_tools=[_candidates_tool()]),
        ),
    )
    assert resp.status_code == 201, resp.text
    stored = resp.json()["action_config"]["output_tools"]
    assert stored[0]["function"]["name"] == "submit_idea_candidates"


def test_fan_in_accepts_a_bare_function_object(client: TestClient):
    """Mirrors the runtime's `_coerce_output_tool`, which takes the provider
    shape or the inner `function` object directly."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent_fan_in",
            action_config=_fan_in_config(output_tools=_candidates_tool()["function"]),
        ),
    )
    assert resp.status_code == 201, resp.text


def test_fan_in_without_an_output_tool_is_still_valid(client: TestClient):
    """Every workflow authored before the field existed answers in prose. The
    field is additive, so absence must stay valid."""
    resp = client.post(
        _BASE, json=_valid_body(action_type="agent_fan_in", action_config=_fan_in_config())
    )
    assert resp.status_code == 201, resp.text
    assert "output_tools" not in resp.json()["action_config"]


@pytest.mark.parametrize(
    ("tool", "expected"),
    [
        (
            {"name": "Submit Candidates", "description": "d", "parameters": {"type": "object"}},
            "Submit Candidates",
        ),
        (
            {"name": "submit_x", "description": "  ", "parameters": {"type": "object"}},
            "description",
        ),
        (
            {"name": "submit_x", "description": "d", "parameters": {"type": "array"}},
            "JSON Schema object",
        ),
        ({"name": "submit_x", "description": "d"}, "JSON Schema object"),
    ],
)
def test_fan_in_rejects_a_malformed_output_tool(client: TestClient, tool: dict, expected: str):
    """Rejected at *save* rather than mid-chain: by run time the fan-out has
    already been paid for."""
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent_fan_in", action_config=_fan_in_config(output_tools=[tool])
        ),
    )
    assert resp.status_code == 422
    assert expected in resp.text


def test_fan_in_rejects_duplicate_output_tool_names(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="agent_fan_in",
            action_config=_fan_in_config(
                output_tools=[_candidates_tool(), _candidates_tool()],
            ),
        ),
    )
    assert resp.status_code == 422
    assert "more than once" in resp.text


def test_fan_in_catalog_declares_output_tools(client: TestClient):
    """Undeclared is the whole bug: the save path keeps only *declared* fields,
    so an undeclared output_tools is silently dropped on any edit."""
    catalog = client.get(f"{_BASE}/catalog").json()
    fan_in = next(a for a in catalog["actions"] if a["type"] == "agent_fan_in")
    field = next(f for f in fan_in["config_fields"] if f["name"] == "output_tools")
    assert field["type"] == "output_tools"
    assert field["required"] is False


def test_known_agent_tools_matches_the_runtime_manifest():
    """KNOWN_AGENT_TOOLS is a reproduced mirror of the runtime's TOOL_REGISTRY
    (Core cannot import agent_runtime's Python, ADR-0002). The runtime's own
    test_manifest_tools.py already guarantees its biffo.plugin.json matches
    TOOL_REGISTRY exactly, so cross-checking against that manifest here — the
    one artifact Core can read without importing the runtime, same as the
    router's `_agent_runtime_tools()` — is equivalent to checking against
    TOOL_REGISTRY directly, and is the same-repo drift guard for this list.
    """
    from api.plugins import discover_plugin_manifests
    from api.schemas.orchestration import KNOWN_AGENT_TOOLS

    manifest = next(m for m in discover_plugin_manifests() if m.get("name") == "agent-runtime")
    declared = {tool["name"] for tool in manifest.get("tools", [])}
    assert declared == KNOWN_AGENT_TOOLS, (
        "KNOWN_AGENT_TOOLS in schemas/orchestration.py has drifted from "
        "agent-runtime's biffo.plugin.json. Update the reproduced set there to "
        "match."
    )


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


# ── Generic HTTP action (#1051): the escape hatch every other action here is
# a fixed-shape specialisation of.

_REAL_HTTP_HEADERS = "Authorization: Bearer REAL-SECRET-TOKEN"


def test_create_http_workflow(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(
            action_type="http",
            action_config={"url": "https://internal.example.com/hooks/sweep"},
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["action_type"] == "http"


def test_http_requires_url(client: TestClient):
    resp = client.post(_BASE, json=_valid_body(action_type="http", action_config={}))
    assert resp.status_code == 422


def test_http_rejects_non_https_url(client: TestClient):
    resp = client.post(
        _BASE,
        json=_valid_body(action_type="http", action_config={"url": "http://insecure/x"}),
    )
    assert resp.status_code == 422


def test_http_headers_secret_redacted_on_read(client: TestClient):
    created = client.post(
        _BASE,
        json=_valid_body(
            action_type="http",
            action_config={
                "url": "https://internal.example.com/hooks/sweep",
                "headers": _REAL_HTTP_HEADERS,
            },
        ),
    )
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["action_config"]["headers"] == SECRET_SENTINEL
    assert row["action_config"]["url"] == "https://internal.example.com/hooks/sweep"

    got = client.get(f"{_BASE}/{row['id']}").json()
    assert got["action_config"]["headers"] == SECRET_SENTINEL


def test_http_unchanged_update_keeps_stored_headers(app):
    fastapi, session_factory = app
    client = TestClient(fastapi)
    row = client.post(
        _BASE,
        json=_valid_body(
            action_type="http",
            action_config={
                "url": "https://internal.example.com/hooks/sweep",
                "headers": _REAL_HTTP_HEADERS,
            },
        ),
    ).json()
    updated = client.put(
        f"{_BASE}/{row['id']}",
        json=_valid_body(
            action_type="http",
            action_config={
                "url": "https://internal.example.com/hooks/sweep",
                "headers": SECRET_SENTINEL,
            },
        ),
    )
    assert updated.status_code == 200, updated.text

    async def _read() -> str | None:
        async with session_factory() as session:
            stored = await session.get(WorkflowDefinition, row["id"])
            assert stored is not None
            return stored.action_config.get("headers")

    assert asyncio.run(_read()) == _REAL_HTTP_HEADERS


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
            run, _ = await create_run(
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


# ── Phase 3: scoped authorization (docs/implementation/0003-hierarchy-scoped-workflows) ──
#
# A fake authorizer standing in for an instance's real role-assignment model
# (e.g. tabsii's brand/region/unit reach): authorized for brand-1's scope only
# — never the tenant-wide default (`scope: None`) and never a sibling brand.
# Exercises the router's use of the registered authorizer, not the authorizer
# itself (that's covered by test_orchestration_authz.py).


async def _brand_1_authorizer(caller, db, scope) -> bool:  # noqa: ANN001
    return scope is not None and scope.get("level") == "brand" and scope.get("id") == "brand-1"


@pytest.fixture
def _registered_brand_1_authorizer():
    from api import orchestration_authz as authz

    saved = authz._authorizer  # noqa: SLF001
    authz.register_workflow_scope_authorizer(_brand_1_authorizer)
    yield
    authz._authorizer = saved  # noqa: SLF001


def _non_admin(client: TestClient, app) -> None:
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=[])


def test_scoped_caller_can_create_within_their_own_brand(
    app, client: TestClient, _registered_brand_1_authorizer
):
    _non_admin(client, app)
    body = _valid_body(scope={"level": "brand", "id": "brand-1"})
    assert client.post(_BASE, json=body).status_code == 201


def test_scoped_caller_cannot_create_in_a_sibling_brand(
    app, client: TestClient, _registered_brand_1_authorizer
):
    _non_admin(client, app)
    body = _valid_body(scope={"level": "brand", "id": "brand-2"})
    assert client.post(_BASE, json=body).status_code == 403


def test_scoped_caller_cannot_create_an_unscoped_tenant_wide_workflow(
    app, client: TestClient, _registered_brand_1_authorizer
):
    # The ceiling: a brand-scoped caller cannot go "up" to tenant-wide by
    # simply omitting scope — the default (unscoped) is still just another
    # scope the authorizer must approve, and this authorizer never does.
    _non_admin(client, app)
    assert client.post(_BASE, json=_valid_body()).status_code == 403


def test_scoped_caller_sees_only_their_own_brands_workflows_in_list(
    app, client: TestClient, _registered_brand_1_authorizer
):
    admin_created_brand_1 = client.post(
        _BASE, json=_valid_body(name="Brand 1 rule", scope={"level": "brand", "id": "brand-1"})
    )
    admin_created_brand_2 = client.post(
        _BASE, json=_valid_body(name="Brand 2 rule", scope={"level": "brand", "id": "brand-2"})
    )
    assert admin_created_brand_1.status_code == 201
    assert admin_created_brand_2.status_code == 201

    _non_admin(client, app)
    names = {row["name"] for row in client.get(_BASE).json()}
    assert names == {"Brand 1 rule"}


def test_scoped_caller_gets_404_not_403_for_an_out_of_reach_workflow(
    app, client: TestClient, _registered_brand_1_authorizer
):
    other_brand = client.post(
        _BASE, json=_valid_body(scope={"level": "brand", "id": "brand-2"})
    ).json()

    _non_admin(client, app)
    assert client.get(f"{_BASE}/{other_brand['id']}").status_code == 404


def test_scoped_caller_can_read_update_delete_their_own_scoped_workflow(
    app, client: TestClient, _registered_brand_1_authorizer
):
    own = client.post(_BASE, json=_valid_body(scope={"level": "brand", "id": "brand-1"})).json()

    _non_admin(client, app)
    assert client.get(f"{_BASE}/{own['id']}").status_code == 200

    updated = client.put(
        f"{_BASE}/{own['id']}",
        json=_valid_body(name="Renamed", scope={"level": "brand", "id": "brand-1"}),
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"

    assert client.delete(f"{_BASE}/{own['id']}").status_code == 204


def test_scoped_caller_cannot_widen_their_own_workflow_to_tenant_wide(
    app, client: TestClient, _registered_brand_1_authorizer
):
    # The ceiling again, on update: even a workflow already inside the
    # caller's own reach cannot be re-scoped past it.
    own = client.post(_BASE, json=_valid_body(scope={"level": "brand", "id": "brand-1"})).json()

    _non_admin(client, app)
    widened = client.put(f"{_BASE}/{own['id']}", json=_valid_body(scope=None))
    assert widened.status_code == 403


def test_scoped_caller_cannot_move_a_workflow_to_a_sibling_brand(
    app, client: TestClient, _registered_brand_1_authorizer
):
    own = client.post(_BASE, json=_valid_body(scope={"level": "brand", "id": "brand-1"})).json()

    _non_admin(client, app)
    moved = client.put(
        f"{_BASE}/{own['id']}", json=_valid_body(scope={"level": "brand", "id": "brand-2"})
    )
    assert moved.status_code == 403


def test_scoped_caller_cannot_toggle_or_delete_an_out_of_reach_workflow(
    app, client: TestClient, _registered_brand_1_authorizer
):
    other_brand = client.post(
        _BASE, json=_valid_body(scope={"level": "brand", "id": "brand-2"})
    ).json()

    _non_admin(client, app)
    assert (
        client.post(f"{_BASE}/{other_brand['id']}/enabled", json={"enabled": False}).status_code
        == 404
    )
    assert client.delete(f"{_BASE}/{other_brand['id']}").status_code == 404


def test_admin_is_unaffected_by_a_registered_authorizer(
    client: TestClient, _registered_brand_1_authorizer
):
    # Sanity/regression guard: registering a scoped authorizer must not
    # narrow the platform admin's own reach — they still see and manage
    # everything, exactly as before Phase 3.
    body = _valid_body(scope={"level": "brand", "id": "brand-2"})
    created = client.post(_BASE, json=body)
    assert created.status_code == 201
    assert len(client.get(_BASE).json()) == 1


# ── run-as principal (ADR-0027 §2) ────────────────────────────────────────────
#
# Until this, nothing recorded who had scheduled a job — so "the user scheduling
# the job" was not a principal that could be consulted at all. Authority re-binds
# on every save and every enable, so a definition always runs as someone who
# affirmatively vouched for it in its current form.


def test_create_stamps_the_authenticated_caller_as_the_run_as_principal(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")

    created = client.post("/api/v1/orchestration/workflows", json=_valid_body())
    assert created.status_code == 201
    assert created.json()["run_as_user_id"] == "user-a"
    assert created.json()["run_as_kind"] == "user"


def test_update_rebinds_authority_to_whoever_saved_it_last(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")
    created = client.post("/api/v1/orchestration/workflows", json=_valid_body())
    definition_id = created.json()["id"]

    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-b")
    updated = client.put(
        f"/api/v1/orchestration/workflows/{definition_id}",
        json=_valid_body(name="Notify sales (revised)"),
    )
    assert updated.status_code == 200
    assert updated.json()["run_as_user_id"] == "user-b"


def test_enabling_is_an_act_of_authority_and_rebinds_too(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")
    created = client.post("/api/v1/orchestration/workflows", json=_valid_body(enabled=False))
    definition_id = created.json()["id"]

    # Someone else turning the rule on is vouching for it; it must not keep
    # running under the original author's permissions.
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-b")
    toggled = client.post(
        f"/api/v1/orchestration/workflows/{definition_id}/enabled",
        json={"enabled": True},
    )
    assert toggled.status_code == 200
    assert toggled.json()["run_as_user_id"] == "user-b"


def test_run_as_is_never_accepted_from_the_request_body(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")

    created = client.post(
        "/api/v1/orchestration/workflows",
        json=_valid_body(run_as_user_id="user-somebody-else", run_as_kind="user"),
    )
    assert created.status_code == 201
    # The body's value is ignored entirely — the principal comes from the verified
    # identity, never from what the client asked for.
    assert created.json()["run_as_user_id"] == "user-a"


def test_a_caller_with_no_resolved_user_id_leaves_the_principal_alone(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")
    created = client.post("/api/v1/orchestration/workflows", json=_valid_body())
    definition_id = created.json()["id"]

    # An identity that resolves no user_id must not silently unbind the
    # definition — that would demote it to unrunnable on an unrelated edit, a
    # confusing failure a long way from its cause.
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id=None)
    updated = client.put(
        f"/api/v1/orchestration/workflows/{definition_id}",
        json=_valid_body(name="Edited by a machine identity"),
    )
    assert updated.status_code == 200
    assert updated.json()["run_as_user_id"] == "user-a"


def test_definitions_written_before_this_carry_no_principal(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id=None)

    created = client.post("/api/v1/orchestration/workflows", json=_valid_body())
    assert created.status_code == 201
    # Fail-closed: no author to name, so this definition cannot carry a
    # write-back (M3 refuses one) rather than falling back to an ambient
    # principal.
    assert created.json()["run_as_user_id"] is None
    assert created.json()["run_as_kind"] == "system"


def test_the_state_change_event_carries_the_run_as_principal(app, client):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")

    client.post("/api/v1/orchestration/workflows", json=_valid_body())
    published = fastapi.state.published
    assert published, "creating a definition must emit a state-change event"
    assert published[-1].payload["run_as_user_id"] == "user-a"


# ── write-back config: ceiling, catalog and authoring authority (ADR-0027) ────


@contextmanager
def _use_leads_target():
    """Make `leads` the ONLY registered target for the duration."""
    target = wb.WriteBackTarget(
        table="leads",
        model=WorkflowDefinition,  # any mapped class; the registry only holds it
        label="Lead",
        permission_code="leads.create",
        allowed_principals=("system:orchestrator",),
        columns=(
            wb.WriteBackColumn(name="email", label="Email", type="email", required=True),
            wb.WriteBackColumn(name="notes", label="Notes", type="textarea", overwrite="append"),
        ),
        operations=("create", "update"),
        derived=(
            wb.from_tenant(),
            wb.from_scope("brand_id", "brand"),
            wb.literal("source", "agent"),
        ),
        row_selector=wb.RowSelector(payload_field="lead_id"),
    )
    saved = dict(wb._targets)  # noqa: SLF001
    wb._targets.clear()  # noqa: SLF001
    wb.register_writeback_target(target)
    try:
        yield target
    finally:
        wb._targets.clear()  # noqa: SLF001
        wb._targets.update(saved)  # noqa: SLF001


@pytest.fixture
def leads_target():
    """The one registered target for the duration of a test.

    Isolates the *whole* registry rather than just this table, for the reason
    ``test_catalog_offers_no_writeback_targets_until_an_instance_registers_one``
    spells out: an instance registers its own targets as an import side effect of
    its domain module, so the registry is only empty in a bare template. Merely
    adding "leads" on top left those ambient targets visible, and every
    assertion here that names the catalog's contents exactly would fail the
    moment an instance registered a *second* table — passing upstream and
    breaking on distribution, which is the failure shape this repo keeps
    relearning.

    Teardown restores what was there instead of clearing it. The previous
    ``_targets.clear()`` threw away the instance's real registrations for every
    later test in the process, so a suite's result depended on the order it
    happened to run in.
    """
    with _use_leads_target() as registered:
        yield registered


@contextmanager
def _scope_authorizer_allowing_all():
    """Register a permissive scope authorizer for the duration of a test.

    Needed to reach the *write-back* gate at all as a non-admin: create/update
    run `_require_scope_access` first, and the default authorizer is fail-closed,
    so without this every non-admin request stops at "Not authorized for this
    scope" and never exercises what these tests are about.
    """
    from api import orchestration_authz as authz

    async def _allow(caller, db, scope):  # noqa: ANN001 — test double
        del caller, db, scope
        return True

    saved = authz._authorizer  # noqa: SLF001
    authz.register_workflow_scope_authorizer(_allow)
    try:
        yield
    finally:
        authz._authorizer = saved  # noqa: SLF001


def _writeback_body(writeback: dict | None, **over) -> dict:
    config: dict = {"agent_name": "qualifier", "instructions": "Assess it."}
    if writeback is not None:
        config["writeback"] = writeback
    return _valid_body(action_type="agent", action_config=config, **over)


_WB = {"table": "leads", "operation": "create", "columns": {"email": "{output.email}"}}
_SCOPED = {"scope": {"level": "brand", "id": "b1"}}


def test_catalog_offers_no_writeback_targets_until_an_instance_registers_one(client):
    # Clear whatever the ambient process registered before asserting the default.
    # An instance registers its targets as an import side effect of its domain
    # module, so "the registry is empty" is only true of a bare template — this
    # test would otherwise pass upstream and fail the moment it is distributed.
    saved = dict(wb._targets)  # noqa: SLF001
    wb._targets.clear()  # noqa: SLF001
    try:
        assert client.get(f"{_BASE}/catalog").json()["writeback_targets"] == []
    finally:
        wb._targets.update(saved)  # noqa: SLF001


def test_catalog_offers_a_registered_target_with_its_allowlist(client, leads_target):
    targets = client.get(f"{_BASE}/catalog").json()["writeback_targets"]
    assert [t["table"] for t in targets] == ["leads"]
    target = targets[0]
    assert target["operations"] == ["create", "update"]
    assert target["scope_levels"] == ["brand"]
    assert target["row_selector"] == "lead_id"
    # Only the agent-writeable columns are offered — the derived ones (tenant_id,
    # brand_id, source) are Core's and must never appear in a picker.
    assert [c["name"] for c in target["columns"]] == ["email", "notes"]
    assert next(c for c in target["columns"] if c["name"] == "notes")["overwrite"] == "append"


def test_the_target_fixture_isolates_the_registry_from_an_instance_s_own(client):
    """The guard for the fixture above, which an instance broke by growing.

    Every assertion in this section names the catalog's contents exactly, so
    they only hold while `leads` is the *only* registered target. An instance
    registers its own as an import side effect, and the fixture used to add to
    those rather than replace them — so the day tabsii registered a second
    table, `assert [...] == ["leads"]` started failing on distribution while
    passing here. It also used to clear the registry on teardown, taking the
    instance's real targets with it.

    This asserts both halves against a stand-in ambient target.
    """
    ambient = wb.WriteBackTarget(
        table="wb_ambient",
        model=WorkflowDefinition,
        label="Ambient",
        permission_code="ambient.create",
        allowed_principals=("system:orchestrator",),
        columns=(wb.WriteBackColumn(name="note", label="Note", type="textarea"),),
        operations=("create",),
    )
    saved = dict(wb._targets)  # noqa: SLF001
    wb.register_writeback_target(ambient)
    try:
        with _use_leads_target():
            tables = [
                t["table"] for t in client.get(f"{_BASE}/catalog").json()["writeback_targets"]
            ]
            # The instance's own target does not leak into a catalog assertion.
            assert tables == ["leads"]
        # …and survives the fixture's teardown.
        assert "wb_ambient" in wb._targets  # noqa: SLF001
    finally:
        wb._targets.clear()  # noqa: SLF001
        wb._targets.update(saved)  # noqa: SLF001


def test_catalog_hides_a_target_the_caller_could_not_write(app, client, leads_target):
    fastapi, _ = app
    # A scoped, non-admin caller holding no relevant permission.
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=[], user_id="user-a")
    assert client.get(f"{_BASE}/catalog").json()["writeback_targets"] == []


def test_rejects_a_column_outside_the_targets_allowlist(client, leads_target):
    body = _writeback_body(
        {"table": "leads", "columns": {"email": "x", "brand_id": "{output.brand}"}}, **_SCOPED
    )
    response = client.post(f"{_BASE}", json=body)
    assert response.status_code == 422
    assert "brand_id" in response.text


def test_rejects_a_missing_required_column_and_an_empty_column_map(client, leads_target):
    assert (
        client.post(
            f"{_BASE}",
            json=_writeback_body({"table": "leads", "columns": {"notes": "x"}}, **_SCOPED),
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{_BASE}", json=_writeback_body({"table": "leads", "columns": {}}, **_SCOPED)
        ).status_code
        == 422
    )


def test_rejects_an_operation_the_target_does_not_allow(client, leads_target):
    wb._targets.clear()  # noqa: SLF001
    wb.register_writeback_target(
        wb.WriteBackTarget(
            table="leads",
            model=WorkflowDefinition,
            label="Lead",
            permission_code="leads.create",
            allowed_principals=("system:orchestrator",),
            columns=(wb.WriteBackColumn(name="email", label="Email", required=True),),
            operations=("create",),
            derived=(wb.from_scope("brand_id", "brand"),),
        )
    )
    body = _writeback_body(
        {"table": "leads", "operation": "update", "columns": {"email": "x"}}, **_SCOPED
    )
    assert client.post(f"{_BASE}", json=body).status_code == 422


def test_an_update_may_not_invent_its_own_row_selector(client, leads_target):
    body = _writeback_body(
        {
            "table": "leads",
            "operation": "update",
            "columns": {"email": "x"},
            "row_selector": "whatever_the_agent_says",
        },
        **_SCOPED,
    )
    response = client.post(f"{_BASE}", json=body)
    assert response.status_code == 422
    assert "trigger event" in response.text


def test_an_unregistered_table_is_indistinguishable_from_one_that_does_not_exist(client):
    # 422 from the schema (it is not a target at all); the router's own 404 covers
    # the race where a target is deregistered between validation and the gate.
    response = client.post(
        f"{_BASE}",
        json=_writeback_body({"table": "salaries", "columns": {"amount": "1"}}, **_SCOPED),
    )
    assert response.status_code == 422


def test_a_caller_without_the_targets_permission_cannot_build_one(app, client, leads_target):
    fastapi, _ = app
    # Authorized for the scope, but holding no `leads.create` — so they may
    # author workflows here, just not ones that write to leads.
    fastapi.dependency_overrides[require_auth] = lambda: _caller(roles=[], user_id="user-a")
    with _scope_authorizer_allowing_all():
        response = client.post(f"{_BASE}", json=_writeback_body(_WB, **_SCOPED))
    assert response.status_code == 403
    assert "leads.create" in response.text


def test_a_caller_holding_the_permission_can_build_one(app, client, leads_target):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(
        roles=[], user_id="user-a", permissions=frozenset({"leads.create"})
    )
    with _scope_authorizer_allowing_all():
        response = client.post(f"{_BASE}", json=_writeback_body(_WB, **_SCOPED))
    assert response.status_code == 201, response.text
    assert response.json()["run_as_user_id"] == "user-a"


def test_a_writeback_needs_a_principal_to_run_as(app, client, leads_target):
    fastapi, _ = app
    # An admin (so the permission check passes) whose identity resolves no user.
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id=None)
    response = client.post(f"{_BASE}", json=_writeback_body(_WB, **_SCOPED))
    assert response.status_code == 403
    assert "no authority" in response.text


def test_a_scope_deriving_target_refuses_an_unscoped_workflow(app, client, leads_target):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")
    response = client.post(f"{_BASE}", json=_writeback_body(_WB))
    assert response.status_code == 422
    assert "scoped to a brand" in response.text


def test_a_scope_deriving_target_refuses_the_wrong_scope_level(app, client, leads_target):
    fastapi, _ = app
    fastapi.dependency_overrides[require_auth] = lambda: _caller(user_id="user-a")
    response = client.post(
        f"{_BASE}", json=_writeback_body(_WB, scope={"level": "region", "id": "r1"})
    )
    assert response.status_code == 422


def test_a_workflow_with_no_writeback_is_completely_unaffected(client, leads_target):
    assert client.post(f"{_BASE}", json=_writeback_body(None)).status_code == 201
