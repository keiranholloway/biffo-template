# ADR-0029: Plugin scope-authorization registry — an opaque-reference seam, Core-enforced

**Status:** Accepted (steps 1-2 of 4; step 3 is instance-owned, step 4 deferred)
**Date:** 2026-08-17
**Deciders:** Core team (owner decision on issue #1607: "This looks good. Go with (B)")

---

## Context

ADR-0017 §5 already ships a Core-enforced, declarative, service-authenticated
data seam for plugin tables (`owner_scoped_service`,
`services/api/src/api/routing/owner_data_router.py` /
`owner_data_handlers.py`) — and `biffo-plugin-idea-scout` uses it in
production today, on two tables. That axis scopes every row to the *caller's
own Cognito `sub`*: a unit owner and their unit staff each get a private
silo, and nobody above them (a brand or region manager) can see anything.

Issue #1607 (`biffo-plugin-marketing#73`) needs a genuinely different shape:
a product shared *by* a unit and visible *upward* — a brand manager should
see every unit beneath their brand without the plugin ever being told what a
"unit" or "brand" is. `owner_scoped_service` cannot express that; it has no
concept of a caller acting on behalf of a scope wider than their own
identity.

Two things this issue originally claimed were checked against `origin/dev`
and found not to hold, which changes the cost of building this:

- **`owner_scoped_service` is not merely declared, unused config** — it is
  implemented end to end (`models/plugin_table.py`, `routing/owner_data_router.py`,
  `routing/owner_data_handlers.py`, `tests/test_owner_data.py`) and is live in
  `biffo-plugin-idea-scout`'s manifest. This ADR adds a *second axis* to a
  mechanism already shipping and reviewed, not a new one.
- **`tabsii-platform` already has the instance-side reachability check** —
  `tabsii.fn_ura_scope_reachable(:code, :tenant_id, :brand_id, :region_id,
  :unit_id, NULL)`, keyed by a **permission code**. The instance-side
  authorizer (step 3, not built in this repo) is three queries over an
  existing DB function, not a new authorization model.

## Decision

**A registered authorizer seam** (`scope_authz.py`), the same "instance
registers, template ships a fail-closed default" shape as
`orchestration_authz.py` (ADR-0025) and `scope_resolvers.py` (ADR-0024),
generalized over an arbitrary `permission_code` rather than one hardcoded
workflow concept — because #1606 already established `permission_code` as
the estate's action vocabulary, and this ADR's scope axis **ANDs** with it
rather than rivalling it (exactly as `permission_code` and `required_role`
already AND at `dependencies.py:142-152`, for the identical reason: silently
short-circuiting on one axis leaves the other one unenforced).

### 1. The registry — `services/api/src/api/scope_authz.py`

```python
@dataclass(frozen=True)
class ScopeGrant:
    refs: frozenset[str] = frozenset()
    unrestricted: bool = False

ScopeAuthorizer = Callable[[AuthenticatedUser, AsyncSession, str], Awaitable[ScopeGrant]]
ScopeAncestryResolver = Callable[[AsyncSession, str], Awaitable[tuple[str, ...]]]
ScopeDescriber = Callable[[AsyncSession, Sequence[str]], Awaitable[Mapping[str, str]]]
```

Defaults: `ScopeGrant()` (empty, restricted), no ancestry, no labels. On bare
core every check is denied and **every response says so distinguishably**
(`resolved=False`, "could not resolve" — never "not permitted"; see
Consequences).

A **grant**, not a boolean: a boolean answers the write path but forces one
round-trip per row on the read/listing path, and a second code path can drift
from the first. A grant answers both — `authorize_scope` and
`list_reachable_scopes` are both projections of the one `ScopeAuthorizer`
call.

### 2. The HTTP seam — `services/api/src/api/routers/internal_scopes.py`

- `GET /api/v1/internal/scopes?permission_code=X` → the caller's own
  reachable scopes, opaque: `{ref, label, depth, parent_ref}` — no field
  named `unit`/`region`/`brand`, ever.
- `POST /api/v1/internal/scope-check` → `{allowed, resolved, reason}` for the
  single-ref case.

Both are dual-authenticated (`require_signed_principal`, ADR-0017 §3/§5): a
SigV4 service principal proves which plugin is calling; a forwarded,
re-verified founder token proves which user it acts for. Both ALSO check
`permission_code` against the caller's own `AuthenticatedUser.permissions`
first (the #1606 axis) — a forwarded caller who holds no grant for that
`permission_code` at all is refused there, **regardless of which plugin is
asking**, with no new per-plugin ownership table needed. This is what makes
"a plugin asking about another plugin's data" refuse itself: the check is
always against the caller's own grant, never the calling service's identity.

### 3. Instance-side implementation (NOT this repo)

Mirrors ADR-0024/ADR-0025: the template has zero concept of "brand" or
"unit". `tabsii-platform` registers its own authorizer (three queries over
`fn_ura_scope_reachable`) from `services/api/src/api/domains/tabsii/` —
which `core-manifest.json` marks `userOwned` under `services/api/`, so it
is out of scope for this ADR and this repo by the manifest's own ownership
rule, not by convention alone.

### 4. Deliberately NOT built here (issue #1607 step 4)

`scope_scoped_service` (the manifest field), the Core-managed `scope_ref` /
`scope_path` columns, and `/api/v1/internal/scope-data/<table>` are a
**one-way door** — a published plugin-manifest contract, and rows written
into every instance database that adopts it. The owner's decision sequences
that behind a real consumer (`biffo-plugin-marketing#73`) landing, not
speculatively alongside this registry. Nothing in this ADR's shape forces a
particular step-4 design; `ScopeGrant`/`ScopeAuthorizer` are already exactly
what step 4's enforcement would consume.

## Options Considered

Reproduced from the issue #1607 decision memo (full text in the issue's
comments); summarized here for the ADR record.

### Option A — Ask-only seam, plugin owns and filters its own scope column

**Pros:** fastest unblock for one consumer.
**Cons:** the plugin ends up enforcing scope on data it also writes —
precisely the shape `scope_resolvers.py:27-30` fences off. Moving enforcement
into Core later is a data migration across every instance that adopted it.
Rejected by the owner.

### Option B — Declarative scope-scoped tables, Core-enforced (chosen)

**Pros:** enforcement Core-side and structurally unbypassable (ADR-0002: a
plugin has no other write path to the database at all — no network route,
no DB secret, no DB client library); no vocabulary leak; fails closed
everywhere; composes with #1606 as an AND; the ask-seam (steps 1-2) is a
free projection of the same registry a future write-enforcement path (step 4)
would consult, so the two cannot drift apart.
**Cons:** more code than A; step 4 (deferred) commits a published manifest
field and instance-database columns — a real one-way door, taken
deliberately and only once a real consumer is ready.

### Option C — Decline to build; wire the `core_capabilities` reader instead

**Pros:** kills the broader "plugin declares a capability nothing answers"
class estate-wide; defers this seam until a second instance wants it.
**Cons:** forecloses the portable per-unit plugin product entirely. The
owner's decision: this is a *platform capability*, not a `tabsii-crm`
instance feature, so C's premise (there will only ever be one consumer) was
rejected on product grounds. (The finding that motivated C — no reader for
declared `core_capabilities` exists anywhere, `plugin.py:576` — survives as
its own defect, tracked separately, not absorbed into this decision.)

## Rationale

Option B is the only one that keeps enforcement out of the process that also
writes the data (the property the whole seam exists to protect,
`scope_resolvers.py:27-30`), and it does so by generalizing a pattern this
codebase has already built, shipped and reasoned about twice
(`scope_resolvers.py` / ADR-0024, `orchestration_authz.py` / ADR-0025) rather
than inventing a third shape. Sequencing steps 1-3 (reversible: a registry
with no consumer, two read-only projections of it, and one instance's own
authorizer) ahead of step 4 (one-way: the manifest field and the database
columns) lets the reversible, structural work land now and keeps the
irreversible commitment behind a real consumer, per the owner's explicit
build order.

## Consequences

### Positive

- Zero behavior change for every existing deployment — nothing is mounted
  that any existing plugin or instance calls; this is new surface with no
  prior callers to break.
- `biffo-plugin-marketing#73`'s blocking "scope model" decision is now
  answered; its schema and UI work can proceed against a real contract.
- The bare-core / registered-and-denied distinction
  (`resolved` vs. `allowed`) is asserted in tests, not just documented, so a
  future caller cannot silently regress #1634's rejected bug (a bare `[]`
  indistinguishable from "checked, clean").
- The denominator (`checked`, `unresolved`) on `GET /internal/scopes` means a
  stale role assignment (pointing at a deleted unit, say) is visibly
  "unexamined," not silently dropped as if it were fine.

### Negative / Trade-offs

- One extra authorizer call per request on this seam (matches the memo's own
  cost estimate) — acceptable at the ~$150/month envelope with no new AWS
  infrastructure; this ADR adds no infrastructure of any kind.
- The registry cannot answer "every scope that exists" for an `unrestricted`
  (e.g. platform-admin) caller's picker — only what the authorizer explicitly
  returns in `refs`. Documented as a known limitation on `list_reachable_scopes`
  rather than worked around by inventing an enumeration the template has no
  business owning.
- Steps 1-2 have no consumer yet inside this repo (by design — `Reversible`,
  per the owner's build order) until an instance registers an authorizer and
  step 4 exists to call it; a plugin cannot usefully exercise this seam until
  both land.

### Neutral

- `ScopeAuthorizer` takes `permission_code` as a string, not a typed enum —
  matches `PermissionRule.permission_code`'s own shape; the template does not
  own or validate the vocabulary of codes, only the mechanism that checks
  them.

## Compliance

- **Contract.** `scope_authz.py`'s `register_scope_authorizer` /
  `authorize_scope` / `list_reachable_scopes`, mirroring
  `orchestration_authz.py`'s `register_workflow_scope_authorizer` /
  `authorize_workflow_scope` shape.
- **HTTP seam.** `routers/internal_scopes.py`, mounted in `main.py` under
  `/api/v1/internal/*`, dual-authenticated via `require_signed_principal`
  exactly as `owner_data_handlers.py` and `internal_agent_chat.py` are.
- **Tests.** `tests/test_scope_authz.py` covers the registry (bare-core
  fail-closed and its `resolved=False` distinguishability, a registered
  authorizer's real denial reporting `resolved=True`, ancestry-based
  broader-grant coverage, idempotent last-wins registration including that
  a later registration resets ancestry/describer rather than keeping stale
  ones, and the `checked`/`unresolved` denominator).
  `tests/test_internal_scopes_router.py` covers the same properties over real
  HTTP, plus the `permission_code` refusal that answers "a plugin asking
  about another plugin's data" and the opaque response shape.

## Related Decisions

- ADR-0002 — Core is the single data plane; a plugin has no other write path
  to the database, which is what makes Core-side enforcement structurally
  unbypassable rather than merely conventional.
- ADR-0004 — the generic CRUD layer's `permission_code` axis (#1606), which
  this ADR's scope axis ANDs with rather than replaces.
- ADR-0010 / ADR-0024 / ADR-0025 — the "instance registers, template ships a
  fail-closed default" seam shape, reused here for a fourth time.
- ADR-0017 §5 — `owner_scoped_service`, the sibling axis this ADR is not a
  replacement for: a table may need caller-identity scoping, hierarchy
  scoping, both, or neither.
- Issue #1607 — the decision record (options A/B/C, the owner's "Go with
  (B)", and the four-step build order this ADR implements steps 1-2 of).
