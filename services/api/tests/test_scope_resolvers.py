"""Unit tests for the scope resolver registry (docs/implementation/
0003-hierarchy-scoped-workflows)."""

from __future__ import annotations

from typing import Any, cast

import pytest
from api import scope_resolvers as sr
from sqlalchemy.ext.asyncio import AsyncSession

# These resolvers never touch the database — a real AsyncSession isn't needed.
_DB = cast(AsyncSession, None)


@pytest.fixture(autouse=True)
def _reset_registry():
    """The registry is a single module-global resolver/levels pair (an
    instance has exactly one hierarchy shape) — reset it around every test
    so registering a fake resolver in one test can't leak into another."""
    saved_levels, saved_resolver = sr._levels, sr._resolver  # noqa: SLF001
    yield
    sr._levels, sr._resolver = saved_levels, saved_resolver  # noqa: SLF001


async def test_default_resolver_has_no_levels_when_nothing_registered():
    assert sr.registered_scope_levels() == ()
    chain = await sr.resolve_scope_chain(_DB, "biffo.core", "demo.requested", {"brand_id": "b1"})
    assert chain == {}


async def test_default_resolver_reads_literal_payload_ids_once_registered_with_no_lookup():
    # Registering only supplies level names — the *default* resolver logic still
    # runs (no custom resolver given), so it reads `f"{level}_id"` straight off
    # the payload with no database access.
    sr.register_scope_resolver(sr._default_resolver, levels=("brand", "region", "unit"))  # noqa: SLF001

    chain = await sr.resolve_scope_chain(
        _DB, "biffo.core", "unit.onboarded", {"brand_id": "b1", "unit_id": "u1"}
    )

    assert chain == {"brand": "b1", "region": None, "unit": "u1"}


async def test_register_scope_resolver_is_idempotent_last_wins():
    async def resolver_a(db: Any, source: str, detail_type: str, payload: dict) -> dict:
        return {"brand": "from-a"}

    async def resolver_b(db: Any, source: str, detail_type: str, payload: dict) -> dict:
        return {"brand": "from-b"}

    sr.register_scope_resolver(resolver_a, levels=("brand",))
    sr.register_scope_resolver(resolver_b, levels=("brand",))

    chain = await sr.resolve_scope_chain(_DB, "biffo.core", "lead.captured", {})
    assert chain == {"brand": "from-b"}


def test_scope_matches_chain_unscoped_always_matches():
    assert sr.scope_matches_chain(None, {"brand": "b1"}) is True
    assert sr.scope_matches_chain(None, {}) is True


def test_scope_matches_chain_exact_level_match():
    chain = {"tenant": "default", "brand": "b1", "region": "r1", "unit": "u1"}
    assert sr.scope_matches_chain({"level": "brand", "id": "b1"}, chain) is True
    assert sr.scope_matches_chain({"level": "brand", "id": "other-brand"}, chain) is False


def test_scope_matches_chain_hierarchy_brand_covers_its_region_and_unit():
    """The core semantic this feature exists for: a Brand-scoped definition
    matches a Region or Unit event under that brand, because the chain
    resolved for that event already carries the brand id at the "brand" key
    — regardless of how granular the triggering event itself was."""
    region_event_chain = {"tenant": "default", "brand": "b1", "region": "r1", "unit": None}
    unit_event_chain = {"tenant": "default", "brand": "b1", "region": "r1", "unit": "u1"}
    scope = {"level": "brand", "id": "b1"}

    assert sr.scope_matches_chain(scope, region_event_chain) is True
    assert sr.scope_matches_chain(scope, unit_event_chain) is True


def test_scope_matches_chain_does_not_match_a_sibling_brand():
    other_brand_chain = {"tenant": "default", "brand": "b2", "region": "r9", "unit": "u9"}
    assert sr.scope_matches_chain({"level": "brand", "id": "b1"}, other_brand_chain) is False


def test_scope_matches_chain_a_region_scope_does_not_match_a_brand_only_event():
    """A brand-level event (e.g. lead.captured) has no region/unit to match
    against — a region/unit-scoped definition correctly does not fire for
    it (scoping narrows which events a rule *can* apply to)."""
    brand_only_chain = {"tenant": "default", "brand": "b1", "region": None, "unit": None}
    assert sr.scope_matches_chain({"level": "region", "id": "r1"}, brand_only_chain) is False
