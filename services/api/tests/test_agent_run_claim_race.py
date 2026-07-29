"""The agent-run claim is atomic (ADR-0014 §5, issue #371).

The router tests drive claim over HTTP, but sequentially — and a
**read-then-write** claim (fetch, check ``pending``, assign, flush) passes every
one of them. It only fails when two claimants overlap, which is the case that
costs money: both read ``pending``, both call the provider, and both are billed.

So this module tests the property the sequential tests cannot: that the claim is
decided by a single conditional ``UPDATE ... WHERE status = 'pending'`` and its
``rowcount``, not by anything read beforehand.

**On the database.** These run on file-backed SQLite so each session gets its own
connection and its own transaction — the in-memory ``StaticPool`` fixture used
elsewhere shares one connection, which cannot express two concurrent writers at
all. SQLite still serialises writes internally, so this does not reproduce true
parallelism; what it does prove is that of N claimants exactly one wins and the
losers are *told* they lost, on a real database with real transactions. The
production guarantee rests on the conditional UPDATE being a single statement,
which is asserted directly below.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from api.agent_runs import RunNotClaimableError, claim_run, create_run, get_run
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table
from api.models.base import Base
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

TENANT = "default"


@pytest_asyncio.fixture
async def session_factory(tmp_path: Path) -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'claims.db'}")
    async with engine.begin() as conn:
        # WAL so a reader does not block the writer — otherwise the "both read
        # first" interleaving below deadlocks instead of racing.
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _new_pending_run(factory: async_sessionmaker[AsyncSession]) -> str:
    async with factory() as session:
        run, _ = await create_run(
            session,
            tenant_id=TENANT,
            agent_name="demo-enricher",
            definition_snapshot={"instructions": "go", "model": "anthropic/claude-opus-4-8"},
            max_depth=3,
        )
        await session.commit()
        return run.id


async def test_exactly_one_of_many_concurrent_claimants_wins(session_factory):
    """Five deliveries of the same event; one execution."""
    run_id = await _new_pending_run(session_factory)

    async def attempt() -> bool:
        async with session_factory() as session:
            try:
                claimed = await claim_run(session, tenant_id=TENANT, run_id=run_id)
            except RunNotClaimableError:
                return False
            await session.commit()
            return claimed is not None

    results = await asyncio.gather(*(attempt() for _ in range(5)), return_exceptions=True)

    # No claimant may fail in any way other than losing cleanly: an exception
    # here would be a runtime that neither executes nor knows why.
    assert [r for r in results if isinstance(r, BaseException)] == []
    assert sum(1 for r in results if r is True) == 1


async def test_a_claimant_that_already_read_pending_still_loses(session_factory):
    """The read-then-write trap, made explicit.

    Both sessions observe ``pending`` *before* either writes — which is exactly
    the state a read-then-write claim would act on. The loser must still be
    refused, because the decision belongs to the UPDATE and not to what it read.
    """
    run_id = await _new_pending_run(session_factory)

    async with session_factory() as loser, session_factory() as winner:
        # Both see a claimable run.
        loser_view = await get_run(loser, tenant_id=TENANT, run_id=run_id)
        winner_view = await get_run(winner, tenant_id=TENANT, run_id=run_id)
        assert loser_view is not None and loser_view.status == "pending"
        assert winner_view is not None and winner_view.status == "pending"

        await claim_run(winner, tenant_id=TENANT, run_id=run_id)
        await winner.commit()

        # The loser's own read said `pending`. It must not be allowed to act on it.
        with pytest.raises(RunNotClaimableError) as exc:
            await claim_run(loser, tenant_id=TENANT, run_id=run_id)
        assert exc.value.status == "running"


async def test_the_claim_is_one_statement_conditional_on_pending(session_factory):
    """Structural: the guarantee is the WHERE clause, so assert it exists.

    A refactor to read-then-write would keep every behavioural test above green
    under a serialising database while silently reopening the race in
    production, where Postgres runs the two claimants in parallel.
    """
    from api import agent_runs

    source = Path(agent_runs.__file__).read_text(encoding="utf-8")
    claim_body = source.split("async def claim_run")[1].split("async def complete_run")[0]

    assert "update(AgentRun)" in claim_body
    assert 'AgentRun.status == "pending"' in claim_body
    assert "rowcount" in claim_body
    # And no read feeding the write: the only get_run is on the losing path,
    # after rowcount has already decided.
    assert claim_body.index("rowcount") < claim_body.index("get_run")


async def test_a_lost_claim_leaves_the_winner_untouched(session_factory):
    run_id = await _new_pending_run(session_factory)

    async with session_factory() as winner:
        await claim_run(winner, tenant_id=TENANT, run_id=run_id)
        await winner.commit()

    async with session_factory() as loser:
        with pytest.raises(RunNotClaimableError):
            await claim_run(loser, tenant_id=TENANT, run_id=run_id)

    async with session_factory() as check:
        run = await get_run(check, tenant_id=TENANT, run_id=run_id)
        assert run is not None
        assert run.status == "running"
        assert run.started_at is not None


async def test_claiming_is_tenant_scoped(session_factory):
    run_id = await _new_pending_run(session_factory)

    async with session_factory() as session:
        # Another tenant cannot see, let alone claim, this run.
        assert await claim_run(session, tenant_id="other", run_id=run_id) is None
        run = await get_run(session, tenant_id=TENANT, run_id=run_id)
        assert run is not None
        assert run.status == "pending"
