"""Integration test for the opt-in core-table CRUD router (ADR-0004):
a core ``TenantScopedModel`` subclass declaring ``__crud_permissions__`` ->
``build_core_crud_router([Model])`` -> real HTTP requests, driven end to end
through FastAPI's TestClient against an in-memory SQLite database.

Where test_plugin_router_integration.py drives a *plugin* manifest into routes,
this drives a *core model's* declarative ``__crud_permissions__`` block. The
block itself decides which routes exist: only operations with ``allowed: true``
are mounted, so ``delete`` (deliberately ``allowed: False`` below) is never
routed at all. Each mounted route still carries the ADR-0004 guard: 404 when an
operation isn't exposed, 403 when the caller lacks a ``required_role``.

The FastAPI + StaticPool + in-memory-SQLite fixture pattern (shared connection,
commit-on-success get_db override, require_auth override) is copied from
test_plugin_router_integration.py's ``plugin_app``.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.middleware.principal import Principal, require_principal
from api.models.base import Base, TenantScopedModel
from api.routing.core_crud_router import build_core_crud_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import String
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.pool import StaticPool


class Gadget(TenantScopedModel):
    """Throwaway core table used only by these tests. A distinctive tablename
    avoids colliding with any real table registered on ``Base.metadata``."""

    __tablename__ = "test_gadgets"

    label: Mapped[str] = mapped_column(String(200))

    __crud_permissions__ = {
        "list": {"allowed": True},
        "read": {"allowed": True},
        "create": {"allowed": True, "required_role": ["admin"]},
        "update": {"allowed": True},
        "delete": {"allowed": False},  # deliberately NOT exposed
    }


_BASE = "/api/v1/data/test_gadgets"


def _caller(tenant_id: str, roles: list[str]) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub=f"sub-{tenant_id}",
        email="gadget-caller@example.com",
        username="gadget-caller",
        tenant_id=tenant_id,
        roles=roles,
    )


@pytest.fixture
def gadget_app() -> Generator[FastAPI]:
    """A throwaway FastAPI app with the Gadget core table's generic CRUD routes
    mounted the same way main.py mounts build_core_crud_router() on the real
    app, backed by a single shared in-memory SQLite connection (StaticPool — the
    default aiosqlite pool would hand each session a *different* private
    :memory: database, so writes from one request wouldn't be visible to the
    next). Defaults require_auth to an admin caller in the "default" tenant;
    individual tests re-override it to exercise other callers.
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

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    # Pass the model explicitly — the router auto-builds its permissions registry
    # from the model's __crud_permissions__; we don't rely on discovery.
    app.include_router(build_core_crud_router([Gadget]), prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: _caller("default", ["admin"])

    app.dependency_overrides[require_principal] = lambda: Principal(
        user=_caller("default", ["admin"])
    )

    yield app

    asyncio.run(engine.dispose())


@pytest.fixture
def client(gadget_app: FastAPI) -> TestClient:
    return TestClient(gadget_app)


class TestOpenApiInclusion:
    """The permissions block decides which routes exist: list/read/create/update
    are exposed, delete is not — so the collection path has get+post, the row
    path has get+put, and DELETE is absent from the schema entirely."""

    def test_only_allowed_operations_are_mounted(self, gadget_app: FastAPI):
        paths = gadget_app.openapi()["paths"]

        assert _BASE in paths
        assert "get" in paths[_BASE]  # list
        assert "post" in paths[_BASE]  # create

        row_path = f"{_BASE}/{{id}}"
        assert row_path in paths
        row_ops = paths[row_path]
        assert "get" in row_ops  # read
        assert "put" in row_ops  # update
        # delete is allowed: False, so the route was never mounted.
        assert "delete" not in row_ops


class TestFullFlowAsAdmin:
    """create requires the "admin" role; the fixture's default caller has it, so
    the full create/list/read/update loop succeeds."""

    def test_create_list_read_update(self, client: TestClient):
        create_resp = client.post(_BASE, json={"label": "first gadget"})
        assert create_resp.status_code == 201
        created = create_resp.json()
        assert created["label"] == "first gadget"
        assert created["tenant_id"] == "default"
        gadget_id = created["id"]
        assert gadget_id

        list_resp = client.get(_BASE)
        assert list_resp.status_code == 200
        assert [g["id"] for g in list_resp.json()] == [gadget_id]

        read_resp = client.get(f"{_BASE}/{gadget_id}")
        assert read_resp.status_code == 200
        assert read_resp.json()["label"] == "first gadget"

        update_resp = client.put(f"{_BASE}/{gadget_id}", json={"label": "updated gadget"})
        assert update_resp.status_code == 200
        assert update_resp.json()["label"] == "updated gadget"


class TestRequiredRole:
    """create declares required_role ["admin"]; a caller with no roles is
    authenticated but unauthorized -> 403 (the operation is exposed, so it is
    deliberately NOT the 404 an unexposed operation returns)."""

    def test_create_as_non_admin_is_forbidden(self, gadget_app: FastAPI):
        gadget_app.dependency_overrides[require_auth] = lambda: _caller("default", [])

        gadget_app.dependency_overrides[require_principal] = lambda: Principal(
            user=_caller("default", [])
        )
        resp = TestClient(gadget_app).post(_BASE, json={"label": "sneaky"})
        assert resp.status_code == 403


class TestUnmountedDelete:
    """delete is allowed: False, so no DELETE route exists on the row path.
    FastAPI matches the path (GET/PUT are registered on /{id}) but not the
    method, so it returns 405 Method Not Allowed rather than 404."""

    def test_delete_returns_405(self, client: TestClient):
        create_resp = client.post(_BASE, json={"label": "to delete"})
        gadget_id = create_resp.json()["id"]

        delete_resp = client.delete(f"{_BASE}/{gadget_id}")
        assert delete_resp.status_code == 405


class TestTenantScoping:
    """Every generic CRUD route is tenant-scoped unconditionally (ADR-0001):
    a caller in one tenant must never see or read another tenant's rows, and
    can't override tenant_id via the request body."""

    def test_other_tenant_sees_nothing(self, gadget_app: FastAPI, client: TestClient):
        create_resp = client.post(_BASE, json={"label": "default's gadget"})
        gadget_id = create_resp.json()["id"]

        # Re-point the app at an admin caller in a different tenant.
        gadget_app.dependency_overrides[require_auth] = lambda: _caller("other-tenant", ["admin"])

        gadget_app.dependency_overrides[require_principal] = lambda: Principal(
            user=_caller("other-tenant", ["admin"])
        )
        other_client = TestClient(gadget_app)

        list_resp = other_client.get(_BASE)
        assert list_resp.status_code == 200
        assert list_resp.json() == []

        read_resp = other_client.get(f"{_BASE}/{gadget_id}")
        assert read_resp.status_code == 404

    def test_create_ignores_tenant_id_in_request_body(self, client: TestClient):
        resp = client.post(_BASE, json={"label": "spoofed", "tenant_id": "attacker"})
        assert resp.status_code == 201
        # tenant_id always comes from the verified caller, never the body.
        assert resp.json()["tenant_id"] == "default"
