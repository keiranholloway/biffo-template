"""Pagination on the generic CRUD list route (biffo-template#1016).

`make_list_handler` used to build exactly one query with no `LIMIT`/`OFFSET`
at all, so `GET /api/v1/data/<table>` returned every row in the tenant. That
was safe with a handful of seed rows and a scaling problem the moment a real
table grew past them — independent of, and in this issue's own triage comment
the larger of the two remaining gaps after filtering shipped (#1016).

These tests prove the contract:

* `limit`/`offset` page a **newest-first, stable** ordering — an unordered
  `LIMIT`/`OFFSET` pair is free to return overlapping or skipped rows between
  calls, which would make paging silently lossy.
* Omitting both still bounds the result (`DEFAULT_LIST_LIMIT`), so a caller
  who never asks for pagination cannot accidentally get an unbounded scan.
* Out-of-range values are a 400 naming the parameter, matching this route's
  existing "bad input is a 400" contract for filters (`test_crud_list_filters
  .py::TestRejection`) rather than a generic FastAPI 422.
* `limit`/`offset` compose with the existing equality filters rather than
  replacing them, and tenant scoping still holds under both.
* `limit`/`offset` are reserved query-parameter names: a model cannot declare
  a filterable column that collides with either.

The fixture pattern (FastAPI + StaticPool + in-memory SQLite, commit-on-success
`get_db` override) is `test_crud_list_filters.py`'s, deliberately — a second
spelling of that harness would be one more thing to keep in step.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Generator
from datetime import UTC, datetime, timedelta

import pytest
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.middleware.principal import Principal, require_principal
from api.models.base import Base, TenantScopedModel
from api.routing.core_crud_router import build_core_crud_router
from api.routing.crud_handlers import (
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
    RESERVED_PAGINATION_PARAMS,
    filterable_columns,
    make_create_handler,
    make_list_handler,
    user_columns_from_model,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import String
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.pool import StaticPool


class _PageWidget(TenantScopedModel):
    """A distinctive tablename avoids colliding with anything already
    registered on `Base.metadata` by another test module."""

    __tablename__ = "test_pagination_widgets"

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __crud_permissions__ = {"list": {"allowed": True}}
    __emit_events__ = False


class _ReservedNameWidget(TenantScopedModel):
    """Carries a real, otherwise-filterable `String` column literally named
    `limit` — the case `RESERVED_PAGINATION_PARAMS` exists for."""

    __tablename__ = "test_reserved_name_widgets"

    limit: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __crud_permissions__ = {"list": {"allowed": True}}
    __emit_events__ = False


_BASE = "/api/v1/data/test_pagination_widgets"

_BASE_TIME = datetime(2026, 1, 1, tzinfo=UTC)
# Oldest first here; newest-first is the assertion under test.
_NAMES_OLDEST_FIRST = ["row-0", "row-1", "row-2", "row-3", "row-4"]
_NAMES_NEWEST_FIRST = list(reversed(_NAMES_OLDEST_FIRST))


def _caller() -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="pagination-sub",
        email="pagination@example.com",
        username="pagination",
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
            for i, name in enumerate(_NAMES_OLDEST_FIRST):
                session.add(
                    _PageWidget(
                        tenant_id="default",
                        name=name,
                        status="open" if i % 2 == 0 else "closed",
                        # Strictly increasing, explicit — never rely on
                        # func.now() resolution to order five inserts made in
                        # the same test.
                        created_at=_BASE_TIME + timedelta(seconds=i),
                    )
                )
            # Another tenant's rows, so pagination cannot accidentally widen
            # past tenant scoping — same shape as test_crud_list_filters.py.
            session.add(
                _PageWidget(
                    tenant_id="other",
                    name="other-row",
                    status="open",
                    created_at=_BASE_TIME + timedelta(seconds=100),
                )
            )
            await session.commit()

    asyncio.run(_seed())

    app = FastAPI()
    app.include_router(build_core_crud_router([_PageWidget]), prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_auth] = lambda: _caller()
    app.dependency_overrides[require_principal] = lambda: Principal(user=_caller())

    yield app

    asyncio.run(engine.dispose())


@pytest.fixture
def client(widget_app: FastAPI) -> TestClient:
    return TestClient(widget_app)


def _names(response) -> list[str]:
    return [row["name"] for row in response.json()]


class TestDefaultBehaviour:
    def test_no_params_returns_every_seeded_row_newest_first(self, client: TestClient):
        """Five rows, well under DEFAULT_LIST_LIMIT — the existing "no filter
        returns every row" contract (test_crud_list_filters.py) must still
        hold, now with a defined order rather than an incidental one."""
        response = client.get(_BASE)
        assert response.status_code == 200
        assert _names(response) == _NAMES_NEWEST_FIRST

    def test_default_limit_bounds_a_table_larger_than_it(self):
        """The scaling problem this issue is about: without ever asking for a
        page, a caller must not be able to pull an unbounded scan. Seeds one
        more row than DEFAULT_LIST_LIMIT so "no params" is provably bounded
        rather than coincidentally under the limit — a separate app/engine
        from `widget_app`, which only seeds five rows."""
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

        row_count = DEFAULT_LIST_LIMIT + 1

        async def _seed() -> None:
            async with session_factory() as session:
                for i in range(row_count):
                    session.add(
                        _PageWidget(
                            tenant_id="default",
                            name=f"bulk-{i}",
                            created_at=_BASE_TIME + timedelta(seconds=i),
                        )
                    )
                await session.commit()

        asyncio.run(_seed())

        app = FastAPI()
        app.include_router(build_core_crud_router([_PageWidget]), prefix="/api/v1")
        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[require_auth] = lambda: _caller()
        app.dependency_overrides[require_principal] = lambda: Principal(user=_caller())

        try:
            response = TestClient(app).get(_BASE)
            assert response.status_code == 200
            assert len(response.json()) == DEFAULT_LIST_LIMIT
        finally:
            asyncio.run(engine.dispose())


class TestLimitAndOffsetPage:
    def test_limit_returns_the_newest_n_rows(self, client: TestClient):
        response = client.get(_BASE, params={"limit": 2})
        assert response.status_code == 200
        assert _names(response) == _NAMES_NEWEST_FIRST[:2]

    def test_offset_skips_the_newest_rows(self, client: TestClient):
        response = client.get(_BASE, params={"limit": 2, "offset": 2})
        assert response.status_code == 200
        assert _names(response) == _NAMES_NEWEST_FIRST[2:4]

    def test_pages_tile_the_full_set_with_no_gap_or_overlap(self, client: TestClient):
        """The property that makes LIMIT/OFFSET pagination trustworthy: walking
        every page in order reconstructs the whole ordered set exactly once."""
        seen: list[str] = []
        offset = 0
        page_size = 2
        while True:
            response = client.get(_BASE, params={"limit": page_size, "offset": offset})
            page = _names(response)
            if not page:
                break
            seen.extend(page)
            offset += page_size
        assert seen == _NAMES_NEWEST_FIRST

    def test_offset_past_the_end_is_an_empty_list_not_an_error(self, client: TestClient):
        response = client.get(_BASE, params={"offset": 100})
        assert response.status_code == 200
        assert response.json() == []


class TestPaginationComposesWithFilters:
    def test_a_filter_narrows_before_the_page_is_taken(self, client: TestClient):
        """`status=open` matches row-0, row-2, row-4 (newest first: row-4,
        row-2, row-0). `limit=2` must page *that* narrowed, ordered set — not
        take two rows first and filter afterwards."""
        response = client.get(_BASE, params={"status": "open", "limit": 2})
        assert response.status_code == 200
        assert _names(response) == ["row-4", "row-2"]

    def test_limit_and_offset_are_not_treated_as_unknown_filters(self, client: TestClient):
        """Before this change every query parameter this route did not
        recognise was a 400 (test_crud_list_filters.py::TestRejection).
        `limit`/`offset` must not fall into that bucket."""
        response = client.get(_BASE, params={"limit": 3})
        assert response.status_code == 200


class TestPaginationValidation:
    """Out-of-range values are a 400 naming the parameter — the same contract
    apply_list_filters already gives the filter half of this route."""

    def test_limit_zero_is_rejected(self, client: TestClient):
        response = client.get(_BASE, params={"limit": 0})
        assert response.status_code == 400
        assert "limit" in response.json()["detail"]

    def test_limit_above_the_maximum_is_rejected(self, client: TestClient):
        response = client.get(_BASE, params={"limit": MAX_LIST_LIMIT + 1})
        assert response.status_code == 400
        assert "limit" in response.json()["detail"]

    def test_limit_at_the_maximum_is_accepted(self, client: TestClient):
        response = client.get(_BASE, params={"limit": MAX_LIST_LIMIT})
        assert response.status_code == 200

    def test_negative_offset_is_rejected(self, client: TestClient):
        response = client.get(_BASE, params={"offset": -1})
        assert response.status_code == 400
        assert "offset" in response.json()["detail"]


class TestReservedNames:
    """`limit`/`offset` can never be a model's own filter — the pagination
    reader claims them first, so a model declaring either would otherwise be
    unfilterable on that column with no way to say so."""

    def test_a_column_literally_named_limit_is_never_filterable(self):
        assert "limit" not in filterable_columns(_ReservedNameWidget)

    def test_reserved_names_match_what_filterable_columns_excludes(self):
        assert RESERVED_PAGINATION_PARAMS == {"limit", "offset"}


class TestDirectCallBypassesFastAPI:
    """`make_list_handler`'s handler is also called directly in tests,
    bypassing FastAPI's request parsing entirely (test_crud_soft_delete.py).
    Pagination must not break that path: `limit`/`offset` are plain Python
    defaults, not `fastapi.Query(...)` sentinels, precisely so a direct call
    supplying neither still resolves to real ints rather than a FieldInfo
    object SQLAlchemy's `.limit()` cannot use.
    """

    @pytest.fixture
    async def session(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as s:
            yield s
        await engine.dispose()

    async def test_direct_call_with_no_request_uses_the_default_page(self, session):
        handler = make_create_handler(_PageWidget, user_columns_from_model(_PageWidget))
        for name in _NAMES_OLDEST_FIRST:
            await handler(payload={"name": name}, tenant_id="default", db=session)

        rows = await make_list_handler(_PageWidget)(tenant_id="default", db=session)

        assert len(rows) == len(_NAMES_OLDEST_FIRST)

    async def test_direct_call_can_still_pass_limit_and_offset_explicitly(self, session):
        handler = make_create_handler(_PageWidget, user_columns_from_model(_PageWidget))
        for name in _NAMES_OLDEST_FIRST:
            await handler(payload={"name": name}, tenant_id="default", db=session)

        rows = await make_list_handler(_PageWidget)(
            tenant_id="default", db=session, limit=2, offset=1
        )

        assert len(rows) == 2
