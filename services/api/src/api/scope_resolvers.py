"""Registry of hierarchy scope resolvers (docs/implementation/0003-hierarchy-scoped-workflows).

A workflow definition may declare an optional ``scope`` — ``{"level": <str>,
"id": <str>}`` — so a rule authored at a coarse level (e.g. a brand) also
applies to everything beneath it (that brand's regions and units), not just
events at the exact same granularity. This module never hardcodes what a
"level" is: an instance's own product domain defines its hierarchy shape and
registers a resolver that, given a triggering event, returns that event's
full ancestor chain. The template ships a default resolver so an instance
that registers nothing still gets correct (if less powerful) single-level
matching — nothing breaks for an instance that never adopts this feature.

Registration happens at instance domain-module import time, exactly like the
Event Registry (``events/registry.py``): a downstream repo adds hierarchy
awareness without editing this file.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

# ``(db, source, detail_type, payload) -> {level_name: id_or_None}``. Async
# because resolving an event's ancestry may need a database lookup (e.g. a
# unit's payload carries only its own id; the region/brand above it must be
# looked up) — safe here because this runs inside Core (ADR-0002), which
# already owns the database, never in a plugin.
ScopeResolver = Callable[
    [AsyncSession, str, str, dict[str, Any]], Awaitable[Mapping[str, str | None]]
]


async def _default_resolver(
    db: AsyncSession, source: str, detail_type: str, payload: dict[str, Any]
) -> dict[str, str | None]:
    """No hierarchy knowledge: each level's id, if the payload happens to
    carry one under a ``f"{level}_id"`` key, else ``None``. No database
    lookups — this is what every instance gets until it registers its own
    resolver, and it is enough to match a scope against an event that
    already carries the exact id (just not one that requires ancestry
    inference, e.g. a unit's region when the payload omits it).
    """
    return {level: payload.get(f"{level}_id") for level in _levels}


_levels: tuple[str, ...] = ()
_resolver: ScopeResolver = _default_resolver


def register_scope_resolver(resolver: ScopeResolver, *, levels: tuple[str, ...]) -> None:
    """Declare the instance's hierarchy resolver and its ordered level names.

    Idempotent like ``register_event``: a later call replaces the earlier
    one — there is exactly one active resolver (an instance has exactly one
    hierarchy shape), not a registry keyed by event type.
    """
    global _levels, _resolver
    _levels = levels
    _resolver = resolver


def registered_scope_levels() -> tuple[str, ...]:
    """The active resolver's level names, in broad-to-narrow order — feeds
    the builder's scope picker. Empty when nothing is registered."""
    return _levels


async def resolve_scope_chain(
    db: AsyncSession, source: str, detail_type: str, payload: dict[str, Any]
) -> Mapping[str, str | None]:
    """The triggering event's full ancestor chain, via the active resolver.

    Resolve this **once per event**, not once per candidate definition — the
    chain is the same regardless of which definition is being checked
    against it. ``dispatch_event`` calls this once and reuses the result via
    ``scope_matches_chain`` for every definition it considers.
    """
    return await _resolver(db, source, detail_type, payload)


def scope_matches_chain(scope: dict[str, Any] | None, chain: Mapping[str, str | None]) -> bool:
    """Whether a definition's ``scope`` is covered by an event's resolved
    ancestor chain (from :func:`resolve_scope_chain`).

    ``None`` (unscoped) always matches — today's behaviour, unchanged. A set
    scope matches when the chain has that exact id at that level: because
    the chain is always resolved in full regardless of how granular the
    triggering event itself is, a Brand-scoped definition matches a Region
    or Unit event under that brand for free — this one check is what
    delivers "a higher level covers everything beneath it."
    """
    if scope is None:
        return True
    return chain.get(scope["level"]) == scope["id"]
