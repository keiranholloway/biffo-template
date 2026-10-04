"""Admin cross-owner read of a plugin's owner-scoped tables, against REAL Postgres
(ADR-0017 §5 admin exception).

Two gates, both mandatory: the table must name the calling service principal
(404 otherwise), and the forwarded user must be in the ``admin`` group (403;
a service call with no forwarded user is refused by ``require_signed_principal``).
Tenant scoping applies unconditionally. Skips without a Postgres DSN, like this
repo's other ``test_*_pg.py`` modules.
"""

from __future__ import annotations

import copy
import os
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from api.database import get_db
from api.middleware.auth import AuthenticatedUser
from api.middleware.principal import Principal, require_principal
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.routing.owner_data_router import build_owner_data_router
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def _pg_dsn() -> str | None:
    return os.environ.get("BIFFO_TEST_PG_DSN") or os.environ.get("TABSII_TEST_PG_DSN")


pytestmark = [
    pytest.mark.skipif(
        _pg_dsn() is None,
        reason=(
            "NEVER EXECUTED IN THIS REPO without a Postgres DSN. Run it for real: "
            'eval "$(sh scripts/pg-test-db.sh --export)"'
        ),
    ),
    # Performs DDL (CREATE/DROP SCHEMA, create_all) against the shared pg-lane
    # database, so it must run in the serial pass.
    pytest.mark.serial,
]


def _plugin_manifest(plugin: str, table: str) -> dict:
    return {
        "name": plugin,
        "tables": [
            {
                "name": table,
                "columns": [
                    {"name": "owner_sub", "type": "String(64)", "nullable": False},
                    {"name": "label", "type": "String(200)", "nullable": True},
                ],
                "permissions": {},
                "owner_scoped_service": {
                    "owner_column": "owner_sub",
                    "allowed_principals": [f"system:{plugin}"],
                },
            }
        ],
    }


_A_TABLE = "adminread_a_items"
_B_TABLE = "adminread_b_items"
_MANIFESTS = [
    _plugin_manifest("adminreada", _A_TABLE),
    _plugin_manifest("adminreadb", _B_TABLE),
]


def _arn(plugin: str) -> str:
    return f"arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-{plugin}-role/s"


def _user(sub: str, *, roles: list[str], tenant: str = "default") -> AuthenticatedUser:
    return AuthenticatedUser(
        sub=sub, email=f"{sub}@x.com", username=sub, tenant_id=tenant, roles=roles, user_id=None
    )


@pytest_asyncio.fixture
async def schema() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    dsn = _pg_dsn()
    assert dsn is not None
    name = f"adminread_{uuid.uuid4().hex[:10]}"
    router = build_owner_data_router(manifests=copy.deepcopy(_MANIFESTS))
    tables = [t for t in Base.metadata.sorted_tables if t.name in (_A_TABLE, _B_TABLE)]
    assert len(tables) == 2

    engine = create_async_engine(dsn)
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{name}"'))
        await conn.execute(text(f'SET search_path TO "{name}"'))
        await conn.run_sync(Base.metadata.create_all, tables=tables, checkfirst=False)
    await engine.dispose()

    scoped = create_async_engine(dsn, connect_args={"server_settings": {"search_path": name}})
    factory = async_sessionmaker(scoped, expire_on_commit=False)
    factory.router = router  # type: ignore[attr-defined]
    yield factory
    await scoped.dispose()

    cleanup = create_async_engine(dsn)
    async with cleanup.begin() as conn:
        await conn.execute(text(f'DROP SCHEMA "{name}" CASCADE'))
    await cleanup.dispose()


def _client(
    factory,
    *,
    user: AuthenticatedUser | None,
    plugin: str = "adminreada",
) -> AsyncClient:
    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(factory.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn=_arn(plugin)
    )
    if user is not None:
        app.dependency_overrides[require_principal] = lambda: Principal(user=user)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


async def _seed(factory) -> dict[str, str]:
    """alice and bob own rows in tenant `default`; carol owns one in `other`."""
    ids: dict[str, str] = {}
    for sub, tenant in (("alice", "default"), ("bob", "default"), ("carol", "other")):
        c = _client(factory, user=_user(sub, roles=[], tenant=tenant))
        r = await c.post(f"/api/v1/internal/owner-data/{_A_TABLE}", json={"label": sub})
        assert r.status_code == 201, r.text
        ids[sub] = r.json()["id"]
        await c.aclose()
    return ids


_ADMIN_A = f"/api/v1/internal/owner-data-admin/{_A_TABLE}"


@pytest.mark.asyncio
async def test_admin_lists_rows_from_two_owners_with_owner_column(schema) -> None:
    ids = await _seed(schema)
    admin = _client(schema, user=_user("root", roles=["admin"]))

    rows = (await admin.get(_ADMIN_A)).json()
    assert {r["owner_sub"] for r in rows} == {"alice", "bob"}

    narrowed = (await admin.get(f"{_ADMIN_A}?owner_sub=bob")).json()
    assert [r["owner_sub"] for r in narrowed] == ["bob"]

    paged = (await admin.get(f"{_ADMIN_A}?limit=1&offset=0")).json()
    assert len(paged) == 1
    assert (await admin.get(f"{_ADMIN_A}?limit=0")).status_code == 400

    one = await admin.get(f"{_ADMIN_A}/{ids['alice']}")
    assert one.status_code == 200
    assert one.json()["owner_sub"] == "alice"
    await admin.aclose()


@pytest.mark.asyncio
async def test_a_row_in_another_tenant_is_never_returned(schema) -> None:
    ids = await _seed(schema)
    admin = _client(schema, user=_user("root", roles=["admin"]))
    rows = (await admin.get(_ADMIN_A)).json()
    assert "carol" not in {r["owner_sub"] for r in rows}
    assert (await admin.get(f"{_ADMIN_A}/{ids['carol']}")).status_code == 404
    await admin.aclose()


@pytest.mark.asyncio
async def test_a_non_admin_forwarded_user_gets_403(schema) -> None:
    ids = await _seed(schema)
    user = _client(schema, user=_user("alice", roles=["editor"]))
    assert (await user.get(_ADMIN_A)).status_code == 403
    assert (await user.get(f"{_ADMIN_A}/{ids['alice']}")).status_code == 403
    await user.aclose()


@pytest.mark.asyncio
async def test_a_service_call_with_no_forwarded_user_is_refused(schema) -> None:
    await _seed(schema)
    anon = _client(schema, user=None)
    response = await anon.get(_ADMIN_A)
    assert response.status_code in (401, 403)
    await anon.aclose()


@pytest.mark.asyncio
async def test_plugin_a_cannot_read_plugin_bs_table(schema) -> None:
    admin = _client(schema, user=_user("root", roles=["admin"]), plugin="adminreada")
    assert (await admin.get(f"/api/v1/internal/owner-data-admin/{_B_TABLE}")).status_code == 404
    await admin.aclose()


@pytest.mark.asyncio
async def test_no_write_verbs_are_mounted(schema) -> None:
    admin = _client(schema, user=_user("root", roles=["admin"]))
    assert (await admin.post(_ADMIN_A, json={"label": "x"})).status_code == 405
    await admin.aclose()
