# ADR-0022: Product-domain modules are user-owned guests hosted in the core API

**Status:** Accepted
**Date:** 2026-07-26
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

An instance's **product-domain code** — its own models, routers, events,
schemas, tests, and DDL — legitimately lives in the **core API**. ADR-0002 is
explicit: the platform is the single data plane, *"the platform owns the data and
applications are guests; all data access goes through the Core API."* A sibling
(ADR-0007) holds no database; a plugin (ADR-0003) owns no data. So an instance's
shared canonical relational domain does not belong in a sibling repo or a plugin
— it belongs in the core DB/API, by the platform's own design.

But the ownership model had no *home* for it. Everything under `services/api/` is
**template-owned** in `core-manifest.json`. So an instance could not edit its own
domain code without the core-ownership guard blocking the commit, and
`biffo core upgrade` read every such edit as template drift. The generic platform
shell and the instance's product domain stayed tangled in the same owned tree.

**Driving case:** `tabsii-platform` — the `tabsii.*` schema (41 DDL-imported
tables: brands, leads, pipeline stages, units, onboarding, marketplace, KPIs)
with ~15 routers under `services/api/src/api/routers/`. Editing its domain events
tripped the guard, which surfaced the gap.

This is an **ownership-boundary** problem, not a data-architecture one: the data
is already in the right place. Three principle-violating "fixes" were considered
and rejected — move the domain to a sibling (violates ADR-0007: siblings own no
DB), make it a plugin that owns tables (violates ADR-0003: plugins own no data;
owner-scoped/ADR-0017 is a narrow carve-out, not a host for a product's
relational model), and per-sibling databases (contradicts ADR-0002's single-data-
plane thesis).

## Decision

Give instance product-domain code a first-class **user-owned prefix inside the
template-owned core API**, exactly as the manifest already does for
`services/api/migrations/versions/` (longest-prefix-wins):

1. **`services/api/src/api/domains/<name>/` is user-owned.** Declared in
   `core-manifest.json`'s `userOwned` list; longest-prefix-wins resolves it ahead
   of the template-owned `services/api/`. `db/imports/<name>/` (DDL-imported
   schemas) is already user-owned — `db/` is.

2. **A domain is discovered and mounted by a template-owned seam, so no
   per-instance edit of `main.py` is needed.** `api.routing.domain_router`
   (template-owned) globs `domains/<name>/` at startup and includes each domain
   package's exported `routers`. A domain keeps its **native paths** (no
   `/domains/<name>` namespacing), so a router relocated into this tree serves
   exactly the routes it did before — the API contract to siblings is unchanged.
   The base template ships no domain, so it mounts nothing.

3. **The `domains/` tree is seeded once** (an `__init__.py` + `README.md`) like
   `docs/ADR/`, then owned by the instance and never carried by an upgrade.

An instance relocates its domain files under `domains/<name>/` — mechanical, no
behaviour change. This honours all three data ADRs: the data stays in core
(0002 ✓), siblings are unchanged (0007 ✓), and plugins are untouched (0003 ✓).

## Options Considered

### Option A — Dedicated `domains/<name>/` tree, user-owned (chosen)

A clean, unambiguous subtree that is wholly the instance's.

**Pros:**
- `biffo core upgrade` gets an unambiguous boundary — everything under
  `domains/` is the instance's, everything else in `services/api/` is the
  template's. No file-by-file ambiguity.
- Mirrors the proven `migrations/versions/` carve-out exactly.
- The template-owned discovery seam means the instance never edits template-owned
  `main.py` to wire its routers — the guard never fights the instance's own
  product work.

**Cons:**
- One mechanical relocation per instance (routers/models move from
  `services/api/src/api/routers/` etc. into `domains/<name>/`).

### Option B — User-own the instance's existing files in place

Mark the scattered instance-added files under `services/api/src/api/` user-owned
where they already sit.

**Pros:**
- No relocation.

**Cons:**
- The boundary is ambiguous: the guard and the upgrade cannot cleanly tell a
  product-domain file from a template shell file that happens to share a
  directory. This is the #279-part-1 trap in another costume — a user-owned
  carve-out sitting exactly where template files live, which `core upgrade` would
  then propose deleting or conflict on. Rejected.

### Option C — Document the escape hatch only

Rely on the existing `Core-Divergence` trailer / `biffo.divergence.json` per file.

**Cons:**
- Doesn't solve the gap; every domain edit needs a manual divergence marker
  forever. It is a way to keep flagging *past* the problem, not to remove it.
  Rejected.

## Consequences

- Every instance has a standard, user-owned home for its product domain; the
  generic platform shell and the product domain are cleanly separated in the
  ownership model.
- Product-domain routers, models, and events are first-party trusted code —
  they ship real handlers (unlike a plugin's declarative `(method, path, table,
  operation)`), so the discovery seam simply *includes* them rather than
  synthesizing anything. A domain that fails to import raises at startup: a
  broken product domain should surface at deploy, not silently serve nothing.
- The core invariants still apply inside a domain: `TenantScopedModel` on every
  table (invariant #1), `require_tenant_context` on every route (invariant #2),
  `BiffoEvent` for every event (invariant #3), no DB client outside
  `services/api/` (invariant #4 — a domain *is* inside `services/api/`).

## Related Decisions

- **ADR-0002** — the API-only data-integration pattern this rests on: the core
  is the single data plane, so the product's relational domain belongs here.
- **ADR-0006** — the ownership/upgrade model this carve-out extends (same
  longest-prefix-wins mechanism as `migrations/versions/`).
- **ADR-0003 / ADR-0007** — plugins own no data, siblings hold no DB; this ADR is
  why a product's relational domain is *neither* a plugin nor a sibling.
