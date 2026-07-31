"""Owner-scoped service data access (ADR-0017 §5).

Covers the manifest opt-in (owner_scoped_service) and the security properties of
the mounted routes: dual auth (service principal + forwarded founder, now one
`Principal` — #621), owner scoping taken from the token and never the request,
cross-owner isolation, and the allowed-principals gate.
"""

from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncGenerator

import pytest
from api.database import get_db  # noqa: E402  (grouped with app deps)
from api.middleware.auth import AuthenticatedUser
from api.middleware.principal import Principal, require_principal
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.plugin_table import PluginTableDefinition
from api.routing.owner_data_router import build_owner_data_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_TABLE = "phase5_widgets"
_MANIFEST = {
    "name": "demo",
    "tables": [
        {
            "name": _TABLE,
            "columns": [
                {"name": "owner_sub", "type": "String(64)", "nullable": False},
                {"name": "label", "type": "String(200)", "nullable": True},
                {"name": "session_id", "type": "String(36)", "nullable": True},
            ],
            "permissions": {},  # closed to tenant CRUD
            "owner_scoped_service": {
                "owner_column": "owner_sub",
                "allowed_principals": ["system:demo"],
            },
        }
    ],
}

# ARNs whose derived logical name is system:<plugin> (compute-module convention).
_DEMO_ARN = "arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-demo-role/s"
_OTHER_ARN = "arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-other-role/s"


# ── manifest opt-in validation ──────────────────────────────────────────────────
# _ensure_auto_columns mutates the input dict, so every use gets a fresh deep copy.


def _table(**owner_scoped_service_overrides: object) -> dict:
    table = copy.deepcopy(_MANIFEST["tables"][0])
    if owner_scoped_service_overrides:
        table["owner_scoped_service"] = owner_scoped_service_overrides
    return table


def test_owner_scoped_service_parses():
    table = PluginTableDefinition.model_validate(_table())
    assert table.owner_scoped_service is not None
    assert table.owner_scoped_service.owner_column == "owner_sub"


def test_owner_column_must_be_a_declared_non_auto_column():
    with pytest.raises(ValidationError):
        PluginTableDefinition.model_validate(
            _table(owner_column="nope", allowed_principals=["system:demo"])
        )
    with pytest.raises(ValidationError):
        PluginTableDefinition.model_validate(
            _table(owner_column="tenant_id", allowed_principals=["system:demo"])
        )


def test_allowed_principals_must_be_non_empty_system_names():
    for principals in ([], ["demo"], [""]):
        with pytest.raises(ValidationError):
            PluginTableDefinition.model_validate(
                _table(owner_column="owner_sub", allowed_principals=principals)
            )


# ── the mounted routes ──────────────────────────────────────────────────────────


def _founder(sub: str) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub=sub, email=f"{sub}@x.com", username=sub, tenant_id="default", roles=[], user_id=None
    )


class _Harness:
    def __init__(self):
        # Building the router creates the dynamic model on Base.metadata. Deep-copy
        # because parsing mutates the manifest (auto-columns).
        self.router = build_owner_data_router(manifests=[copy.deepcopy(_MANIFEST)])
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )

        async def _create() -> None:
            async with self.engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

        asyncio.run(_create())
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    def client(self, *, founder: AuthenticatedUser, principal_arn: str = _DEMO_ARN) -> TestClient:
        async def override_get_db() -> AsyncGenerator[AsyncSession]:
            async with self.session_factory() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise

        app = FastAPI()
        app.include_router(self.router, prefix="/api/v1")
        app.dependency_overrides[get_db] = override_get_db
        # The route resolves both facets through require_signed_principal; these
        # two overrides stand in for its halves — the verified user, and the
        # SigV4 service that carried the request.
        app.dependency_overrides[require_principal] = lambda: Principal(user=founder)
        app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
            principal_arn=principal_arn
        )
        return TestClient(app)

    def dispose(self):
        asyncio.run(self.engine.dispose())


@pytest.fixture
def harness():
    h = _Harness()
    yield h
    h.dispose()


_BASE = f"/api/v1/internal/owner-data/{_TABLE}"


def test_create_then_read_round_trips_owner_scoped(harness):
    client = harness.client(founder=_founder("alice"))

    created = client.post(_BASE, json={"label": "my widget", "session_id": "s1"})
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["owner_sub"] == "alice"  # owner set from the token
    assert row["label"] == "my widget"

    fetched = client.get(f"{_BASE}/{row['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["label"] == "my widget"


def test_the_owner_column_cannot_be_set_from_the_body(harness):
    client = harness.client(founder=_founder("alice"))
    # Try to create a row owned by someone else — the body owner_sub is ignored.
    created = client.post(_BASE, json={"owner_sub": "mallory", "label": "x"})
    assert created.status_code == 201
    assert created.json()["owner_sub"] == "alice"  # the token wins, not the body


def test_another_founders_row_is_invisible(harness):
    alice = harness.client(founder=_founder("alice"))
    created = alice.post(_BASE, json={"label": "alice's"}).json()

    bob = harness.client(founder=_founder("bob"))
    # Bob cannot read Alice's row by id...
    assert bob.get(f"{_BASE}/{created['id']}").status_code == 404
    # ...and it does not appear in Bob's list.
    assert bob.get(_BASE).json() == []
    # Alice still sees exactly her row.
    assert [r["id"] for r in alice.get(_BASE).json()] == [created["id"]]


def test_a_query_filter_cannot_relax_the_owner_scope(harness):
    alice = harness.client(founder=_founder("alice"))
    alice.post(_BASE, json={"label": "alice's", "session_id": "s1"})
    bob = harness.client(founder=_founder("bob"))
    bob.post(_BASE, json={"label": "bob's", "session_id": "s1"})

    # Bob filters by session_id AND tries to widen owner via the query — still only his.
    rows = bob.get(f"{_BASE}?session_id=s1&owner_sub=alice").json()
    assert [r["label"] for r in rows] == ["bob's"]


def test_update_is_owner_scoped_and_cannot_re_own(harness):
    alice = harness.client(founder=_founder("alice"))
    row = alice.post(_BASE, json={"label": "v1"}).json()

    # Bob cannot update Alice's row.
    assert (
        alice
        and harness.client(founder=_founder("bob"))
        .patch(f"{_BASE}/{row['id']}", json={"label": "hacked"})
        .status_code
        == 404
    )

    # Alice can, but cannot change the owner.
    updated = alice.patch(f"{_BASE}/{row['id']}", json={"label": "v2", "owner_sub": "mallory"})
    assert updated.status_code == 200
    assert updated.json()["label"] == "v2"
    assert updated.json()["owner_sub"] == "alice"


def test_a_principal_the_table_did_not_name_gets_404(harness):
    client = harness.client(founder=_founder("alice"), principal_arn=_OTHER_ARN)
    # system:other is not in allowed_principals -> indistinguishable from missing.
    assert client.post(_BASE, json={"label": "x"}).status_code == 404
    assert client.get(_BASE).status_code == 404
