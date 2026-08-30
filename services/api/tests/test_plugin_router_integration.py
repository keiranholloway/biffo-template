"""Integration test for the plugin route pipeline (issue #19):
plugin manifest -> dynamic route registration -> real HTTP request, driven
end to end through FastAPI's TestClient against an in-memory SQLite database.

Unlike test_plugin_migrations_integration.py (which drives the migration
pipeline), this drives the request pipeline: build_plugin_router() builds a
real APIRouter from a manifest, mounted on a throwaway FastAPI app the same
way main.py mounts it on the real app, and every CRUD operation the manifest
declares is exercised as an actual HTTP call.
"""

from collections.abc import AsyncGenerator, Generator
from contextlib import asynccontextmanager, contextmanager

import pytest
from api.database import get_db
from api.dependencies import require_plugin_tenant_context, require_principal_crud_permission
from api.middleware.auth import AuthenticatedUser, require_auth
from api.middleware.principal import Principal, require_principal
from api.middleware.service_auth import ServicePrincipal
from api.models.base import Base
from api.routing.plugin_router import build_plugin_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool


# Every throwaway app in this file needs an in-memory SQLite engine whose
# tables exist before the first request and whose connection is disposed
# after the last one. The obvious way to write that -- `asyncio.run(_create())`
# on a one-off loop, then hand the engine to `TestClient` -- builds the
# engine's aiosqlite connection on a loop that is closed before the first
# request runs; `TestClient`'s own request loop (and, for a bare
# `TestClient(app)` with no `with`, potentially a *fresh* loop per call) is a
# different one. That cross-loop reuse is exactly #1725's cause 3:
# non-deterministic `RuntimeError: Event loop is closed` / `sqlite3.OperationalError:
# no such table` failures under pytest-xdist, confirmed as the sole remaining
# source of parallel flakiness in this file.
#
# FastAPI's lifespan protocol is the fix: attached via `app = FastAPI(lifespan=...)`
# and driven through `with TestClient(app) as client:`, startup and every
# request handler are guaranteed to run on the *same* loop -- Starlette's own
# portal, entered once for the `with` block's lifetime. That makes the
# cross-loop failure structurally impossible rather than merely rare, so every
# engine in this file is built through this one helper instead of three
# separate copies of the same throwaway-loop pattern.
def _lifespan_owning(engine: AsyncEngine):
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        try:
            yield
        finally:
            await engine.dispose()

    return lifespan


_HOST_ARN = "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-host-role/host-session"

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
def plugin_app() -> Generator[FastAPI]:
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
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI(lifespan=_lifespan_owning(engine))
    app.include_router(build_plugin_router(manifests=[_NOTEPAD_MANIFEST]), prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: _caller("default")
    # The generated handlers resolve tenant via require_principal (#652), so the
    # injected caller has to be visible on that seam too, not just require_auth.
    app.dependency_overrides[require_principal] = lambda: Principal(user=_caller("default"))

    yield app


@pytest.fixture
def client(plugin_app: FastAPI) -> Generator[TestClient]:
    # `with` is load-bearing, not style -- it is what runs plugin_app's
    # lifespan (table creation, later disposal) on the same loop that serves
    # every request below. See _lifespan_owning.
    with TestClient(plugin_app) as c:
        yield c


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
        resp = client.put("/api/v1/plugins/notepad/notes/does-not-exist", json={"title": "x"})
        assert resp.status_code == 404

    def test_delete_unknown_id_returns_404(self, client: TestClient):
        resp = client.delete("/api/v1/plugins/notepad/notes/does-not-exist")
        assert resp.status_code == 404


class TestTenantScoping:
    """Every plugin route requires require_tenant_context (ADR-0001 / CLAUDE.md
    invariant #2) — a caller in one tenant must never see or mutate another
    tenant's rows, and can't override tenant_id via the request body."""

    def test_create_rejects_tenant_id_in_request_body(self, client: TestClient):
        # tenant_id always comes from require_plugin_tenant_context, never the
        # body — it is never settable, and since tabsii-platform#474 an
        # attempt to set it is rejected outright (422) rather than silently
        # ignored, so a caller never mistakes a dropped field for a write that
        # took effect.
        resp = client.post(
            "/api/v1/plugins/notepad/notes",
            json={"title": "spoofed", "tenant_id": "attacker-tenant"},
        )
        assert resp.status_code == 422

    def test_other_tenant_cannot_see_or_mutate_row(self, plugin_app: FastAPI, client: TestClient):
        create_resp = client.post(
            "/api/v1/plugins/notepad/notes", json={"title": "tenant A's note"}
        )
        note_id = create_resp.json()["id"]

        plugin_app.dependency_overrides[require_auth] = lambda: _caller("other-tenant")
        plugin_app.dependency_overrides[require_principal] = lambda: Principal(
            user=_caller("other-tenant")
        )

        list_resp = client.get("/api/v1/plugins/notepad/notes")
        assert list_resp.json() == []

        read_resp = client.get(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert read_resp.status_code == 404

        delete_resp = client.delete(f"/api/v1/plugins/notepad/notes/{note_id}")
        assert delete_resp.status_code == 404

    def test_unauthenticated_request_is_rejected(self):
        """With no auth override, the real dependency chain runs —
        require_plugin_tenant_context -> require_principal -> HTTPBearer security
        — and a request with no Authorization header is rejected before it
        ever reaches the generic CRUD handler."""
        app = FastAPI()
        app.include_router(build_plugin_router(manifests=[_NOTEPAD_MANIFEST]), prefix="/api/v1")
        # get_db must still be overridden (no real DB in this test process),
        # but the auth dependencies are deliberately left un-overridden.
        app.dependency_overrides[get_db] = lambda: iter(())

        resp = TestClient(app).get("/api/v1/plugins/notepad/notes")
        assert resp.status_code in (401, 403)


class TestRequirePluginTenantContext:
    """Unit-level check that the dependency plugin routes use behaves exactly
    like the one every native route uses, for an authenticated caller."""

    def test_returns_tenant_id_from_caller(self):
        assert require_plugin_tenant_context(Principal(user=_caller("default"))) == "default"


@contextmanager
def _enforcement_client(manifest: dict, caller: AuthenticatedUser) -> Generator[TestClient]:
    """Build a throwaway app for one manifest + caller, for the ADR-0004
    enforcement tests. Mirrors the plugin_app fixture but parameterized."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI(lifespan=_lifespan_owning(engine))
    app.include_router(build_plugin_router(manifests=[manifest]), prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: caller
    app.dependency_overrides[require_principal] = lambda: Principal(user=caller)

    with TestClient(app) as client:
        yield client


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
        with _enforcement_client(manifest, _caller("default")) as client:
            assert client.get("/api/v1/plugins/gadgets/g").status_code == 404
            assert client.post("/api/v1/plugins/gadgets/g", json={"label": "x"}).status_code == 404

    def test_allowed_op_is_reachable_denied_op_is_404(self):
        manifest = _manifest_with_permissions(
            {"list": {"allowed": True}}  # only list; create/etc. default-denied
        )
        with _enforcement_client(manifest, _caller("default")) as client:
            assert client.get("/api/v1/plugins/gadgets/g").status_code == 200
            # create declared as a route but not allowed -> 404, not 403.
            assert client.post("/api/v1/plugins/gadgets/g", json={"label": "x"}).status_code == 404

    def test_role_gated_op_forbidden_without_role(self):
        manifest = _manifest_with_permissions(
            {
                "list": {"allowed": True},
                "create": {"allowed": True, "required_role": ["editor"]},
            }
        )
        # Caller has no roles -> can list, but create is 403 (exposed, wrong role).
        with _enforcement_client(manifest, _caller("default")) as client:
            assert client.get("/api/v1/plugins/gadgets/g").status_code == 200
            assert client.post("/api/v1/plugins/gadgets/g", json={"label": "x"}).status_code == 403

    def test_role_gated_op_allowed_with_matching_role(self):
        manifest = _manifest_with_permissions(
            {"create": {"allowed": True, "required_role": ["editor", "admin"]}}
        )
        # Any-of match: caller has 'editor', one of the required roles.
        with _enforcement_client(manifest, _caller("default", roles=["editor"])) as client:
            resp = client.post("/api/v1/plugins/gadgets/g", json={"label": "x"})
            assert resp.status_code == 201
            assert resp.json()["label"] == "x"


@contextmanager
def _internal_app(caller: AuthenticatedUser, *, service: bool) -> Generator[TestClient]:
    """An app carrying BOTH mounts, with the caller injected on the principal
    seam only — i.e. exactly what a SigV4 host forwarding a user token looks
    like to Core. `require_auth` is deliberately left un-overridden so the
    public mount's bearer-only guard behaves as it really would."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI(lifespan=_lifespan_owning(engine))
    app.include_router(build_plugin_router(manifests=[_NOTEPAD_MANIFEST]), prefix="/api/v1")
    app.include_router(
        build_plugin_router(
            manifests=[_NOTEPAD_MANIFEST],
            path_prefix="/internal/plugins",
            guard_factory=require_principal_crud_permission,
        ),
        prefix="/api/v1",
    )
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_principal] = lambda: Principal(
        user=caller,
        service=ServicePrincipal(principal_arn=_HOST_ARN) if service else None,
    )
    with TestClient(app) as client:
        yield client


class TestInternalMount:
    """The second mount that makes plugin-declared api_routes reachable (#652).

    API Gateway sends all of /api/v1/plugins/* to the shared plugin host
    (ADR-0021), so Core's public mount above — correct as it is — cannot be
    addressed from outside; a plugin calling it loops back into the host.
    /api/v1/internal/* is IAM-authorized and does reach Core, so the same routes
    are mounted there for the host to forward to.

    Same routes, same handlers, same permission rules. The only difference is
    which transport the guard accepts.
    """

    def test_the_same_routes_are_mounted_under_the_internal_prefix(self):
        """Identical route set, differing only by the prefix — so the internal
        mount cannot silently expose more (or less) than the public one."""

        def paths_of(**kwargs) -> dict[str, set[str]]:
            app = FastAPI()
            app.include_router(
                build_plugin_router(manifests=[_NOTEPAD_MANIFEST], **kwargs), prefix="/api/v1"
            )
            return {p: set(ops) for p, ops in app.openapi()["paths"].items()}

        public = paths_of()
        internal = paths_of(
            path_prefix="/internal/plugins",
            guard_factory=require_principal_crud_permission,
        )

        assert public, "sanity: the public mount has routes"
        assert {
            p.replace("/plugins/", "/internal/plugins/", 1): ops for p, ops in public.items()
        } == internal

    def test_a_forwarded_caller_reaches_the_internal_mount(self):
        """A signed host forwarding a real user's token gets served — the case
        the bearer-only guard refuses, and the reason #652 was unfixable in the
        plugin."""
        with _internal_app(_caller("default"), service=True) as client:
            resp = client.get("/api/v1/internal/plugins/notepad/notes")
            assert resp.status_code == 200, resp.text
            assert resp.json() == []

    def test_the_public_mount_still_refuses_a_principal_only_caller(self):
        """The widening must not leak onto the public routes: they keep the
        bearer-only guard, so overriding only the principal seam is not enough
        to reach them."""
        with _internal_app(_caller("default"), service=True) as client:
            resp = client.get("/api/v1/plugins/notepad/notes")
            assert resp.status_code in (401, 403), resp.text
