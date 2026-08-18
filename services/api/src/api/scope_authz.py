"""Scope authorization registry (ADR-0029, issue #1607).

A second axis on the CRUD-closed, service-authenticated data seam ADR-0017 §5
already ships (``owner_scoped_service``, ``routing/owner_data_router.py``):
that axis scopes rows to one caller's own Cognito ``sub``, so a unit owner and
their unit staff would each get a private silo and nobody above them could see
anything a peer or a manager holds. This registry answers a different
question — "may THIS caller act at THIS scope ref, for THIS permission_code"
— a grant that can cover a whole subtree (a brand manager's grant reaches
every region and unit beneath their brand), not just their own identity.

Registered the same way as ``orchestration_authz.py`` (ADR-0025) and
``scope_resolvers.py`` (ADR-0024): the template ships a fail-closed default —
nothing is ever authorized until an instance registers its own authorizer at
domain-module import time — and the template has no concept of what a scope
ref names.

## The opaque-reference constraint (issue #1607)

A plugin must never learn the instance's scope vocabulary — that would couple
a portable plugin to one instance's domain model, repeating the ``founder``
hardcoding mistake one layer deeper. Every value this module hands across the
HTTP seam (``routers/internal_scopes.py``) is an opaque string ``ref`` plus a
display ``label`` and an integer ``depth`` — never a typed ``unit_id`` /
``region_id`` field, and the words "unit"/"region"/"brand" appear nowhere a
plugin can reach. A forged, guessed, or replayed ``ref`` gains nothing: every
use re-runs the authorizer against the caller's own verified token, so a ref
is an identifier, never a capability.

## Enforcement lives in Core, never in a plugin (scope_resolvers.py:27-30)

A plugin that read its own grant from ``whoami`` and filtered its own query
would be enforcing scope on data it also writes — precisely the shape
``scope_resolvers.py`` fences off in as many words. This registry is
consulted only from Core route handlers; a plugin never calls the registered
authorizer directly, only ever the HTTP seam in ``routers/internal_scopes.py``,
which is itself dual-authenticated (``require_signed_principal``) so a plugin
cannot even reach it without a re-verified user token.

## The instance entitles plugins, never the plugin itself (#1653)

The seam has a second axis (``routers/internal_scopes.py``): the forwarded
caller must hold ``permission_code``, AND the *asking plugin* must be
entitled to ask about it. **The instance declares that entitlement**, as the
``entitlements`` argument to ``register_scope_authorizer`` — the same party
that already owns the ``permission_code`` vocabulary (ADR-0012's identity
seam: ``provider.resolve_permissions`` resolves codes the instance's own DDL
seeds and grants). A plugin cannot entitle itself, because a plugin authors
no part of this registration.

#1644 originally derived entitlement from ``PermissionRule.permission_code``
in a plugin's own ``biffo.plugin.json``. That contradicted #1606's
portability rule outright: ``permission_code`` is the DB-held,
instance-specific gate a *portable* plugin is designed not to use
(``required_role`` is the portable one), so **no** ``biffo.plugin.json`` in
the estate declares one — 0 of 28 files, measured across every local
repository checkout including skeletons — and the only way to become entitled
was to stop being portable. It also read a document the asking plugin writes, so a plugin
could name any code it liked and thereby entitle itself. Entitlement is not
the plugin's statement to make.

## Fail-closed, and distinguishable from "checked and allowed" (#1606, #1634)

Two different callers get "no" here for two different reasons, and the two
must never look alike — #1634 was rejected once for exactly this collision, a
bare ``[]`` a caller could not tell apart from "checked, nothing granted".
``resolved=False`` means NO authorizer is registered at all (bare core): the
honest answer is "could not resolve", never "denied". A registered authorizer
that legitimately denies this caller reports ``resolved=True, allowed=False``
— "checked, and no". ``ScopeListing`` carries the same distinction plus a
denominator: ``checked`` (how many of the caller's own grant refs were
examined) and ``unresolved`` (how many of those the ancestry resolver could
not place — a stale assignment pointing at something since removed is
*unexamined*, not *silently dropped as fine*).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from .middleware.auth import AuthenticatedUser


@dataclass(frozen=True)
class ScopeGrant:
    """What one caller may act on, for one ``permission_code``.

    ``refs`` is the set of scope refs the caller directly holds — an
    instance's own role-assignment model decides what "holds" means (tabsii:
    ``fn_ura_scope_reachable``). A ref in ``refs`` authorizes itself and every
    descendant (a brand grant reaches its regions and units); descendants are
    established by ancestry (``ScopeAncestryResolver``), never enumerated
    here — a brand grant does not expand into every unit beneath it as a set.

    ``unrestricted`` is the tenant-wide case (e.g. a platform admin acting
    through this seam rather than ``require_admin``) — kept as its own field
    rather than a magic ref value, so "no grant" (``ScopeGrant()``, the
    fail-closed default) can never be confused with "every grant".
    """

    refs: frozenset[str] = frozenset()
    unrestricted: bool = False


@dataclass(frozen=True)
class ScopeCheckResult:
    """The answer to "may this caller act at this one scope ref".

    ``resolved`` is ``False`` only when no authorizer is registered at all
    (bare core) — see the module docstring's fail-closed section. ``reason``
    is a short, non-secret, human-readable string for logging; it is never
    the authorization decision itself.
    """

    allowed: bool
    resolved: bool
    reason: str | None = None


@dataclass(frozen=True)
class ScopeOption:
    """One scope the caller may act on, opaque beyond its own shape (issue
    #1607's opaque-reference constraint) — no field here is instance
    vocabulary."""

    ref: str
    label: str
    depth: int
    parent_ref: str | None


@dataclass(frozen=True)
class ScopeListing:
    """The caller's own reachable scopes for one ``permission_code`` — the
    projection ``GET /internal/scopes`` serves to a plugin's picker.

    ``checked`` and ``unresolved`` are the denominator the issue asks every
    authorizer report to carry: ``checked`` is how many of the caller's grant
    refs were examined, ``unresolved`` is how many of those the ancestry
    resolver could not place (dropped from ``scopes``, but counted here
    rather than silently vanishing).
    """

    scopes: tuple[ScopeOption, ...]
    resolved: bool
    checked: int
    unresolved: int


# (caller, db, permission_code) -> the caller's grant for that permission_code.
# Async because answering this may need a database lookup (e.g. the caller's
# role assignments) — safe here because this runs inside Core (ADR-0002),
# never in a plugin.
ScopeAuthorizer = Callable[[AuthenticatedUser, AsyncSession, str], Awaitable[ScopeGrant]]

# (db, scope_ref) -> broad-to-narrow ancestry INCLUDING scope_ref itself, e.g.
# ("brand-1", "region-3", "unit-9") for a unit ref. Empty tuple means unknown
# to this instance (a ref that does not exist, or existed and was removed).
ScopeAncestryResolver = Callable[[AsyncSession, str], Awaitable[tuple[str, ...]]]

# (db, refs) -> {ref: human label}, display only — the plugin stores and
# resends the ref; it renders the label. Never consulted for authorization.
ScopeDescriber = Callable[[AsyncSession, Sequence[str]], Awaitable[Mapping[str, str]]]

# {service logical name -> the permission_codes that service may ASK about}.
#
# Keys are ``ServicePrincipal.logical_names`` values — ``system:<plugin-name>``
# for a plugin's own signed principal. Values are codes drawn from the
# INSTANCE's own permission vocabulary, which is why only the instance can
# write this: it is the one party that knows both the vocabulary and which
# plugins it trusts with which part of it (#1653).
ScopeEntitlements = Mapping[str, Collection[str]]


async def _default_authorizer(
    caller: AuthenticatedUser, db: AsyncSession, permission_code: str
) -> ScopeGrant:
    del caller, db, permission_code
    return ScopeGrant()


async def _default_ancestry(db: AsyncSession, scope_ref: str) -> tuple[str, ...]:
    del db, scope_ref
    return ()


async def _default_describer(db: AsyncSession, refs: Sequence[str]) -> Mapping[str, str]:
    del db, refs
    return {}


_authorizer: ScopeAuthorizer = _default_authorizer
_ancestry_resolver: ScopeAncestryResolver = _default_ancestry
_describer: ScopeDescriber = _default_describer
_entitlements: Mapping[str, frozenset[str]] = {}
_registered: bool = False


def register_scope_authorizer(
    authorizer: ScopeAuthorizer,
    *,
    ancestry_resolver: ScopeAncestryResolver | None = None,
    describer: ScopeDescriber | None = None,
    entitlements: ScopeEntitlements | None = None,
) -> None:
    """Declare the instance's scope-authorization model.

    Idempotent like ``register_workflow_scope_authorizer`` /
    ``register_scope_resolver``: a later call replaces the earlier one
    wholesale — there is exactly one active authorizer (an instance has
    exactly one authorization model), not a registry keyed by anything.
    ``ancestry_resolver``/``describer``/``entitlements`` default to the no-op
    fallbacks when omitted, rather than silently keeping a previous
    registration's — a caller registering a new authorizer without new
    resolvers almost always means "this instance has no ancestry concept"
    (flat scopes), not "reuse whatever was there before". The same
    no-carry-over rule is what makes ``entitlements`` safe: omitting it says
    "this instance entitles nobody", never "keep the last map", so a
    re-registration can never leave behind a grant its author did not write
    down.

    ``entitlements`` is the instance's answer to "which plugin may ASK this
    seam about which ``permission_code``" (#1653) — see ``ScopeEntitlements``
    and ``service_is_entitled``. It is deliberately a parameter here rather
    than anything a plugin declares: the instance owns the code vocabulary
    and chose to install the plugin, so it is the only party holding both
    halves of that decision.

    A malformed ``entitlements`` (values that are not iterables of strings)
    raises at registration time — import time for a domain module, so an
    instance fails to boot rather than serving an authorization map nobody
    can read. Deliberately not caught: there is no safe partial answer to
    "which plugins does this instance trust".
    """
    global _authorizer, _ancestry_resolver, _describer, _entitlements, _registered
    _authorizer = authorizer
    _ancestry_resolver = ancestry_resolver or _default_ancestry
    _describer = describer or _default_describer
    _entitlements = (
        {name: frozenset(codes) for name, codes in entitlements.items()} if entitlements else {}
    )
    _registered = True


def service_is_entitled(logical_names: Iterable[str], permission_code: str) -> bool:
    """May a service calling under ``logical_names`` ask about
    ``permission_code``?

    Fail-closed and unconditional: an instance that registered no
    entitlements — including bare core, which registered nothing at all —
    entitles nobody, so every ask is refused. There is no path by which a
    calling plugin's own declarations reach this answer.

    ``logical_names`` is normally a single ``{"system:<name>"}``
    (``ServicePrincipal.logical_names``); iterating is defensive, not a claim
    that a principal ever carries more than one.
    """
    return any(permission_code in _entitlements.get(name, frozenset()) for name in logical_names)


def scope_entitlements() -> Mapping[str, frozenset[str]]:
    """The registered entitlement map, read-only — for diagnostics and tests.

    Returns a copy so a caller cannot mutate the live map into a grant the
    instance never declared.
    """
    return dict(_entitlements)


def scope_authz_registered() -> bool:
    """Whether an instance has registered its own authorizer.

    The bare-core / "could not resolve" distinction turns on *this*, not on
    the grant an authorizer returns: a registered authorizer legitimately
    returning an empty grant is a real, checked answer ("no"); no
    registration at all is the absence of a check to report.
    """
    return _registered


async def authorize_scope(
    caller: AuthenticatedUser, db: AsyncSession, permission_code: str, scope_ref: str
) -> ScopeCheckResult:
    """May ``caller`` act at ``scope_ref`` for ``permission_code``?

    Fail-closed: no authorizer registered means every check is denied and
    reported ``resolved=False`` — "could not resolve", never "not permitted".
    An ``unrestricted`` grant (e.g. a platform admin) short-circuits to
    allowed without walking ancestry at all. Otherwise the caller's grant
    must intersect ``scope_ref``'s own broad-to-narrow ancestry — holding a
    broader ancestor (a brand) authorizes a narrower ref beneath it (one of
    its units) without the grant ever enumerating that unit by name.
    """
    if not _registered:
        return ScopeCheckResult(
            allowed=False, resolved=False, reason="no scope authorizer registered"
        )

    grant = await _authorizer(caller, db, permission_code)
    if grant.unrestricted:
        return ScopeCheckResult(allowed=True, resolved=True)

    ancestry = await _ancestry_resolver(db, scope_ref)
    if not ancestry:
        # Unknown to the ancestry resolver (no hierarchy registered, or a ref
        # that genuinely doesn't exist) — the caller may still hold a grant
        # directly on this exact ref, so still check it as its own ancestor.
        ancestry = (scope_ref,)

    allowed = bool(grant.refs.intersection(ancestry))
    return ScopeCheckResult(
        allowed=allowed,
        resolved=True,
        reason=None if allowed else "caller's grant does not cover this scope or its ancestors",
    )


async def list_reachable_scopes(
    caller: AuthenticatedUser, db: AsyncSession, permission_code: str
) -> ScopeListing:
    """The caller's own reachable scopes for ``permission_code`` — what a
    plugin's picker renders, never anything wider.

    An ``unrestricted`` grant lists exactly ``grant.refs`` and nothing more:
    the template has no concept of "every scope that exists" to enumerate on
    an instance's behalf, so an authorizer that wants a platform admin's
    picker to show every root scope must include those roots in ``refs``
    even while also setting ``unrestricted=True`` for the check path.
    """
    if not _registered:
        return ScopeListing(scopes=(), resolved=False, checked=0, unresolved=0)

    grant = await _authorizer(caller, db, permission_code)
    refs = sorted(grant.refs)
    checked = len(refs)
    labels = await _describer(db, refs) if refs else {}

    options: list[ScopeOption] = []
    unresolved = 0
    for ref in refs:
        ancestry = await _ancestry_resolver(db, ref)
        if not ancestry:
            unresolved += 1
            continue
        depth = len(ancestry) - 1
        parent_ref = ancestry[-2] if len(ancestry) >= 2 else None
        options.append(
            ScopeOption(ref=ref, label=labels.get(ref, ref), depth=depth, parent_ref=parent_ref)
        )

    return ScopeListing(
        scopes=tuple(options), resolved=True, checked=checked, unresolved=unresolved
    )
