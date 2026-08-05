"""Query-parameter filtering on the generic CRUD list route (tabsii-crm#239).

`make_list_handler` used to take no `Request` and no query parameters at all,
so **any** query string sent to `/api/v1/data/<table>` was accepted over HTTP by
FastAPI and then discarded: `?brand_id=X` narrowed nothing and the caller got a
200 with every brand's rows. Tenant scoping was never bypassed — the rows
returned were all rows the caller was authorised to see — which is exactly what
made it invisible. A caller whose grant spans one scope cannot tell, because for
them the unfiltered answer and the filtered answer are the same set. A caller
whose grant spans several got the wrong answer with a 200.

These tests prove the **contract**: which parameters narrow, and which are
refused and how. The rejection and coercion rules under test are shared with the
owner-scoped list route (`test_owner_data.py::TestOwnerListFilters`) rather than
duplicated, and `test_list_filter_guard.py` is what keeps a third list handler
from inventing its own.

The fixture pattern (FastAPI + StaticPool + in-memory SQLite, commit-on-success
`get_db` override) is `test_core_crud_router.py`'s, deliberately — a second
spelling of that harness would be one more thing to keep in step.
"""

import asyncio
import uuid
from collections.abc import AsyncGenerator, Generator
from datetime import datetime

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.middleware.principal import Principal, require_principal
from api.models.base import Base, TenantScopedModel
from api.routing.core_crud_router import build_core_crud_router
from api.routing.crud_handlers import (
    _coerce_user_field,
    build_list_query,
    filterable_columns,
)
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import Date, DateTime, Integer, String, Text, Uuid
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.pool import StaticPool


class Widget(TenantScopedModel):
    """Throwaway core table shaped like a real scoped one: two UUID scope
    columns, a string `_id` that is not a UUID, two non-`_id` user columns, an
    Integer this layer deliberately will not filter on, and a soft-delete
    marker. A distinctive tablename avoids colliding with anything already
    registered on `Base.metadata`."""

    __tablename__ = "test_filter_widgets"

    brand_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    region_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    # A `_id` column that is deliberately NOT a UUID — it must filter as a plain
    # string, which is what proves the rule is about type and not about names.
    provider_reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # A real user column whose type this layer will NOT filter on: a query
    # string reaching the driver as an Integer column's value surfaces as a 500
    # rather than a 400. Rejection is by TYPE, so this is what proves it.
    qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __crud_permissions__ = {"list": {"allowed": True}}
    __emit_events__ = False


_BASE = "/api/v1/data/test_filter_widgets"

BRAND_A = uuid.UUID("aa010000-0000-0000-0000-00000000000a")
BRAND_B = uuid.UUID("aa010000-0000-0000-0000-00000000000b")
REGION_1 = uuid.UUID("aa020000-0000-0000-0000-00000000000a")
REGION_2 = uuid.UUID("aa020000-0000-0000-0000-00000000000b")


def _caller() -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="widget-sub",
        email="widget@example.com",
        username="widget",
        tenant_id="default",
        roles=["admin"],
    )


@pytest.fixture
def widget_app() -> Generator[FastAPI]:
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

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def _seed() -> None:
        async with session_factory() as session:
            session.add_all(
                [
                    Widget(
                        tenant_id="default",
                        brand_id=BRAND_A,
                        region_id=REGION_1,
                        provider_reference_id="ref-a1",
                        status="open",
                        notes="alpha",
                        qty=1,
                    ),
                    Widget(
                        tenant_id="default",
                        brand_id=BRAND_A,
                        region_id=REGION_2,
                        provider_reference_id="ref-a2",
                        status="closed",
                        notes="beta",
                        qty=2,
                    ),
                    Widget(
                        tenant_id="default",
                        brand_id=BRAND_B,
                        region_id=REGION_1,
                        provider_reference_id="ref-b1",
                        status="open",
                        notes="gamma",
                        qty=3,
                    ),
                    # Another tenant's row, so "no filter" cannot accidentally
                    # pass by returning literally every row in the table.
                    Widget(
                        tenant_id="other",
                        brand_id=BRAND_A,
                        provider_reference_id="ref-other",
                        status="open",
                    ),
                ]
            )
            await session.commit()

    asyncio.run(_seed())

    app = FastAPI()
    app.include_router(build_core_crud_router([Widget]), prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: _caller()
    app.dependency_overrides[require_principal] = lambda: Principal(user=_caller())

    yield app

    asyncio.run(engine.dispose())


@pytest.fixture
def client(widget_app: FastAPI) -> TestClient:
    return TestClient(widget_app)


def _refs(response) -> set[str]:
    return {row["provider_reference_id"] for row in response.json()}


class TestFilterableColumnDerivation:
    """The allowed set comes from the model's own columns. Nothing here names a
    column literal that the rule did not derive."""

    def test_scope_columns_are_filterable(self):
        assert {"brand_id", "region_id"} <= filterable_columns(Widget)

    def test_a_string_id_column_is_filterable_too(self):
        # A `_id` column that is String rather than Uuid. Both types are
        # filterable, and the value is passed through rather than coerced.
        assert "provider_reference_id" in filterable_columns(Widget)

    def test_text_columns_are_filterable_and_uncoercible_types_are_not(self):
        """Rejection is by column TYPE, not by an `_id` naming convention.

        `status`/`notes` are text and filter fine; `qty` is an Integer, which
        would reach the driver as a string and 500, so it stays rejected.
        """
        allowed = filterable_columns(Widget)
        assert "status" in allowed
        assert "notes" in allowed
        assert "qty" not in allowed

    def test_auto_managed_columns_are_never_filterable(self):
        """`tenant_id` is the overlap that matters: it ends in `_id` but always
        comes from the tenant-context dependency, never the caller. `id` is
        addressed by the read route, and `deleted_at` is the tombstone the list
        already pins to NULL."""
        allowed = filterable_columns(Widget)
        assert "tenant_id" not in allowed
        assert "id" not in allowed
        assert "created_at" not in allowed
        assert "updated_at" not in allowed
        assert "deleted_at" not in allowed


class TestFiltersNarrow:
    def test_no_filter_returns_every_row_in_the_tenant(self, client: TestClient):
        response = client.get(_BASE)
        assert response.status_code == 200
        assert _refs(response) == {"ref-a1", "ref-a2", "ref-b1"}

    def test_brand_filter_returns_only_that_brand(self, client: TestClient):
        response = client.get(_BASE, params={"brand_id": str(BRAND_A)})
        assert response.status_code == 200
        assert _refs(response) == {"ref-a1", "ref-a2"}

    def test_the_other_brand_is_the_mirror_case(self, client: TestClient):
        """A filter that returned nothing at all would pass the test above only
        if that test asserted emptiness. It asserts a specific non-empty set,
        and this asserts the complementary one — so "narrows correctly" and
        "denies everything" cannot both pass."""
        response = client.get(_BASE, params={"brand_id": str(BRAND_B)})
        assert response.status_code == 200
        assert _refs(response) == {"ref-b1"}

    def test_two_filters_are_anded(self, client: TestClient):
        response = client.get(_BASE, params={"brand_id": str(BRAND_A), "region_id": str(REGION_1)})
        assert response.status_code == 200
        assert _refs(response) == {"ref-a1"}

    def test_a_text_filter_actually_narrows(self, client: TestClient):
        """The half most easily forgotten: a filter this layer accepts must
        really be applied. Accepting a filter and dropping it is the original
        defect wearing a different hat."""
        response = client.get(_BASE, params={"status": "open"})
        assert response.status_code == 200
        assert _refs(response) == {"ref-a1", "ref-b1"}

    def test_a_string_id_column_filters_without_coercion(self, client: TestClient):
        response = client.get(_BASE, params={"provider_reference_id": "ref-b1"})
        assert response.status_code == 200
        assert _refs(response) == {"ref-b1"}

    def test_a_filter_matching_nothing_returns_an_empty_list(self, client: TestClient):
        response = client.get(_BASE, params={"brand_id": str(uuid.uuid4())})
        assert response.status_code == 200
        assert response.json() == []

    def test_a_filter_cannot_reach_another_tenants_row(self, client: TestClient):
        """Filters only ever AND onto the tenant-scoped SELECT. The seeded
        `other` tenant row matches this brand and must still not appear."""
        response = client.get(_BASE, params={"brand_id": str(BRAND_A)})
        assert "ref-other" not in _refs(response)


class TestRejection:
    """Silently ignoring a filter is the defect. Every parameter the handler
    cannot honour is a 400 that names it."""

    def test_unknown_parameter_is_rejected(self, client: TestClient):
        response = client.get(_BASE, params={"nonsense": "1"})
        assert response.status_code == 400
        assert "nonsense" in response.json()["detail"]

    def test_the_rejection_names_what_is_supported(self, client: TestClient):
        """A caller who cannot tell which parameters work is back where they
        started — the message has to be actionable, not merely loud."""
        detail = client.get(_BASE, params={"nonsense": "1"}).json()["detail"]
        assert "brand_id" in detail
        assert "region_id" in detail

    def test_a_column_of_an_unsupported_type_is_rejected_rather_than_ignored(
        self, client: TestClient
    ):
        """`qty` is a real column on this table and still not a filter, because
        its type cannot be compared against a raw query string. The important
        half is that it does not quietly return every qty."""
        response = client.get(_BASE, params={"qty": "3"})
        assert response.status_code == 400
        assert "qty" in response.json()["detail"]

    def test_tenant_id_cannot_be_supplied_by_the_caller(self, client: TestClient):
        """It ends in `_id`, so it has to be excluded deliberately — otherwise a
        caller could name the one column that is supposed to come from the
        tenant-context dependency."""
        response = client.get(_BASE, params={"tenant_id": "other"})
        assert response.status_code == 400
        assert "tenant_id" in response.json()["detail"]

    def test_every_unknown_parameter_is_named_at_once(self, client: TestClient):
        detail = client.get(_BASE, params={"foo": "1", "bar": "2"}).json()["detail"]
        assert "foo" in detail
        assert "bar" in detail

    def test_a_repeated_parameter_is_rejected(self, client: TestClient):
        """Last-wins would be a silent choice between two things the caller
        asked for — the same class of defect this change exists to remove."""
        response = client.get(
            _BASE, params=[("brand_id", str(BRAND_A)), ("brand_id", str(BRAND_B))]
        )
        assert response.status_code == 400
        assert "brand_id" in response.json()["detail"]


class TestValueValidation:
    def test_a_non_uuid_for_a_uuid_column_is_a_400_not_a_500(self, client: TestClient):
        """Reaching the driver with an unparseable bind is a 500, which reads to
        a caller as "the server is broken" rather than "your input is wrong"."""
        response = client.get(_BASE, params={"brand_id": "not-a-uuid"})
        assert response.status_code == 400
        assert "brand_id" in response.json()["detail"]

    def test_an_empty_value_for_a_uuid_column_is_a_400(self, client: TestClient):
        response = client.get(_BASE, params={"brand_id": ""})
        assert response.status_code == 400

    def test_the_500_the_coercion_prevents_is_real_and_not_a_story(self):
        """The counterfactual behind the test name above.

        "400 not 500" is a claim about what would happen *without*
        `_coerce_user_field`, and a test asserting the 400 cannot show it. So
        bind the raw string the way an uncoerced filter would and watch it
        raise: SQLAlchemy's `Uuid` bind processor calls `.hex` on the value, so
        an unconverted `str` blows up at execute — which FastAPI surfaces as a
        500, "the server is broken", for what is plainly bad input.

        This is a property of the type's bind processor rather than of any
        driver, so it holds on SQLite here and on asyncpg in an instance. The
        `DateTime` branch deliberately gets no equivalent test: SQLite compares
        that column against a raw string quite happily, so the same
        counterfactual is not reproducible in this lane and is not asserted.
        """
        from sqlalchemy import select as _select
        from sqlalchemy.exc import StatementError

        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )

        async def _probe() -> None:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            async with async_sessionmaker(engine)() as session:
                with pytest.raises(StatementError):
                    await session.execute(_select(Widget).where(Widget.brand_id == "not-a-uuid"))

        try:
            asyncio.run(_probe())
        finally:
            asyncio.run(engine.dispose())


class TestBuildListQueryDirectly:
    """`build_list_query` is a pure builder with no session access — which is
    what lets an instance's real-Postgres lane execute it on an RLS-bound
    connection."""

    def test_unknown_parameter_raises_before_any_database_access(self):
        with pytest.raises(HTTPException) as exc:
            build_list_query(Widget, "default", [("nope", "1")])
        assert exc.value.status_code == 400
        assert "nope" in str(exc.value.detail)

    def test_a_table_with_no_filterable_columns_says_so(self):
        """The empty-set branch has its own message; without it the caller is
        told the endpoint filters on nothing at all in a sentence listing
        nothing, which reads as a bug."""
        with pytest.raises(HTTPException) as exc:
            build_list_query(
                Widget, "default", [("brand_id", str(BRAND_A))], filterable=frozenset()
            )
        assert "accepts no filters" in str(exc.value.detail)

    def test_no_parameters_builds_the_unfiltered_tenant_query(self):
        compiled = str(build_list_query(Widget, "default", []))
        assert "tenant_id" in compiled
        # Soft-delete exclusion is preserved — it was there before this change
        # and a filter must not be able to resurrect tombstoned rows.
        assert "deleted_at IS NULL" in compiled

    def test_a_filter_does_not_displace_the_scoping_predicates(self):
        compiled = str(build_list_query(Widget, "default", [("brand_id", str(BRAND_A))]))
        assert "tenant_id" in compiled
        assert "deleted_at IS NULL" in compiled
        assert "brand_id" in compiled


class TestCoercionRejectsMalformedValuesForEveryTypedColumn:
    """`_coerce_user_field`'s three `except ValueError` branches, exercised directly.

    The error-branch coverage guard caught one of these shipping unexercised, and
    it was right to: an unexecuted error branch is one nobody has observed. The
    route-level tests reach the `Uuid` branch, but `DateTime` and `Date` are not
    reachable through the fixture table, so asserting them through a request
    would have meant inventing columns to carry them. Calling the function is
    the honest way to cover a pure coercion helper.
    """

    @staticmethod
    def _model_with(column_type):
        from sqlalchemy import Column, MetaData, Table
        from sqlalchemy.orm import DeclarativeBase

        class _Base(DeclarativeBase):
            metadata = MetaData()

        table = Table(
            "coercion_probe",
            _Base.metadata,
            Column("id", Uuid, primary_key=True),
            Column("probe", column_type),
        )

        class _Probe:
            __table__ = table

        return _Probe

    @pytest.mark.parametrize(
        ("column_type", "bad_value", "expected_detail"),
        [
            (Uuid, "not-a-uuid", "probe is not a valid UUID"),
            (DateTime, "not-a-datetime", "probe is not a valid datetime"),
            (Date, "not-a-date", "probe is not a valid date"),
        ],
    )
    def test_a_malformed_value_is_a_400_naming_the_parameter(
        self, column_type, bad_value, expected_detail
    ):
        model = self._model_with(column_type)
        with pytest.raises(HTTPException) as exc:
            _coerce_user_field(model, "probe", bad_value)
        assert exc.value.status_code == 400
        assert expected_detail in str(exc.value.detail)

    @pytest.mark.parametrize(
        ("column_type", "good_value"),
        [
            (Uuid, "00000000-0000-0000-0000-00000000000a"),
            (DateTime, "2026-08-05T12:00:00Z"),
            (Date, "2026-08-05"),
        ],
    )
    def test_a_well_formed_value_is_converted_rather_than_rejected(self, column_type, good_value):
        """The mirror case. Without it, a coercion that rejected *everything*
        would satisfy the tests above."""
        model = self._model_with(column_type)
        assert _coerce_user_field(model, "probe", good_value) != good_value
