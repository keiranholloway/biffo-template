"""Unit tests for the scope-authorization registry (ADR-0029, issue #1607
steps 1-2).

The fail-first cases the issue asks for, executed here rather than just
asserted:

- a caller with the scope → allowed
- a caller without it → denied (``resolved=True, allowed=False``)
- bare core, no scopes defined → denied AND distinguishable from a permitted
  answer (``resolved=False``, never conflated with "checked, clean")
- the denominator: how many scopes were checked, how many could not be
  resolved
"""

from __future__ import annotations

from typing import cast

import pytest
from api import scope_authz as authz
from api.middleware.auth import AuthenticatedUser
from sqlalchemy.ext.asyncio import AsyncSession

_DB = cast(AsyncSession, None)


def _caller(sub: str = "alice") -> AuthenticatedUser:
    return AuthenticatedUser(sub=sub, email=f"{sub}@x.com", username=sub, tenant_id="default")


@pytest.fixture(autouse=True)
def _reset_registry():
    """One module-global registration (an instance has exactly one
    authorization model) — reset around every test so a fake authorizer
    registered in one test can't leak into the next."""
    saved = (
        authz._authorizer,  # noqa: SLF001
        authz._ancestry_resolver,  # noqa: SLF001
        authz._describer,  # noqa: SLF001
        authz._registered,  # noqa: SLF001
    )
    yield
    (
        authz._authorizer,  # noqa: SLF001
        authz._ancestry_resolver,  # noqa: SLF001
        authz._describer,  # noqa: SLF001
        authz._registered,  # noqa: SLF001
    ) = saved


def _force_unregistered() -> None:
    """Explicitly force the pristine, nothing-ever-registered state rather
    than assert whatever happens to be ambient — mirrors
    test_scope_resolvers.py's own reasoning: a real instance registering at
    import time may already have run in this same test process."""
    authz._authorizer = authz._default_authorizer  # noqa: SLF001
    authz._ancestry_resolver = authz._default_ancestry  # noqa: SLF001
    authz._describer = authz._default_describer  # noqa: SLF001
    authz._registered = False  # noqa: SLF001


# ── bare core: fail-closed AND distinguishable from "checked, clean" ────────


async def test_bare_core_scope_check_is_denied_and_marked_unresolved():
    _force_unregistered()
    assert authz.scope_authz_registered() is False

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "brand-1")

    assert result.allowed is False
    assert result.resolved is False  # "could not resolve", not "not permitted"
    assert result.reason == "no scope authorizer registered"


async def test_bare_core_scope_listing_is_empty_and_marked_unresolved():
    _force_unregistered()

    listing = await authz.list_reachable_scopes(_caller(), _DB, "marketing.links.manage")

    assert listing.scopes == ()
    assert listing.resolved is False
    # Not "checked 0, found 0" (which a registered-but-empty authorizer would
    # also report) — nothing was examined at all.
    assert listing.checked == 0
    assert listing.unresolved == 0


async def test_a_registered_authorizer_that_denies_is_resolved_true_not_bare_core():
    """The other half of the same distinction: a real "no" from a registered
    authorizer must NOT look like bare core."""

    async def deny_everyone(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant()

    authz.register_scope_authorizer(deny_everyone)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "brand-1")

    assert result.allowed is False
    assert result.resolved is True  # checked, and the answer is no
    assert result.reason != "no scope authorizer registered"


# ── a caller with the scope → allowed; without it → denied ──────────────────


async def test_caller_holding_the_exact_ref_is_allowed():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    authz.register_scope_authorizer(authorizer)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-9")
    assert result == authz.ScopeCheckResult(allowed=True, resolved=True, reason=None)


async def test_caller_lacking_the_ref_is_denied_not_client_side():
    """The denial comes back from the registry function itself — there is no
    client-visible hint the caller could act on to bypass this; the router
    test file covers that this is enforced server-side over HTTP too."""

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-1"}))

    authz.register_scope_authorizer(authorizer)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-9")
    assert result.allowed is False
    assert result.resolved is True


async def test_a_broader_grant_covers_a_narrower_ref_via_ancestry():
    """A brand-level grant reaches a unit beneath it — the grant never
    enumerates the unit by name, only the ancestry resolver does."""

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"brand-1"}))

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        return {"unit-9": ("brand-1", "region-3", "unit-9")}.get(scope_ref, ())

    authz.register_scope_authorizer(authorizer, ancestry_resolver=ancestry)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-9")
    assert result.allowed is True


async def test_a_narrower_grant_does_not_cover_a_sibling():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        chains = {
            "unit-9": ("brand-1", "region-3", "unit-9"),
            "unit-10": ("brand-1", "region-3", "unit-10"),
        }
        return chains.get(scope_ref, ())

    authz.register_scope_authorizer(authorizer, ancestry_resolver=ancestry)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-10")
    assert result.allowed is False


async def test_unrestricted_grant_allows_any_ref_without_walking_ancestry():
    calls: list[str] = []

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        calls.append(scope_ref)
        return ()

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(unrestricted=True)

    authz.register_scope_authorizer(authorizer, ancestry_resolver=ancestry)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-9")
    assert result.allowed is True
    assert calls == []  # short-circuited before the ancestry resolver ran


# ── registration is idempotent, last-wins (matches orchestration_authz) ─────


async def test_register_scope_authorizer_is_idempotent_last_wins():
    async def authorizer_a(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant()

    async def authorizer_b(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(unrestricted=True)

    authz.register_scope_authorizer(authorizer_a)
    authz.register_scope_authorizer(authorizer_b)

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-9")
    assert result.allowed is True


async def test_registering_a_new_authorizer_resets_ancestry_and_describer_to_no_op():
    """Omitting ancestry_resolver/describer on a later registration must NOT
    silently keep the previous registration's — that would mix one
    authorization model's grants with another's hierarchy."""

    async def old_ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        return ("brand-1", "unit-9")

    async def authorizer_v1(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"brand-1"}))

    authz.register_scope_authorizer(authorizer_v1, ancestry_resolver=old_ancestry)

    async def authorizer_v2(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"brand-1"}))

    authz.register_scope_authorizer(authorizer_v2)  # no ancestry_resolver this time

    result = await authz.authorize_scope(_caller(), _DB, "marketing.links.manage", "unit-9")
    # Falls back to the default (empty) ancestry resolver, so "unit-9" only
    # matches a grant on "unit-9" itself, not the old resolver's chain.
    assert result.allowed is False


# ── the denominator: checked / unresolved (issue #1607's requirement) ───────


async def test_listing_reports_checked_and_unresolved_denominator():
    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"brand-1", "unit-stale"}))

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        # "unit-stale" is a grant referencing something this instance can no
        # longer place (e.g. a deleted unit) — unresolved, not silently fine.
        chains = {"brand-1": ("brand-1",)}
        return chains.get(scope_ref, ())

    async def describer(db, refs):  # noqa: ANN001, ARG001
        return {"brand-1": "Acme Brand"}

    authz.register_scope_authorizer(authorizer, ancestry_resolver=ancestry, describer=describer)

    listing = await authz.list_reachable_scopes(_caller(), _DB, "marketing.links.manage")

    assert listing.resolved is True
    assert listing.checked == 2  # both grant refs were examined
    assert listing.unresolved == 1  # "unit-stale" could not be placed
    assert [o.ref for o in listing.scopes] == ["brand-1"]
    assert listing.scopes[0].label == "Acme Brand"
    assert listing.scopes[0].depth == 0
    assert listing.scopes[0].parent_ref is None


async def test_listing_never_leaks_instance_vocabulary_field_names():
    """The opaque-reference constraint (#1607): only ref/label/depth/parent_ref
    ever cross this seam — no 'unit_id'/'region_id'/'brand' field."""

    async def authorizer(caller, db, permission_code):  # noqa: ANN001, ARG001
        return authz.ScopeGrant(refs=frozenset({"unit-9"}))

    async def ancestry(db, scope_ref):  # noqa: ANN001, ARG001
        return ("brand-1", "region-3", "unit-9")

    authz.register_scope_authorizer(authorizer, ancestry_resolver=ancestry)

    listing = await authz.list_reachable_scopes(_caller(), _DB, "marketing.links.manage")

    option = listing.scopes[0]
    assert vars(option).keys() == {"ref", "label", "depth", "parent_ref"}
    assert option.depth == 2  # brand(0) -> region(1) -> unit(2), never named
    assert option.parent_ref == "region-3"  # opaque — the caller never learns "region"
