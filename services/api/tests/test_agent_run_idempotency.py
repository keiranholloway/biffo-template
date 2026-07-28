"""Agent-run creation is create-or-get when given a key (issue #661).

The router tests drive creation over HTTP, but **sequentially** — and a
check-then-act ("does a run for this agent already exist in the chain? no? then
create one") passes every one of them. It only fails when two creators overlap,
which is exactly the case that costs money: both list the chain, both see no
follow-on, and both create one.

That is not hypothetical. `agent_fan_in` carries precisely that check-then-act,
and it double-fired twice in one day on a live deployment:

- once **visibly** — both duplicate synthesis runs stranded in `pending`, and the
  founder's scout hung on "Running" for 255 minutes;
- once **invisibly** — both completed, the plugin recorded one `synthesis_run_id`
  and discarded the other result, and the tenant was billed twice for the most
  expensive step in the pipeline. This is the common case, and it looks exactly
  like success.

So this module tests the property the sequential tests cannot: that the winner is
decided by a unique index and an `IntegrityError`, not by anything read
beforehand.

**On the database.** File-backed SQLite, so each session gets its own connection
and its own transaction — the in-memory `StaticPool` fixture used elsewhere
shares one connection and cannot express two concurrent writers at all. SQLite
serialises writes internally, so this is not true parallelism; what it proves is
that of N creators exactly one inserts and the losers are handed the winner's
row, on a real database with real transactions. The production guarantee rests on
the uniqueness being enforced by the index rather than by application code, which
is asserted directly below.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from api.agent_runs import create_run
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table
from api.models.base import Base
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

TENANT = "default"
OTHER_TENANT = "acme"
SNAPSHOT = {"instructions": "go", "model": "anthropic/claude-opus-4-8"}


@pytest_asyncio.fixture
async def session_factory(tmp_path: Path) -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'idem.db'}")
    async with engine.begin() as conn:
        # WAL so a reader does not block the writer — otherwise the overlapping
        # creators below deadlock instead of racing.
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _create(
    factory: async_sessionmaker[AsyncSession],
    *,
    key: str | None,
    tenant_id: str = TENANT,
    agent_name: str = "idea-scout-synthesis",
) -> tuple[str, bool]:
    async with factory() as session:
        run, created = await create_run(
            session,
            tenant_id=tenant_id,
            agent_name=agent_name,
            definition_snapshot=SNAPSHOT,
            max_depth=3,
            idempotency_key=key,
        )
        await session.commit()
        return run.id, created


async def _count(factory: async_sessionmaker[AsyncSession]) -> int:
    async with factory() as session:
        rows = await session.scalars(select(AgentRun))
        return len(list(rows.all()))


@pytest.mark.asyncio
async def test_two_overlapping_creators_with_one_key_produce_one_run(session_factory) -> None:
    """The #661 race, reproduced: N creators, one row, one invoice."""
    key = "fan-in:chain-abc:idea-scout-synthesis"

    results = await asyncio.gather(*(_create(session_factory, key=key) for _ in range(5)))

    run_ids = {run_id for run_id, _ in results}
    assert len(run_ids) == 1, f"expected one run, got {run_ids}"
    assert sum(created for _, created in results) == 1, "exactly one creator may win"
    assert await _count(session_factory) == 1


@pytest.mark.asyncio
async def test_the_losers_are_handed_the_winners_run_not_an_error(session_factory) -> None:
    """A loser must be able to carry on. The fan-in has already done the work of
    assembling the payload by this point; failing it would turn a duplicate into
    a retry storm, and retrying is what created the duplicate."""
    key = "fan-in:chain-def:synthesis"

    first_id, first_created = await _create(session_factory, key=key)
    second_id, second_created = await _create(session_factory, key=key)

    assert first_created is True
    assert second_created is False
    assert second_id == first_id


@pytest.mark.asyncio
async def test_without_a_key_nothing_is_collapsed(session_factory) -> None:
    """Most creations have no natural key and must keep the old behaviour —
    two requests are two runs. Collapsing them would silently drop work."""
    first_id, first_created = await _create(session_factory, key=None)
    second_id, second_created = await _create(session_factory, key=None)

    assert first_created is second_created is True
    assert first_id != second_id
    assert await _count(session_factory) == 2


@pytest.mark.asyncio
async def test_different_keys_are_different_runs(session_factory) -> None:
    """Guards the guard: a uniqueness bug that collapsed *everything* would pass
    the first two tests in this module."""
    a_id, _ = await _create(session_factory, key="fan-in:chain-1:synthesis")
    b_id, _ = await _create(session_factory, key="fan-in:chain-2:synthesis")

    assert a_id != b_id
    assert await _count(session_factory) == 2


@pytest.mark.asyncio
async def test_two_tenants_may_use_the_same_key(session_factory) -> None:
    """The index is on (tenant_id, idempotency_key), not the key alone. Two
    tenants running the same workflow generate identical natural keys, and one
    must never be handed the other's run — that would be a cross-tenant read
    (ADR-0001), not merely a lost run."""
    key = "fan-in:chain-shared:synthesis"

    mine, mine_created = await _create(session_factory, key=key, tenant_id=TENANT)
    theirs, theirs_created = await _create(session_factory, key=key, tenant_id=OTHER_TENANT)

    assert mine_created is theirs_created is True
    assert mine != theirs
    assert await _count(session_factory) == 2


@pytest.mark.asyncio
async def test_uniqueness_is_enforced_by_the_database_not_by_a_prior_read(
    session_factory,
) -> None:
    """The whole point. A check-then-act implementation passes every other test
    in this module when run sequentially; it fails only when the read and the
    write are separated by another writer.

    So assert the mechanism directly: the index exists, is unique, and covers
    both columns. Without it `create_run` would never see an IntegrityError and
    would happily insert the second row.
    """
    async with session_factory() as session:
        rows = await session.execute(text("PRAGMA index_list('agent_runs')"))
        indexes = {r[1]: r[2] for r in rows}  # name -> unique flag
        assert indexes.get("uq_agent_run_idempotency") == 1, indexes

        cols = await session.execute(text("PRAGMA index_info('uq_agent_run_idempotency')"))
        assert [r[2] for r in cols] == ["tenant_id", "idempotency_key"]
