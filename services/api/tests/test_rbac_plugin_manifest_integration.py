"""Integration test proving services/rbac/biffo.plugin.json (issue #27) is a
genuinely valid, working plugin manifest against the *real* Core API
pipeline built by issues #18/#19 — not just structurally parseable in
isolation.

Loads the real manifest file from disk (the same file
``discover_plugin_manifests()`` would find in a full monorepo checkout) and
drives it through the same table-parsing, route-parsing, and dynamic-router
machinery ``main.py`` uses for every installed plugin, finishing with a real
HTTP request through a throwaway FastAPI app — the same pattern
``test_plugin_router_integration.py`` uses for its "notepad" fixture
manifest, just against the RBAC plugin's real, on-disk manifest instead of
an inline fixture.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
from collections.abc import AsyncGenerator, Generator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.migrations.plugin_migrations import (
    generate_migration_for_plugin,
    parse_plugin_tables_from_manifest,
)
from api.models.base import Base
from api.models.plugin_route import parse_plugin_routes_from_manifest
from api.plugins import discover_plugin_manifests
from api.routing.plugin_router import build_plugin_router

_SERVICES_ROOT = Path(__file__).resolve().parents[2]
_SERVICES_API_DIR = Path(__file__).resolve().parent.parent
_MANIFEST_PATH = _SERVICES_ROOT / "rbac" / "biffo.plugin.json"


@pytest.fixture
def manifest() -> dict[str, Any]:
    """A fresh dict per test, loaded straight from disk.

    Deliberately *not* module- or session-scoped: both PluginTableDefinition
    (Core API) and TableDefinition's (SDK) `_ensure_auto_columns`
    `model_validator(mode="before")` mutate their input dict in place
    (appending resolved auto-columns and, for nested list-field validation,
    replacing raw dicts with model instances) rather than copying it.
    Production code never notices, because discover_plugin_manifests() does
    a fresh json.loads() on every call — but reusing one shared dict across
    several tests in this file (as a module-scoped fixture would) means the
    second test to validate it sees an already-corrupted 'columns' list and
    fails with a spurious "Column 'id' is reserved" error. A fresh read
    per test sidesteps that pre-existing gotcha rather than working around
    it in the shared validators themselves, which is out of scope here.
    """
    return json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))


class TestDiscoveryAndParsing:
    """The manifest is found by the real discovery scan and parses cleanly
    through both the table and route pipelines — proving it's not still
    shaped like the issue's stale pre-#65 example."""

    def test_discovered_by_real_services_root_scan(self) -> None:
        manifests = discover_plugin_manifests(_SERVICES_ROOT)
        names = {m["name"] for m in manifests}
        assert "rbac" in names

    def test_tables_parse_with_auto_columns_and_no_stale_fields(
        self, manifest: dict[str, Any]
    ) -> None:
        tables = {t.name: t for t in parse_plugin_tables_from_manifest(manifest)}
        assert set(tables) == {
            "rbac_roles",
            "rbac_permissions",
            "rbac_role_permissions",
            "rbac_user_roles",
        }
        for table in tables.values():
            col_names = {c.name for c in table.columns}
            assert {"id", "tenant_id", "created_at", "updated_at"} <= col_names

    def test_role_permissions_and_user_roles_have_no_declared_primary_key_columns(
        self, manifest: dict[str, Any]
    ) -> None:
        """Only the auto-injected `id` column is ever primary_key=True — the
        manifest doesn't try to redeclare a composite PK (unsupported;
        see services/rbac/README.md)."""
        tables = {t.name: t for t in parse_plugin_tables_from_manifest(manifest)}
        for name in ("rbac_role_permissions", "rbac_user_roles"):
            pk_cols = {c.name for c in tables[name].columns if c.primary_key}
            assert pk_cols == {"id"}

    def test_uniqueness_enforced_via_unique_indexes(
        self, manifest: dict[str, Any]
    ) -> None:
        tables = {t.name: t for t in parse_plugin_tables_from_manifest(manifest)}
        role_perm_idx = tables["rbac_role_permissions"].indexes
        assert any(
            set(i.columns) == {"role_id", "permission_id"} and i.unique
            for i in role_perm_idx
        )
        user_role_idx = tables["rbac_user_roles"].indexes
        assert any(
            set(i.columns) == {"user_id", "role_id"} and i.unique for i in user_role_idx
        )

    def test_routes_parse_and_reference_declared_tables_only(
        self, manifest: dict[str, Any]
    ) -> None:
        routes = parse_plugin_routes_from_manifest(manifest)
        assert len(routes) > 0
        table_names = {t["name"] for t in manifest["tables"]}
        for route in routes:
            assert route.table in table_names

    def test_check_permission_is_not_declared_as_a_manifest_route(
        self, manifest: dict[str, Any]
    ) -> None:
        """check_permission requires cross-table joins and can't be
        expressed as a single generic CRUD operation (ADR-0002/#19) -- it's
        served by the plugin's own microservice instead. Asserted here so a
        future edit can't silently reintroduce it as a fake CRUD route."""
        paths = {route["path"] for route in manifest["api_routes"]}
        assert not any("check" in p for p in paths)


class TestSdkManifestValidation:
    """The same manifest also validates against the SDK's PluginManifest
    (chunk 1 / issue #14) -- the schema a real external plugin author would
    be validated against."""

    def test_validates_against_sdk_plugin_manifest(
        self, manifest: dict[str, Any]
    ) -> None:
        from biffo_plugin_sdk import PluginManifest

        parsed = PluginManifest(**manifest)
        assert parsed.name == "rbac"
        assert len(parsed.tables) == 4
        assert len(parsed.api_routes) > 0


def _caller(tenant_id: str) -> AuthenticatedUser:
    # The rbac management tests legitimately act as an admin: under ADR-0004
    # generic-CRUD enforcement, create/update/delete on rbac tables require
    # the "admin" role, so the default caller these fixtures use must carry it.
    return AuthenticatedUser(
        sub=f"sub-{tenant_id}",
        email="rbac-caller@example.com",
        username="rbac-caller",
        tenant_id=tenant_id,
        roles=["admin"],
    )


@pytest.fixture
def rbac_app(manifest: dict[str, Any]) -> Generator[FastAPI, None, None]:
    """A throwaway FastAPI app with the *real* rbac manifest's routes
    mounted the way main.py mounts every installed plugin, backed by a
    shared in-memory SQLite connection (same StaticPool rationale as
    test_plugin_router_integration.py's plugin_app fixture)."""
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
    app.dependency_overrides[require_auth] = lambda: _caller("default")

    yield app

    asyncio.run(engine.dispose())


@pytest.fixture
def client(rbac_app: FastAPI) -> TestClient:
    return TestClient(rbac_app)


class TestGenericCrudFlowAgainstRealManifest:
    """End to end: real on-disk manifest -> dynamic routes -> real HTTP
    requests -> real (in-memory) database rows, for the exact table/route
    shapes this plugin ships."""

    def test_openapi_includes_rbac_routes(self, rbac_app: FastAPI) -> None:
        paths = rbac_app.openapi()["paths"]
        assert "/api/v1/plugins/rbac/roles" in paths
        assert "/api/v1/plugins/rbac/permissions" in paths
        assert "/api/v1/plugins/rbac/role-permissions" in paths
        assert "/api/v1/plugins/rbac/assignments" in paths

    def test_create_role_then_list_it(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/plugins/rbac/roles",
            json={"name": "viewer", "description": "Read-only", "is_system": False},
        )
        assert create_resp.status_code == 201
        role = create_resp.json()
        assert role["name"] == "viewer"
        assert role["tenant_id"] == "default"

        list_resp = client.get("/api/v1/plugins/rbac/roles")
        assert [r["name"] for r in list_resp.json()] == ["viewer"]

    def test_full_grant_and_assignment_flow(self, client: TestClient) -> None:
        role = client.post(
            "/api/v1/plugins/rbac/roles",
            json={"name": "editor", "is_system": False},
        ).json()
        permission = client.post(
            "/api/v1/plugins/rbac/permissions",
            json={"resource": "documents", "action": "write", "effect": "allow"},
        ).json()

        grant = client.post(
            "/api/v1/plugins/rbac/role-permissions",
            json={"role_id": role["id"], "permission_id": permission["id"]},
        )
        assert grant.status_code == 201

        assignment = client.post(
            "/api/v1/plugins/rbac/assignments",
            json={"user_id": "cognito-sub-123", "role_id": role["id"]},
        )
        assert assignment.status_code == 201
        assert assignment.json()["user_id"] == "cognito-sub-123"

        assignments = client.get("/api/v1/plugins/rbac/assignments").json()
        assert len(assignments) == 1

        delete_resp = client.delete(
            f"/api/v1/plugins/rbac/assignments/{assignment.json()['id']}"
        )
        assert delete_resp.status_code == 200
        assert client.get("/api/v1/plugins/rbac/assignments").json() == []


@pytest.fixture
def alembic_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A real Alembic Config chained onto the repo's actual 0001 migration,
    pointed at a throwaway SQLite file DB — same fixture shape as
    test_plugin_migrations_integration.py's ``alembic_setup``, needed here
    (rather than reused via import) because pytest fixtures aren't meant to
    be shared cross-module without a conftest.py, and this is the only test
    in this file that needs the real migration path rather than
    ``Base.metadata.create_all()``.
    """
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("BIFFO_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    if "src.api.config" in sys.modules:
        monkeypatch.setattr(
            sys.modules["src.api.config"].settings,
            "database_url",
            f"sqlite+aiosqlite:///{db_path}",
        )

    versions_dir = tmp_path / "versions"
    versions_dir.mkdir()
    shutil.copy(
        _SERVICES_API_DIR / "migrations" / "versions" / "0001_create_users_table.py",
        versions_dir / "0001_create_users_table.py",
    )

    monkeypatch.chdir(_SERVICES_API_DIR)
    cfg = Config("alembic.ini")
    cfg.set_main_option("version_locations", str(versions_dir))
    return cfg, versions_dir, db_path


class TestUniqueIndexesEnforcedViaRealMigration:
    """The CRUD handlers built by build_plugin_router() (via
    to_sqlalchemy_model()) don't themselves declare IndexDefinitions as
    SQLAlchemy Index objects -- to_sqlalchemy_model() only ever reads
    `columns`, never `indexes` (see plugin_table.py). So a test that creates
    tables via Base.metadata.create_all() (as TestGenericCrudFlowAgainstRealManifest
    above does) never sees this manifest's unique indexes at all -- they
    only exist once the *real* migration path (generate_migration_for_plugin
    -> alembic upgrade, exactly what sync_plugin_migrations/_run_db_init do
    in production) has actually run, because that's the only code path that
    reads `indexes` (_build_index_statements). This test proves the unique
    indexes this manifest declares are real, DB-enforced constraints via
    that real path -- not just parsed Pydantic data.
    """

    def test_duplicate_role_name_in_tenant_rejected_at_db_level(
        self, alembic_setup, manifest: dict[str, Any]
    ) -> None:
        cfg, versions_dir, db_path = alembic_setup
        generate_migration_for_plugin(manifest, versions_dir)
        command.upgrade(cfg, "head")

        engine = sa.create_engine(f"sqlite:///{db_path}")
        try:
            indexes = sa.inspect(engine).get_indexes("rbac_roles")
            assert any(
                set(idx["column_names"]) == {"tenant_id", "name"} and idx["unique"]
                for idx in indexes
            )

            # created_at/updated_at are nullable=False with no DB-level
            # default in the generated migration (ColumnDefinition.default
            # is never read by the migration generator — see
            # services/rbac/README.md's "declared defaults are not applied"
            # note), so a raw insert must supply them explicitly.
            now = datetime.now(timezone.utc)
            metadata = sa.MetaData()
            roles = sa.Table("rbac_roles", metadata, autoload_with=engine)
            with engine.begin() as conn:
                conn.execute(
                    sa.insert(roles),
                    {
                        "id": "r1",
                        "tenant_id": "default",
                        "name": "editor",
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                with pytest.raises(IntegrityError):
                    conn.execute(
                        sa.insert(roles),
                        {
                            "id": "r2",
                            "tenant_id": "default",
                            "name": "editor",
                            "created_at": now,
                            "updated_at": now,
                        },
                    )
        finally:
            engine.dispose()

    def test_role_permission_pair_uniqueness_enforced_at_db_level(
        self, alembic_setup, manifest: dict[str, Any]
    ) -> None:
        cfg, versions_dir, db_path = alembic_setup
        generate_migration_for_plugin(manifest, versions_dir)
        command.upgrade(cfg, "head")

        engine = sa.create_engine(f"sqlite:///{db_path}")
        try:
            now = datetime.now(timezone.utc)
            metadata = sa.MetaData()
            role_permissions = sa.Table(
                "rbac_role_permissions", metadata, autoload_with=engine
            )
            with engine.begin() as conn:
                conn.execute(
                    sa.insert(role_permissions),
                    {
                        "id": "rp1",
                        "tenant_id": "default",
                        "role_id": "role-1",
                        "permission_id": "perm-1",
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                with pytest.raises(IntegrityError):
                    conn.execute(
                        sa.insert(role_permissions),
                        {
                            "id": "rp2",
                            "tenant_id": "default",
                            "role_id": "role-1",
                            "permission_id": "perm-1",
                            "created_at": now,
                            "updated_at": now,
                        },
                    )
        finally:
            engine.dispose()


class TestRbacPermissionEnforcement:
    """ADR-0004 role gating on the *real* rbac manifest: `list`/`read` are
    open to any authenticated caller (required_role: []), while
    `create`/`update`/`delete` require the "admin" role. The
    ``require_crud_permission`` guard build_plugin_router() attaches returns
    403 when the caller lacks a required role -- proven here end to end
    against the on-disk manifest, varying only the caller's roles per case
    (via the same dependency_overrides[require_auth] swap
    test_plugin_router_integration.py uses for its tenant-isolation test)."""

    @staticmethod
    def _non_admin() -> AuthenticatedUser:
        return AuthenticatedUser(
            sub="sub-nonadmin",
            email="nonadmin@example.com",
            username="nonadmin",
            tenant_id="default",
            roles=[],
        )

    @staticmethod
    def _admin() -> AuthenticatedUser:
        return AuthenticatedUser(
            sub="sub-admin",
            email="admin@example.com",
            username="admin",
            tenant_id="default",
            roles=["admin"],
        )

    def test_non_admin_can_list_roles(self, rbac_app: FastAPI) -> None:
        rbac_app.dependency_overrides[require_auth] = self._non_admin
        client = TestClient(rbac_app)
        resp = client.get("/api/v1/plugins/rbac/roles")
        assert resp.status_code == 200

    def test_non_admin_cannot_create_role(self, rbac_app: FastAPI) -> None:
        rbac_app.dependency_overrides[require_auth] = self._non_admin
        client = TestClient(rbac_app)
        resp = client.post(
            "/api/v1/plugins/rbac/roles",
            json={"name": "viewer", "is_system": False},
        )
        assert resp.status_code == 403

    def test_admin_can_create_role(self, rbac_app: FastAPI) -> None:
        rbac_app.dependency_overrides[require_auth] = self._admin
        client = TestClient(rbac_app)
        resp = client.post(
            "/api/v1/plugins/rbac/roles",
            json={"name": "viewer", "is_system": False},
        )
        assert resp.status_code == 201
