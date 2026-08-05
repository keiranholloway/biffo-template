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
                # A column whose type this layer deliberately will NOT filter
                # on: an Integer compared against a raw query string reaches
                # the driver and surfaces as a 500 rather than a 400.
                {"name": "qty", "type": "Integer", "nullable": True},
                # A column that IS filterable but needs its value converted
                # first — the coercion path, on the only non-string filterable
                # type a plugin manifest can currently declare.
                {"name": "starts_at", "type": "DateTime(timezone=True)", "nullable": True},
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
    """Naming the owner column is now a 400 rather than a silent shrug, and the
    owner scope is un-relaxable either way.

    This used to assert a 200 carrying only Bob's row — true, but true of the
    defect as well: the parameter was dropped on the floor by an `if key in
    user_columns` with no `else` (tabsii-platform#665), so a caller could not
    tell the difference between "your filter was applied" and "your filter was
    ignored". `_owned` still ANDs the verified founder on unconditionally, so
    the security property below is unchanged; what changed is that asking for
    someone else's rows now gets an answer instead of a different question's.
    """
    alice = harness.client(founder=_founder("alice"))
    alice.post(_BASE, json={"label": "alice's", "session_id": "s1"})
    bob = harness.client(founder=_founder("bob"))
    bob.post(_BASE, json={"label": "bob's", "session_id": "s1"})

    refused = bob.get(f"{_BASE}?session_id=s1&owner_sub=alice")
    assert refused.status_code == 400
    assert "owner_sub" in refused.json()["detail"]

    # And the filter Bob is allowed to send still returns only Bob's row — the
    # owner predicate is not something a query parameter ever reached.
    rows = bob.get(f"{_BASE}?session_id=s1").json()
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


# ── list filtering (tabsii-platform#665) ────────────────────────────────────────


class TestOwnerListFilters:
    """`make_owner_list_handler` had three defects in four lines: no `else`, so
    an unrecognised parameter was silently ignored and the founder got every row
    they owned with a 200; no value coercion, so a malformed value for a typed
    column reached the driver as a 500; and `.items()` rather than
    `.multi_items()`, so a repeated parameter collapsed to its last occurrence.

    This surface is service-authenticated and `_owned` ANDs the verified founder
    on unconditionally, so none of that was ever a cross-owner leak — it was a
    wrong answer within the founder's own data, plus a 500 on bad input. The
    rejection rules are `crud_handlers.apply_list_filters`, shared with the
    tenant-scoped list route; `test_crud_list_filters.py` covers the same rules
    from the other side, and `test_list_filter_guard.py` stops a third handler
    growing its own.
    """

    @staticmethod
    def _seed(harness):
        alice = harness.client(founder=_founder("alice"))
        alice.post(_BASE, json={"label": "a-one", "session_id": "s1", "qty": 1})
        alice.post(_BASE, json={"label": "a-two", "session_id": "s2", "qty": 2})
        harness.client(founder=_founder("bob")).post(
            _BASE, json={"label": "b-one", "session_id": "s1", "qty": 3}
        )
        return alice

    def test_an_accepted_filter_actually_narrows(self, harness):
        """The half most easily forgotten. Accepting a filter and dropping it is
        the original defect wearing a different hat, and it passes any test that
        only checks the status code."""
        alice = self._seed(harness)
        response = alice.get(f"{_BASE}?session_id=s1")
        assert response.status_code == 200
        assert [r["label"] for r in response.json()] == ["a-one"]

    def test_the_other_value_is_the_mirror_case(self, harness):
        """A filter that returned nothing would pass the test above only if that
        test asserted emptiness. It asserts one row; this asserts the
        complementary one, so "narrows correctly" and "matches nothing" cannot
        both pass."""
        alice = self._seed(harness)
        assert [r["label"] for r in alice.get(f"{_BASE}?session_id=s2").json()] == ["a-two"]

    def test_no_filter_returns_every_row_this_founder_owns(self, harness):
        alice = self._seed(harness)
        assert {r["label"] for r in alice.get(_BASE).json()} == {"a-one", "a-two"}

    def test_an_unknown_parameter_is_a_400_naming_it(self, harness):
        """The defect: `?sesion_id=s1` (a typo) returned every row the founder
        owned, with a 200, and the caller could not tell."""
        alice = self._seed(harness)
        response = alice.get(f"{_BASE}?sesion_id=s1")
        assert response.status_code == 400
        assert "sesion_id" in response.json()["detail"]

    def test_the_rejection_names_what_this_table_supports(self, harness):
        alice = self._seed(harness)
        detail = alice.get(f"{_BASE}?sesion_id=s1").json()["detail"]
        assert "session_id" in detail
        assert "label" in detail

    def test_a_column_of_an_unsupported_type_is_rejected_rather_than_ignored(self, harness):
        """`qty` is a real column on this table and still not a filter, because
        an Integer compared against a raw query string reaches the driver and
        500s. The important half is that it does not quietly return every qty."""
        alice = self._seed(harness)
        response = alice.get(f"{_BASE}?qty=1")
        assert response.status_code == 400
        assert "qty" in response.json()["detail"]
        # ...and specifically not the unfiltered answer with a 200.
        assert response.status_code != 200

    def test_a_repeated_parameter_is_rejected_rather_than_last_wins(self, harness):
        """`.items()` silently kept the last occurrence — a choice between two
        things the caller asked for, made without saying so."""
        alice = self._seed(harness)
        response = alice.get(f"{_BASE}?session_id=s1&session_id=s2")
        assert response.status_code == 400
        assert "session_id" in response.json()["detail"]

    def test_a_malformed_value_for_a_typed_column_is_a_400_not_a_500(self, harness):
        """A value SQLAlchemy's bind processor cannot convert raises at execute
        and surfaces as a 500 — "the server is broken" for what is plainly bad
        input.

        `starts_at` is a DateTime because that is the only non-string filterable
        type a plugin manifest can declare (`plugin_table._TYPE_MAP` has no
        `Uuid`). The Uuid branch of the same coercion is exercised over HTTP by
        `test_crud_list_filters.py`, against a core model that can declare one.
        """
        alice = self._seed(harness)
        response = alice.get(f"{_BASE}?starts_at=not-a-timestamp")
        assert response.status_code == 400
        assert "starts_at" in response.json()["detail"]

    def test_the_owner_column_is_not_a_filter_key(self, harness):
        """Not a security control — `_owned` already fixes the owner — but
        `?owner_sub=someone` can only mean "narrow to a founder I am not", and
        the honest answer is a 400 rather than a 200 for a different question."""
        alice = self._seed(harness)
        response = alice.get(f"{_BASE}?owner_sub=bob")
        assert response.status_code == 400
        assert "owner_sub" in response.json()["detail"]

    def test_a_filter_still_cannot_reach_another_founders_row(self, harness):
        """The scope predicate is not something a query parameter reaches: Bob
        also owns a `session_id=s1` row and it must not appear for Alice."""
        alice = self._seed(harness)
        rows = alice.get(f"{_BASE}?session_id=s1").json()
        assert [r["owner_sub"] for r in rows] == ["alice"]
        assert "b-one" not in {r["label"] for r in rows}
