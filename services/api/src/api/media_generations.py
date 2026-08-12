"""Recording a billable non-text generation, idempotently (issue #1515).

The write itself is two lines; the reason it lives in a module rather than inline
in the router is the race. A plugin retrying a lost ledger write must not create a
second row, and "look first, then insert" cannot promise that — two retries
overlap, both look, both see nothing, both insert. So the winner is decided by a
unique index and an ``IntegrityError``, and that is testable only by driving this
function from two concurrent sessions, which a router test cannot do.

Same shape as ``agent_runs.create_run`` for the same reason (#661), including the
``(row, created)`` return: the caller needs to know, because the HTTP status
differs and a caller that is told 201 for a row it did not create cannot tell a
first attempt from a retry.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models.media_generation import MediaGeneration


async def record_generation(
    db: AsyncSession,
    *,
    tenant_id: str,
    caller_plugin: str | None,
    media_kind: str,
    provider: str,
    model: str,
    units: float,
    unit_kind: str,
    cost_usd: float | None = None,
    causation_id: str | None = None,
    client_request_id: str | None = None,
) -> tuple[MediaGeneration, bool]:
    """Record one billable generation, returning ``(row, created)``.

    Without ``client_request_id`` this is a plain insert and every call writes a
    row — the behaviour every existing caller already has, unchanged. ``created``
    is always True on that path, so the route keeps returning 201.

    With a key it becomes create-or-**get**. The insert runs inside a SAVEPOINT,
    the same shape as ``create_run`` and ``orchestration._claim_run``: a duplicate
    rolls back only the insert rather than the caller's whole transaction, and the
    row already there is fetched and returned with ``created`` False.

    The lookup filters on ``coalesce(caller_plugin, '')`` rather than on the
    column, matching the unique index expression exactly. That is not cosmetic: a
    plain ``caller_plugin == None`` comparison in SQL is never true, so a
    NULL-caller duplicate would raise IntegrityError and then find nothing,
    turning a retry into a 500 — the failure this whole change exists to remove.
    """
    row = MediaGeneration(
        tenant_id=tenant_id,
        caller_plugin=caller_plugin,
        causation_id=causation_id,
        media_kind=media_kind,
        provider=provider,
        model=model,
        units=units,
        unit_kind=unit_kind,
        cost_usd=cost_usd,
        client_request_id=client_request_id,
    )

    if client_request_id is None:
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return row, True

    try:
        async with db.begin_nested():
            db.add(row)
            await db.flush()
    except IntegrityError:
        existing = await db.scalars(
            select(MediaGeneration).where(
                MediaGeneration.tenant_id == tenant_id,
                func.coalesce(MediaGeneration.caller_plugin, "") == (caller_plugin or ""),
                MediaGeneration.client_request_id == client_request_id,
            )
        )
        return existing.one(), False

    await db.refresh(row)
    return row, True
