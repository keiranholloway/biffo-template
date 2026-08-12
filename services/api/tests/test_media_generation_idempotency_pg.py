"""The media-generation idempotency constraint, against REAL Postgres (#1515).

Why this file exists as well as the sqlite tests: **the guarantee is a property of
the deployed database, and sqlite is not it.** Three of the things asserted below
are dialect-specific by nature —

* whether a unique index permits many rows with a NULL key,
* whether an expression index over ``coalesce(caller_plugin, '')`` is accepted at
  all,
* whether the Alembic migration actually produces that index on the engine
  production runs,

— so a constraint proven only under sqlite proves nothing about what protects a
real ledger. Postgres also gives genuine write concurrency, which sqlite cannot:
it serialises writers internally, so the race test in
``test_media_generation_idempotency.py`` shows "one of N wins" without ever having
two transactions in flight at once. Here they really are.

The naming matters: `scripts/verify.sh`'s `pg_test_run` selects this lane on the
``test_*_pg.py`` filename suffix. Get a database with
``eval "$(sh scripts/pg-test-db.sh --export)"``.

## Two fixtures, deliberately

``lane_dsn`` reads the shared lane database, which `pg-test-db.sh` builds by
running ``alembic upgrade head``. That is what makes
``test_migration_creates_a_unique_expression_index`` meaningful: it inspects the
schema **the migration produced**, not one this test built, so it fails if 0019 is
wrong even though every behavioural test below would still pass off the ORM
metadata.

``schema`` builds the table from ORM metadata inside a throwaway Postgres schema
private to this run, so the behavioural tests neither depend on the lane
database's migration state nor leave ledger rows in a database reused across
sessions.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from api.media_generations import record_generation
from api.models.base import Base
from api.models.media_generation import MediaGeneration
from sqlalchemy import Table, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

TENANT = "default"
OTHER_TENANT = "acme"
PLUGIN = "marketing"


def _pg_dsn() -> str | None:
    # Both names, deliberately: `scripts/pg-test-db.sh --export` sets both
    # (tabsii-platform#755), and different consumers read one or the other.
    return os.environ.get("BIFFO_TEST_PG_DSN") or os.environ.get("TABSII_TEST_PG_DSN")


pytestmark = pytest.mark.skipif(
    _pg_dsn() is None,
    reason='no real Postgres DSN -- eval "$(sh scripts/pg-test-db.sh --export)"',
)

# Deliberately NOT marked `serial`. Every test here works inside a schema whose
# name carries a fresh uuid4 fragment, so two workers cannot collide on an object
# name, and the one test that reads shared state only ever reads. Marking it
# serial would cost the lane wall-clock for no isolation it does not already have.


@pytest_asyncio.fixture
async def schema() -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    """``media_generations`` in a throwaway Postgres schema, from ORM metadata."""
    dsn = _pg_dsn()
    assert dsn is not None  # narrows for pyright; skipif already checked
    name = f"mgidem_{uuid.uuid4().hex[:10]}"

    table = MediaGeneration.__table__
    assert isinstance(table, Table)  # narrows for pyright; declarative always is

    engine = create_async_engine(dsn)
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{name}"'))
        await conn.execute(text(f'SET search_path TO "{name}"'))
        await conn.run_sync(Base.metadata.create_all, tables=[table], checkfirst=False)
    await engine.dispose()

    # A fresh engine pinned to the schema, so every session below resolves the
    # unqualified table name to this run's copy.
    scoped = create_async_engine(dsn, connect_args={"server_settings": {"search_path": name}})
    yield async_sessionmaker(scoped, expire_on_commit=False)
    await scoped.dispose()

    cleanup = create_async_engine(dsn)
    async with cleanup.begin() as conn:
        await conn.execute(text(f'DROP SCHEMA "{name}" CASCADE'))
    await cleanup.dispose()


async def _record(
    factory: async_sessionmaker[AsyncSession],
    *,
    key: str | None,
    tenant_id: str = TENANT,
    caller_plugin: str | None = PLUGIN,
    cost_usd: float | None = 0.04,
) -> tuple[str, bool]:
    async with factory() as session:
        row, created = await record_generation(
            session,
            tenant_id=tenant_id,
            caller_plugin=caller_plugin,
            media_kind="image",
            provider="openai",
            model="gpt-image-1",
            units=1,
            unit_kind="image",
            cost_usd=cost_usd,
            client_request_id=key,
        )
        await session.commit()
        return row.id, created


async def _count(factory: async_sessionmaker[AsyncSession]) -> int:
    async with factory() as session:
        return int(await session.scalar(select(func.count()).select_from(MediaGeneration)) or 0)


# --- the migration, on the engine production runs --------------------------


@pytest.mark.asyncio
async def test_migration_creates_a_unique_expression_index() -> None:
    """0019's index exists on a database built by ``alembic upgrade head``.

    Every other test in this file builds its table from ORM metadata, so all of
    them would still pass if the migration were wrong — and a migration that does
    not run is exactly how a constraint reaches production absent. This one
    inspects what Alembic actually produced.
    """
    dsn = _pg_dsn()
    assert dsn is not None
    engine = create_async_engine(dsn)
    try:
        async with engine.connect() as conn:
            indexdef = await conn.scalar(
                text(
                    "SELECT indexdef FROM pg_indexes"
                    " WHERE tablename = 'media_generations'"
                    "   AND indexname = 'uq_media_generation_client_request'"
                )
            )
            columns = await conn.scalars(
                text(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_name = 'media_generations'"
                )
            )
    finally:
        await engine.dispose()

    assert "client_request_id" in set(columns.all()), "0019 did not add the column"
    assert indexdef is not None, (
        "0019's unique index is absent from a database built by alembic upgrade head"
    )
    assert "UNIQUE INDEX" in indexdef, indexdef
    # The COALESCE is the whole point: without it a NULL caller_plugin exempts the
    # row and the constraint silently does not apply. Asserted textually because
    # that is the only place the expression survives into the catalogue.
    assert "COALESCE" in indexdef.upper(), indexdef
    assert "client_request_id" in indexdef, indexdef


# --- the guarantee ---------------------------------------------------------


@pytest.mark.asyncio
async def test_a_repeat_post_returns_the_existing_row(schema) -> None:
    """The issue's ask. A retry gets the same row id and writes nothing new."""
    first_id, first_created = await _record(schema, key="render-7")
    second_id, second_created = await _record(schema, key="render-7")

    assert first_created is True
    assert second_created is False
    assert second_id == first_id
    assert await _count(schema) == 1


@pytest.mark.asyncio
async def test_concurrent_retries_produce_one_row(schema) -> None:
    """The race a pre-check cannot win, with real concurrent transactions.

    Five overlapping retries of the same charge. A check-then-act implementation
    passes every sequential test in this file and writes five rows here.
    """
    results = await asyncio.gather(*(_record(schema, key="render-race") for _ in range(5)))

    assert len({row_id for row_id, _ in results}) == 1, results
    assert sum(created for _, created in results) == 1, "exactly one writer may win"
    assert await _count(schema) == 1


@pytest.mark.asyncio
async def test_the_constraint_still_applies_when_caller_plugin_is_null(schema) -> None:
    """The reason the index is on ``coalesce(caller_plugin, '')``.

    Issue #1515 suggests uniqueness on ``(tenant_id, caller_plugin,
    client_request_id)``. Postgres does not constrain a row whose index tuple
    contains a NULL, so with the column named directly this test writes two rows
    — the guarantee absent for exactly the caller class ``caller_plugin`` is
    nullable to represent, and absent silently.
    """
    first_id, first_created = await _record(schema, key="render-9", caller_plugin=None)
    second_id, second_created = await _record(schema, key="render-9", caller_plugin=None)

    assert first_created is True
    assert second_created is False, "a NULL caller_plugin must not exempt the row"
    assert second_id == first_id
    assert await _count(schema) == 1


@pytest.mark.asyncio
async def test_many_rows_may_carry_no_key(schema) -> None:
    """Backward compatibility, and the reason a partial index is unnecessary.

    Every caller today sends no key, and two genuinely separate charges routinely
    look alike. Collapsing them would silently lose revenue.
    """
    first_id, first_created = await _record(schema, key=None)
    second_id, second_created = await _record(schema, key=None)

    assert first_created is second_created is True
    assert first_id != second_id
    assert await _count(schema) == 2


@pytest.mark.asyncio
async def test_two_callers_may_use_the_same_key(schema) -> None:
    """Why the caller is in the constraint at all.

    Keys are caller-derived, so two plugins can pick the same string. Handing one
    plugin's row to another would misattribute a charge *and* silently drop the
    second one — a lost charge dressed as a successful retry.
    """
    mine, mine_created = await _record(schema, key="shared", caller_plugin="marketing")
    theirs, theirs_created = await _record(schema, key="shared", caller_plugin="ideation")

    assert mine_created is theirs_created is True
    assert mine != theirs
    assert await _count(schema) == 2


@pytest.mark.asyncio
async def test_two_tenants_may_use_the_same_key(schema) -> None:
    """ADR-0001 applies here as everywhere. Handing one tenant another's row
    would be a cross-tenant read, not merely a lost write."""
    mine, mine_created = await _record(schema, key="shared", tenant_id=TENANT)
    theirs, theirs_created = await _record(schema, key="shared", tenant_id=OTHER_TENANT)

    assert mine_created is theirs_created is True
    assert mine != theirs
    assert await _count(schema) == 2


@pytest.mark.asyncio
async def test_different_keys_are_different_rows(schema) -> None:
    """Guards the guard: a bug that collapsed *everything* keyed would pass the
    first two tests in this file."""
    a_id, _ = await _record(schema, key="render-1")
    b_id, _ = await _record(schema, key="render-2")

    assert a_id != b_id
    assert await _count(schema) == 2
