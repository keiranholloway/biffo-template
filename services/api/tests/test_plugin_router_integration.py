"""Integration test for the plugin route pipeline (issue #19):
plugin manifest -> dynamic route registration -> real HTTP request, driven
end to end through FastAPI's TestClient against an in-memory SQLite database.

Unlike test_plugin_migrations_integration.py (which drives the migration
pipeline), this drives the request pipeline: build_plugin_router() builds a
real APIRouter from a manifest, mounted on a throwaway FastAPI app the same
way main.py mounts it on the real app, and every CRUD operation the manifest
declares is exercised as an actual HTTP call.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.database import get_db
from api.dependencies import require_plugin_tenant_context
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.base import Base
from api.routing.plugin_router import build_plugin_router

_NOTEPAD_MANIFEST = {
    "name": "notepad",
    "version": "1.0.0",
    "tables": [
        {
            "name": "notes",
            "columns": [
                {"name": "title", "type": "String(200)"},
                {"name": "body", "type": "Text", "nullable": True},
            ],
            # ADR-0004: every operation exposed to any authenticated caller, so
            # the CRUD/tenant tests below exercise the handlers themselves. The
            # enforcement tests further down use their own tailored manifests.
            "permissions": {
                "list": {"allowed": True},
                "read": {"allowed": True},
                "create": {"allowed": True},
                "update": {"allowed": True},
                "delete": {"allowed": True},
            },
        }
    ],
    "api_routes": [
        {"method": "GET", "path": "/notes", "table": "notes", "operation": "list"},
        {
            "method": "GET",
            "path": "/notes/{id}",
            "table": "notes",
            "operation": "read",
        },
        {"method": "POST", "path": "/notes", "table": "notes", "operation": "create"},
        {
            "method": "PUT",
            "path": "/notes/{id}",
            "table": "notes",
            "operation": "update",
        },
        {
            "method": "DELETE",
            "path": "/notes/{id}",
            "table": "notes",
            "operation": "delete",
        },
    ],
}


def _caller(tenant_id: str, roles: list[str] | None = None) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub=f"sub-{tenant_id}",
        email="plugin-caller@example.com",
        username="plugin-caller",
        tenant_id=tenant_id,
        roles=roles or [],
    )


@pytest.fixture
def plugin_app() -> Generator[FastAPI, None, None]:
    """A throwaway FastAPI app with the notepad plugin's routes mounted the
    same way main.py mounts build_plugin_router() on the real app, backed by
    a single shared in-memory SQLite connection (StaticPool — the default
    aiosqlite pool would hand each session a *different* private :memory:
    database, so writes from one request wouldn't be visible to the next).
    """
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create_tables() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create_tables())

    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(
        build_plugin_router(manifests=[_NOTEPAD_MANIFEST]), prefix="/api/v1"
    )
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: _caller("default")

    yield app

    asyncio.run(engine.dispose())


@pytest.fixture
def client(plugin_app: FastAPI) -> TestClient:
    return TestClient(plugin_app)


class TestOpenApiInclusion:
    """FastAPI includes dynamically-added routers in the OpenAPI schema for
    free, but only if they're actually included with include_router() —
    this asserts that wiring is correct rather than assuming it."""

    def test_plugin_routes_appear_in_openapi_schema(self, plugin_app: FastAPI):
        schema = plugin_app.openapi()
        paths = schema["paths"]

        assert "/api/v1/plugins/notepad/notes" in paths
        assert "get" in paths["/api/v1/plugins/notepad/notes"]
        assert "post" in paths["/api/v1/plugins/notepad/notes"]

        assert "/api/v1/plugins/notepad/notes/{id}" in paths
        detail_ops = paths["/api/v1/plugins/notepad/notes/{id}"]
        assert {"get", "put", "delete"} <= detail_ops.keys()


class TestGenericCrudFlow:
    """Manifest -> route registration -> real HTTP request, full CRUD loop."""

    def test_create_list_read_update_delete(self, client: TestClient):
        create_resp = client.post(
            "/api/v1/plugins/notepad/notes",
            json={"title": "First note", "body": "hello"},
        )
        assert create_resp.status_code == 201
        created = create_resp.json()
        assert created["title"] == "First note"
        assert created["body"] == "hello"
        assert created["tenant_id"] == "default"
        note_id = created["id"]
        assert note_id

        list_resp = client.get("/api/v1/plugins/notepad/notes")
        assert list_resp.status_code == 200
        assert [n["id"] for n in list_resp.json()] == [note_id]

        read_resp = client.get(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert read_resp.status_code == 200
        assert read_resp.json()["title"] == "First note"

        update_resp = client.put(
            f"/api/v1/plugins/notepad/notes/{note_id}",
            json={"title": "Updated note"},
        )
        assert update_resp.status_code == 200
        updated = update_resp.json()
        assert updated["title"] == "Updated note"
        assert updated["body"] == "hello"  # untouched field preserved

        delete_resp = client.delete(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert delete_resp.status_code == 200
        assert delete_resp.json() == {"deleted": True, "id": note_id}

        gone_resp = client.get(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert gone_resp.status_code == 404

    def test_read_unknown_id_returns_404(self, client: TestClient):
        resp = client.get("/api/v1/plugins/notepad/notes/does-not-exist")
        assert resp.status_code == 404

    def test_update_unknown_id_returns_404(self, client: TestClient):
        resp = client.put(
            "/api/v1/plugins/notepad/notes/does-not-exist", json={"title": "x"}
        )
        assert resp.status_code == 404

    def test_delete_unknown_id_returns_404(self, client: TestClient):
        resp = client.delete("/api/v1/plugins/notepad/notes/does-not-exist")
        assert resp.status_code == 404


class TestTenantScoping:
    """Every plugin route requires require_tenant_context (ADR-0001 / CLAUDE.md
    invariant #2) — a caller in one tenant must never see or mutate another
    tenant's rows, and can't override tenant_id via the request body."""

    def test_create_ignores_tenant_id_in_request_body(self, client: TestClient):
        resp = client.post(
            "/api/v1/plugins/notepad/notes",
            json={"title": "spoofed", "tenant_id": "attacker-tenant"},
        )
        assert resp.status_code == 201
        # tenant_id always comes from require_plugin_tenant_context, never the body.
        assert resp.json()["tenant_id"] == "default"

    def test_other_tenant_cannot_see_or_mutate_row(
        self, plugin_app: FastAPI, client: TestClient
    ):
        create_resp = client.post(
            "/api/v1/plugins/notepad/notes", json={"title": "tenant A's note"}
        )
        note_id = create_resp.json()["id"]

        plugin_app.dependency_overrides[require_auth] = lambda: _caller("other-tenant")

        list_resp = client.get("/api/v1/plugins/notepad/notes")
        assert list_resp.json() == []

        read_resp = client.get(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert read_resp.status_code == 404

        delete_resp = client.delete(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert delete_resp.status_code == 404

    def test_unauthenticated_request_is_rejected(self):
        """With no require_auth override, the real dependency chain runs —
        require_plugin_tenant_context -> require_auth -> HTTPBearer security
        — and a request with no Authorization header is rejected before it
        ever reaches the generic CRUD handler."""
        app = FastAPI()
        app.include_router(
            build_plugin_router(manifests=[_NOTEPAD_MANIFEST]), prefix="/api/v1"
        )
        # get_db must still be overridden (no real DB in this test process),
        # but require_auth is deliberately left un-overridden.
        app.dependency_overrides[get_db] = lambda: iter(())

        resp = TestClient(app).get("/api/v1/plugins/notepad/notes")
        assert resp.status_code in (401, 403)


class TestRequirePluginTenantContext:
    """Unit-level check that the dependency plugin routes use behaves exactly
    like the one every native route uses, for an authenticated caller."""

    def test_returns_tenant_id_from_caller(self):
        assert require_plugin_tenant_context(_caller("default")) == "default"


def _enforcement_client(
    manifest: dict, caller: AuthenticatedUser
) -> Generator[TestClient, None, None]:
    """Build a throwaway app for one manifest + caller, for the ADR-0004
    enforcement tests. Mirrors the plugin_app fixture but parameterized."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create_tables() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create_tables())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(build_plugin_router(manifests=[manifest]), prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: caller

    try:
        yield TestClient(app)
    finally:
        asyncio.run(engine.dispose())


def _manifest_with_permissions(permissions: dict) -> dict:
    """A one-table 'gadgets' plugin declaring all five CRUD routes, with the
    given permissions block."""
    return {
        "name": "gadgets",
        "version": "1.0.0",
        "tables": [
            {
                "name": "gadgets",
                "columns": [{"name": "label", "type": "String(100)"}],
                "permissions": permissions,
            }
        ],
        "api_routes": [
            {"method": "GET", "path": "/g", "table": "gadgets", "operation": "list"},
            {
                "method": "GET",
                "path": "/g/{id}",
                "table": "gadgets",
                "operation": "read",
            },
            {"method": "POST", "path": "/g", "table": "gadgets", "operation": "create"},
            {
                "method": "PUT",
                "path": "/g/{id}",
                "table": "gadgets",
                "operation": "update",
            },
            {
                "method": "DELETE",
                "path": "/g/{id}",
                "table": "gadgets",
                "operation": "delete",
            },
        ],
    }


class TestPermissionEnforcement:
    """ADR-0004: the generic CRUD layer authorises per (table, operation) from
    the declared permissions block. Default-deny; 404 for not-exposed, 403 for
    exposed-but-wrong-role."""

    def test_table_with_no_permissions_block_is_fully_invisible(self):
        # Declares routes but no permissions -> every operation 404s (default-deny),
        # indistinguishable from a table that doesn't exist.
        manifest = {
            "name": "gadgets",
            "version": "1.0.0",
            "tables": [
                {
                    "name": "gadgets",
                    "columns": [{"name": "label", "type": "String(100)"}],
                }
            ],
            "api_routes": [
                {
                    "method": "GET",
                    "path": "/g",
                    "table": "gadgets",
                    "operation": "list",
                },
                {
                    "method": "POST",
                    "path": "/g",
                    "table": "gadgets",
                    "operation": "create",
                },
            ],
        }
        for client in _enforcement_client(manifest, _caller("default")):
            assert client.get("/api/v1/plugins/gadgets/g").status_code == 404
            assert (
                client.post(
                    "/api/v1/plugins/gadgets/g", json={"label": "x"}
                ).status_code
                == 404
            )

    def test_allowed_op_is_reachable_denied_op_is_404(self):
        manifest = _manifest_with_permissions(
            {"list": {"allowed": True}}  # only list; create/etc. default-denied
        )
        for client in _enforcement_client(manifest, _caller("default")):
            assert client.get("/api/v1/plugins/gadgets/g").status_code == 200
            # create declared as a route but not allowed -> 404, not 403.
            assert (
                client.post(
                    "/api/v1/plugins/gadgets/g", json={"label": "x"}
                ).status_code
                == 404
            )

    def test_role_gated_op_forbidden_without_role(self):
        manifest = _manifest_with_permissions(
            {
                "list": {"allowed": True},
                "create": {"allowed": True, "required_role": ["editor"]},
            }
        )
        # Caller has no roles -> can list, but create is 403 (exposed, wrong role).
        for client in _enforcement_client(manifest, _caller("default")):
            assert client.get("/api/v1/plugins/gadgets/g").status_code == 200
            assert (
                client.post(
                    "/api/v1/plugins/gadgets/g", json={"label": "x"}
                ).status_code
                == 403
            )

    def test_role_gated_op_allowed_with_matching_role(self):
        manifest = _manifest_with_permissions(
            {"create": {"allowed": True, "required_role": ["editor", "admin"]}}
        )
        # Any-of match: caller has 'editor', one of the required roles.
        for client in _enforcement_client(
            manifest, _caller("default", roles=["editor"])
        ):
            resp = client.post("/api/v1/plugins/gadgets/g", json={"label": "x"})
            assert resp.status_code == 201
            assert resp.json()["label"] == "x"
