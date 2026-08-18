# ADR-0029: Plugin scope-authorization registry — an opaque-reference seam, Core-enforced

**Status:** Accepted (steps 1-2 of 4; step 3 is instance-owned, step 4 deferred).
Amended 2026-08-17 (issue #1644) to add a second, service-entitlement axis
after an independent prosecution found the original text's central claim
false — see "Amendment" below.
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
`permission_code` on **two axes**, both necessary, neither sufficient alone
(amended by issue #1644 — see "Amendment" below for why the original
single-axis text here was wrong):

1. Against the caller's own `AuthenticatedUser.permissions` first (the #1606
   axis) — a forwarded caller who holds no grant for that `permission_code`
   at all is refused there, regardless of which plugin is asking.
2. Against the **asking service's own entitlement, as declared by this
   instance** — `register_scope_authorizer(..., entitlements={"system:<plugin>":
   frozenset({"<code>"})})`, consulted via `scope_authz.service_is_entitled`
   (amended by issue #1653; see the second Amendment below for why the
   original manifest-derived source was wrong). The map is keyed by
   `ServicePrincipal.logical_names`, and an instance that declares no map
   entitles nobody.

Axis 1 alone does **not** make "a plugin asking about another plugin's data"
refuse itself — it says nothing about which plugin is asking, only what the
human caller may do. Axis 2 is what closes that gap.

**Be precise about what axis 2 does and does not bound.** It is a check
against a map **the instance wrote**, and nothing more. It does not verify
that a code "belongs to" the plugin in any structural sense — no namespace is
enforced, no ownership is derived, and an instance is free to entitle any
plugin to any code in its own vocabulary. What it structurally rules out is
narrower and is the whole point: a plugin **cannot entitle itself**, because
no artefact the plugin authors reaches this decision. The residual trust
boundary is stated plainly and is not a bound this ADR claims to have
closed — see "Non-goals" below.

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

### 5. Non-goals (issue #1653) — stated so nobody reads a bound in later

**Reviewing an instance's own entitlement map is not this seam's job, and is
deliberately left to the third-party publishing gate** (ADR-0003's community
publish flow and its security CI, both still aspirational). An instance that
entitles `system:marketing` to `workflows.manage` has over-granted its own
codes to a plugin it chose to install — that is the operator's decision to
make, and an authorization decision belongs to the party that owns both the
vocabulary and the install. Nothing here second-guesses it, and nothing here
should be read as claiming to.

**The residual trust boundary, stated honestly:** _the operator installed
this plugin and wrote the entitlement map._ That is defensible. What was not
defensible, and is what #1653 removed, is a docstring implying a structural
bound over what was in fact an honour system among plugin manifests — a
plugin could name any code it liked in its own `biffo.plugin.json` and
thereby entitle itself. The bound this seam now genuinely has is narrower and
real: **the plugin is not the source of the entitlement**, so it cannot grant
itself one.

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
  `authorize_scope` / `list_reachable_scopes` / `service_is_entitled`,
  mirroring `orchestration_authz.py`'s `register_workflow_scope_authorizer` /
  `authorize_workflow_scope` shape.
- **HTTP seam.** `routers/internal_scopes.py`, mounted in `main.py` under
  `/api/v1/internal/*`, dual-authenticated via `require_signed_principal`
  exactly as `owner_data_handlers.py` and `internal_agent_chat.py` are.
- **Tests.** `tests/test_scope_authz.py` covers the registry (bare-core
  fail-closed and its `resolved=False` distinguishability, a registered
  authorizer's real denial reporting `resolved=True`, ancestry-based
  broader-grant coverage, idempotent last-wins registration including that
  a later registration resets ancestry/describer/**entitlements** rather than
  keeping stale ones, the `checked`/`unresolved` denominator, and
  `service_is_entitled`'s fail-closed default).
  `tests/test_internal_scopes_router.py` covers the same properties over real
  HTTP, plus both `permission_code` axes (a caller with no grant at all;
  a caller who legitimately holds the code but whose asking plugin the
  instance never entitled; a caller whose asking plugin IS entitled; an
  instance that registered no entitlements at all) and the opaque response
  shape. `test_plugin_cannot_entitle_itself_by_declaring_a_foreign_code`
  is #1653's Case C probe: a plugin manifest naming a foreign
  `permission_code` on its own table changes nothing, because the manifest is
  no longer an input.

## Amendment 2026-08-17 (issue #1644) — the ask/list seam had only one axis

**Finding.** An independent prosecution of PR #1642 (this ADR's own
implementation) registered a fake `ScopeAuthorizer` — exactly what a real
instance would do — and drove the shipped router directly. An hq-admin
holding both `marketing.links.manage` and `workflows.manage` got the **full**
scope hierarchy (refs, human labels, depth, parent chain) back when the
**marketing** plugin's own signed service principal asked about
`workflows.manage` — a `permission_code` belonging to an entirely different
subsystem, nothing to do with marketing's own product surface.

The router's `_require_permission_code` checked only
`permission_code not in caller.user.permissions` — axis 1 above. Nothing
checked which plugin the code belonged to. The claim this document made in
"The HTTP seam" section — *"this is what makes 'a plugin asking about
another plugin's data' refuse itself: the check is always against the
caller's own grant, never the calling service's identity"* — was false for
exactly the caller population most likely to hold multiple codes (an HQ
admin, a brand manager with cross-domain grants), which is also the
population most likely to be asked about by more than one plugin. The
repo's own `test_forwarded_caller_without_the_permission_code_is_refused`
was headed "case 4: asking about another plugin's data → refused" but only
ever exercised a caller with **zero** permissions — a materially weaker case
that happened to pass for an unrelated reason (axis 1 alone refuses a caller
with no grant regardless of which plugin asks) and never exercised the
cross-domain disclosure at all.

**Fix — SUPERSEDED 2026-08-18 by the #1653 amendment below; retained for the
record, and neither function named here still exists.**
`_require_permission_code` was made to also require that the asking service
be **entitled** to `permission_code`: its own installed `biffo.plugin.json`
had to declare that code on at least one of its own tables' CRUD
`permissions` blocks (`PermissionRule.permission_code`, the existing #1606
field — `_plugin_permission_codes` / `_service_entitled_permission_codes` in
`routers/internal_scopes.py`). The reasoning was issue #744's recurring class
(seven prior instances of a list drifting from what manifests already state):
derive entitlement from a declaration every plugin already makes rather than
add a second document. **What that reasoning missed** is that the plugin
authors the manifest, so the derivation read a document the asking party
controls — and that `permission_code` is precisely the field a portable
plugin must leave empty, so the derived answer was "nothing" for every plugin
in the estate. See below.

**The finding above still stands in full.** Axis 1 alone genuinely does not
refuse a cross-plugin ask, and the disclosure the prosecution demonstrated
was real. Only the *source* of axis 2 changed.

**Why not `scope_scoped_service.allowed_principals` (step 4)?** That field is
explicitly deferred (see "4. Deliberately NOT built here" above) and, when
built, gates **table** access for the write-side enforcement path — a
different seam from the ask/list projections this ADR covers. Building it
now would not close this gap even if it existed today, and step 4 remaining
deferred does not leave this one open: the fix here is scoped entirely to
`routers/internal_scopes.py`'s own gate function and introduces no new
one-way-door commitment.

**What did not change.** The bare-core / registered-and-denied distinction
(`resolved` vs `allowed`) and the `checked`/`unresolved` denominator are
untouched — both were re-verified against the amended code and remain exactly
as this document originally described.

## Amendment 2026-08-18 (issue #1653) — entitlement was sourced from the one field a portable plugin must not use

**Superseded by this amendment:** the previous amendment's "Fix" paragraph,
and its claim that deriving entitlement from `PermissionRule.permission_code`
"added no new hand-maintained ownership list". That was true and beside the
point.

**Finding.** `permission_code` is the DB-held, instance-specific half of
`PermissionRule`; `required_role` is the portable half, and #1607's founding
constraint is that a plugin must never learn the instance's vocabulary —
"repeating the `founder` hardcoding mistake one layer deeper". So #1644
derived entitlement from **the one field a portable plugin is designed not to
use**. Two consequences, both measured against `origin/dev` at `85ae8c69`:

- All **15** `biffo.plugin.json` manifests in the estate (this repo 3,
  `biffo-platform` 5, `tabsii-platform` 4, one each in the three plugin
  repos) declare **zero** `permission_code`s. Every plugin was therefore
  entitled to nothing, and the seam was unusable rather than merely strict.
  That is not an oversight anyone forgot to fix — it is #1606 working as
  designed.
- The only route to entitlement was for a plugin to name an instance-specific
  code in its own manifest, i.e. to stop being portable in order to close a
  security gap. `biffo-plugin-marketing#73` and #1607 step 3 were both blocked
  behind that trade.

And the trust direction was still wrong in the same way #1644 set out to fix:
a plugin authors its own manifest, so a plugin could write **any** code into
it — including another domain's — and entitle itself. #1644 moved the leak
from "no check" to "a check over a document the attacker writes".

**Fix.** Entitlement moved out of the plugin manifest and into
`register_scope_authorizer(..., entitlements=...)` — see Decision §2 axis 2.
`_plugin_permission_codes` and `_service_entitled_permission_codes` are
deleted from `routers/internal_scopes.py`; `_require_permission_code` calls
`scope_authz.service_is_entitled` instead. No manifest schema change, no CLI
zod change, no Python SDK mirror change, no migration, and no existing
declaration to migrate — there were none.

**Why the instance, and why this was free this week.** The instance already
owns the vocabulary: `caller.user.permissions` comes from
`provider.resolve_permissions` (ADR-0012's identity seam,
`middleware/auth.py`), resolving codes the instance's own DDL seeds. The
instance also chose to install the plugin. It is the only party holding both
halves of "which plugin may ask about which code". And
`register_scope_authorizer` had **zero callers** estate-wide when this
landed — verified by grep across all sixteen repos in the estate, hits only
in this repo's own tests and this document — so changing its signature broke
nothing. #1607 step 3 adds the first real caller; after that this is a
breaking change to a security seam in every instance that has registered one.

**A behaviour change worth stating.** Bare core (no authorizer registered)
also entitles nobody, so both routes now answer `403` where they previously
answered `200` with `resolved=false`. The `resolved` distinction (#1634) is
untouched in `scope_authz` and still asserted in `tests/test_scope_authz.py`,
but it is no longer reachable over HTTP. This is strictly more conservative —
an unentitled plugin learns nothing, not even the instance's registration
state — and the router docstring says so plainly rather than leaving a
response field that looks exercised and is not.

**Diagnosability.** The `403` detail stays generic on both refusal paths;
that opacity is what keeps the seam unprobeable and it is deliberate. A
client-visible hint was considered and **rejected**. `biffo plugin info
<name>` carries the explanation instead, because that is where a plugin
author looks: it states that entitlement is instance-declared, prints the
exact `entitlements={"system:<name>": frozenset({"<code>"})}` line to ask an
operator for, and says plainly that the CLI cannot read the live map — it is
Python evaluated at the instance's import time, and a CLI-side re-derivation
would be a second authority that drifts from the one that acts (class #1362,
eleven recorded instances).

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
