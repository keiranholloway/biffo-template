# Implementation Plan: Hierarchy-Scoped Workflows (Tenant / Brand / Region / Unit)

**Status:** Draft
**Date:** 2026-07-26
**Source PRD:** inline (this conversation) — no separate ticket
**Data model sources consulted:** `/home/keiran/tabsii-data-model-design/fk-relationships.md`
(matches deployed DDL exactly); `tabsii-platform/db/imports/tabsii/003_tenancy_roles.sql`,
`004_hierarchy_graph_a.sql`, `011_rls_policies.sql`, `018_rbac_enforcement.sql`,
`024_ancestor_read_visibility.sql`, `025_unit_owner_ancestor_grants.sql`;
`services/api/src/api/models/hierarchy.py`; `services/api/src/api/events/registry.py`;
`tabsii-crm/apps/frontend/src/lib/scope.ts` and its Brand/Region/Unit screens.

## Context

Today a workflow definition matches by `(trigger_source, trigger_detail_type)` plus
an optional flat, exact-match `trigger_filter` predicate (`{"status": "won"}`).
There is no concept of "this rule applies to Brand X and everything under it"
— an org running dozens of brands, each with regions and units, cannot say
"notify this brand's ops team whenever any of its units onboards" without one
identical rule per unit. The ask: let a rule be authored at Tenant, Brand,
Region, or Unit level, where a higher level automatically covers everything
beneath it.

**Research finding that reshapes the plan**: no such "higher level covers
lower levels" logic exists anywhere in tabsii today. `tabsii.fn_authorized`
(the RLS precedent, `db/imports/tabsii/011_rls_policies.sql` +
`018_rbac_enforcement.sql`) is **exact-match only** — a brand-scoped role
assignment does not automatically satisfy a region/unit check. A narrow,
**upward-only, read-only** exception was added in `024_ancestor_read_visibility.sql`
(#58) so a region/unit-scoped user can *read* their ancestor brand row — not
general authorization, and not the downward direction this feature needs.
This is genuinely new ground, not a reuse of an existing mechanism — though
`fn_authorized`'s parameter shape (`p_tenant_id, p_brand_id, p_region_id,
p_unit_id`) and its ancestor-join idiom (`regions.brand_id`, `units.region_id`)
is the right pattern to mirror.

## Current state (confirmed by reading the code)

- **Hierarchy** (`tabsii-platform/services/api/src/api/models/hierarchy.py`,
  DDL in `db/imports/tabsii/004_hierarchy_graph_a.sql`): `Tenant → Brand →
  Region(optional) → Unit`. `Region.brand_id` (not null). `Unit.brand_id`
  (not null) + `Unit.region_id` (**nullable** — a unit may sit directly under
  a brand with no region). A separate, parallel "Graph B" (`Territory`/
  `Franchisee`, both keyed by `brand_id` only) is commercial/legal, not
  operational, and is **out of scope** for this feature (the ask is Tenant/
  Brand/Region/Unit only).
- **Event payloads carrying hierarchy ids** (`services/api/src/api/events/registry.py`
  + emit sites): `lead.captured` and `marketplace.application_submitted`
  carry `brand_id` only. `unit.onboarded` (`routers/onboarding.py`) carries
  `brand_id` **and** `unit_id` — but **not** `region_id`, even though the
  unit may belong to one. This is a real gap a scope resolver must close by
  looking the region up, not by assuming the payload always has it.
- **`WorkflowDefinition`** (`biffo-template/services/api/src/api/models/orchestration.py`):
  `tenant_id, name, trigger_source, trigger_detail_type, trigger_filter (JSON),
  action_type, action_config (JSON), enabled, schedule_config (JSON)`. No
  brand/region/unit concept anywhere — confirmed also absent from the portal
  builder page and `WorkflowDefinitionEventPayload`.
- **`dispatch_event`** (`biffo-template/services/api/src/api/orchestration.py`):
  matches enabled definitions on `(trigger_source, trigger_detail_type)`,
  then narrows with `_matches_trigger_filter` (flat exact-match over the raw
  event payload dict — no lookups, no hierarchy).
- **Extensibility precedent to mirror**: the Event Registry
  (`events/registry.py`) is a generic, template-owned registration mechanism
  — `register_event(EventType(...))` called at *instance* module import time,
  with the template shipping zero events of its own for a product domain.
  The same shape (a registry an instance populates, the template ships a
  no-op default) is the right seam for a "scope resolver."
- **tabsii-crm is not a thin stub** — contradicts the "maybe build it there
  instead" framing taken at face value. It already has `BrandsScreen.tsx`,
  `RegionsManager.tsx`, `UnitsHierarchy.tsx`, `AddBrandWizard.tsx`, and its
  own client-side `lib/scope.ts` whose `RoleAssignment` type already carries
  `tenant_id | brand_id | region_id | unit_id | franchisee_id` — with a code
  comment stating the intended nav hierarchy "Platform → Tenant → Brand →
  (Region → Unit, later)". It is, per ADR-0007, still DB-less — everything
  it shows comes from tabsii-platform's Core API. It **cannot** host an
  execution engine (no DB, no background dispatch Lambda) but **can** host a
  new, scope-aware *authoring surface* that calls the same Core API the
  portal already does.
- **`services/api/src/api/domains/`** is the ADR-0022 user-owned carve-out
  for exactly this kind of instance product-domain code — but tabsii's actual
  brand/region/unit code (`models/hierarchy.py`, `routers/brands.py`,
  `routers/regions.py`, `routers/onboarding.py`) still lives in the older,
  pre-carve-out locations, not migrated into `domains/tabsii/`. Not this
  feature's problem to fix, but the new scope-resolver registration code
  will live alongside that existing (non-`domains/`) tabsii code, matching
  what's actually there today rather than a convention tabsii hasn't adopted.

## Architecture decision

**The scoping *capability* is a generic, template-owned extension to the
orchestration engine** (Core-owned data + matching logic in `biffo-template`,
reusable by any Biffo instance, not tabsii-specific) — **tabsii supplies its
own hierarchy knowledge via a registered resolver** (tabsii-owned code, same
"instance registers, template ships a no-op default" shape as the Event
Registry) — **and tabsii-crm gains a genuinely new, scope-aware authoring
surface**, calling the same Core API the portal already uses rather than
duplicating the engine (which ADR-0007's DB-less sibling constraint rules out
anyway).

This is a large, three-repo epic. It should be filed and tracked as such —
mirroring the trigger-consolidation precedent (biffo-template epic #210 +
children #216–219) — not attempted as one PR. The rest of this plan is
organized as phases matching that shape.

## Design

### Phase 1 — Generic scoping capability (biffo-template, Core feature)

1. **`WorkflowDefinition.scope`** (JSON, nullable): `{"level": <str>, "id": <str>}`.
   `None` (every existing definition) = unscoped/tenant-wide — today's
   behavior, unchanged. `level` is an opaque string the template never
   hardcodes (no "brand"/"region"/"unit" enum in template code) — what
   levels exist, and their ordering, is entirely defined by whichever
   resolver an instance registers.
2. **Scope resolver registry** (new module, e.g.
   `services/api/src/api/scope_resolvers.py`), mirroring `events/registry.py`'s
   shape:
   ```python
   ScopeResolver = Callable[
       [AsyncSession, str, str, dict[str, Any]],  # db, source, detail_type, payload
       Awaitable[dict[str, str | None]],           # {"brand": id, "region": id, "unit": id, ...}
   ]
   ```
   `register_scope_resolver(resolver, levels=(...))` — registered once, at
   an instance's own domain-module import time. The template ships a default
   no-op resolver: it returns only the literal ids already present in the
   event payload under level-named keys (e.g. `payload.get("brand_id")`),
   with **no** database lookups — so an instance with no registered resolver
   still gets correct (if less powerful) single-level matching, and nothing
   breaks for an instance that never adopts this feature.
3. **`dispatch_event`/`_claim_run`** gains a scope check alongside the
   existing `_matches_trigger_filter`:
   ```python
   async def _matches_scope(db, scope, source, detail_type, payload) -> bool:
       if scope is None:
           return True
       chain = await resolve_scope_chain(db, source, detail_type, payload)
       return chain.get(scope["level"]) == scope["id"]
   ```
   Because the resolver always returns the **full** ancestor chain regardless
   of how granular the triggering event itself is, a Brand-scoped definition
   matches a Region or Unit event under that brand for free — this single
   function is what delivers "higher level covers everything beneath."
4. **`WorkflowDefinitionBody`/`WorkflowDefinitionResponse`** gain `scope`,
   validated shape-only in the template (non-empty `level`/`id` strings) —
   the template cannot validate that a given `level`/`id` pair is a real,
   existing brand/region/unit; that is the resolver-owning instance's job
   (Phase 2).
5. **New catalog data**: the `/catalog` endpoint gains the registered
   resolver's `levels` tuple (empty if none registered), so the portal can
   render a generic level dropdown without hardcoding level names either.
6. **Portal**: a minimal, generic "Scope (advanced, optional)" control —
   level `<select>` (from the catalog's levels) + a free-text id input. This
   is deliberately unpolished (no brand/region/unit tree, no name lookup) —
   the polished picker is Phase 3's job, in tabsii-crm, which already has the
   hierarchy UI components to build one from.
7. **New ADR** (next number after 0023): why a resolver-registry seam rather
   than hardcoding a hierarchy shape into the template (every instance's org
   structure differs, or may not exist at all), and why matching happens in
   Core (`dispatch_event`, which already touches the DB) rather than in the
   plugin (ADR-0002 boundary).

### Phase 2 — tabsii's own resolver (tabsii-platform)

1. A new tabsii-owned module (next to `models/hierarchy.py`) registers a
   resolver with `levels=("tenant", "brand", "region", "unit")` at import
   time. Given a payload:
   - If `unit_id` is present but `region_id` is not (the `unit.onboarded`
     gap), looks up `Unit.region_id`/`Unit.brand_id` by `unit_id` — the
     resolver has `db` precisely so this lookup is possible without
     violating ADR-0002 (it runs inside Core, never the plugin).
   - If only `brand_id` is present (`lead.captured`,
     `marketplace.application_submitted`), the chain is just `{"tenant":
     tenant_id, "brand": brand_id}` — region/unit stay `None`, and a
     region/unit-scoped definition correctly does not match a brand-level
     event (a brand event has no region/unit to match against — this is
     expected: scoping is about which events a rule *can* apply to, not a
     promise every rule fires on every event type).
   - Tenant level: `chain["tenant"]` is always the event's own `tenant_id`
     (ADR-0001), so a Tenant-scoped definition is exactly today's unscoped
     behavior restated as an explicit level, not a new concept — worth
     confirming with the user whether "Tenant level" should be a real,
     selectable scope value or just what `scope: null` already means (see
     Open Questions).
2. New Alembic migration (or additive DDL) for `WorkflowDefinition.schedule_config`-style
   columns is not needed here — `scope` is added once, in Phase 1's
   biffo-template migration, carried by `biffo core upgrade` the same way
   every prior orchestration-engine column has been.
3. Tests: resolver correctly fills in region for a unit missing it, returns
   partial chains for brand-only events, and a Brand-scoped workflow fires
   for that brand's unit/region events while a sibling brand's events don't
   match.

### Phase 3 — Scope-aware authoring surface (tabsii-crm)

1. A new screen (e.g. `AutomationsScreen.tsx`) alongside the existing
   Brands/Regions/Units screens, calling the **same** Core API endpoints the
   portal builder already uses (`/api/v1/orchestration/workflows`) — no new
   engine, no new API surface duplicated, per ADR-0007.
2. **The real new work here is authorization, not UI**: today those
   endpoints are `require_admin`-gated (all-or-nothing platform admin). A
   brand manager using tabsii-crm needs to create/see workflows scoped to
   *their own* assignment (and narrower) only — a new, scoped permission
   check mirroring `fn_authorized`'s shape (`p_brand_id`/`p_region_id`/
   `p_unit_id` against the caller's `RoleAssignment`), enforced against the
   *submitted* `scope` field. This is a security-sensitive, non-trivial
   piece of design in its own right (which endpoints, which HTTP verbs, what
   "create a workflow scoped to a level the caller doesn't have" returns,
   whether a lower-scoped user can even see tenant/brand-wide rules that
   also affect them) and should get its own focused design pass, not be
   waved through as "just reuse `require_admin`."
3. The polished picker: brand → region → unit cascading selects, built from
   tabsii-crm's *existing* `BrandsScreen`/`RegionsManager`/`UnitsHierarchy`
   data-fetching, replacing the generic free-text level/id pair from Phase 1
   for this surface only (the portal keeps the generic version).

## Data model mapping

| Requirement | Column/field | Core API surface | Resolver/UI surface |
|---|---|---|---|
| Author a scope | `WorkflowDefinition.scope` | `WorkflowDefinitionBody.scope` | generic picker (portal) / tree picker (tabsii-crm) |
| Resolve an event's ancestry | (no new column — computed) | `resolve_scope_chain` | tabsii's registered resolver, `Unit.region_id`/`brand_id` lookups |
| Match hierarchy-aware | (matching logic only) | `_matches_scope` in `dispatch_event` | n/a |
| Scoped, non-admin authoring | (existing tables — `RoleAssignment`) | new scoped-permission check on the workflows router | tabsii-crm `AutomationsScreen` |

## Milestones

Recommend filing as an epic (biffo-template) with child issues per phase,
same shape as the trigger-consolidation work (#210/#216–219):

1. **Epic + ADR** — file the tracking epic, write the new ADR capturing the
   resolver-registry decision and the Phase 3 authorization design question
   as an explicitly open item.
2. **Phase 1 (biffo-template)** — `scope` column + migration, resolver
   registry + default no-op resolver, `_matches_scope` in `dispatch_event`,
   catalog `levels`, generic portal picker. Tests: unscoped unchanged,
   default resolver matches literal payload ids only, `_matches_scope`
   hierarchy semantics against a fake multi-level resolver.
3. **Phase 2 (tabsii-platform)** — tabsii's resolver (with the unit→region
   lookup), distributed via `biffo core upgrade`. Tests: the three gap
   cases above (unit missing region, brand-only event, tenant-wide).
4. **Phase 3 (tabsii-crm)** — scoped-permission design doc/decision first
   (a genuine sub-design, not just an implementation task), then the new
   endpoint authorization, then `AutomationsScreen` UI.
5. **E2E verification** — a Brand-scoped workflow fires for that brand's
   real unit-onboarding event on a live deployment; a sibling brand's event
   does not fire it. Manual, like every prior milestone in this engine.

## Testing plan

Unit tests per phase as above, matching the existing suites' conventions
(`test_orchestration_admin_router.py`, `test_internal_orchestration_router.py`,
a new tabsii-side resolver test file). Phase 3's authorization logic needs
its own dedicated test file given its security sensitivity — allow/deny
matrix across caller-scope × definition-scope combinations, not just happy
path. Manual E2E required per `[[e2e-testing-required]]`, as with every
prior increment of this engine.

## Open questions / explicitly deferred

- **Is "Tenant level" a real selectable scope, or just what `scope: null`
  already means?** Leaning toward the latter (no new concept needed) but
  worth confirming — if the user wants an explicit, visible "Tenant" option
  in the UI (rather than an implicit "no scope set"), that's a small UI-only
  addition, not a data-model change.
- **Franchisee dimension** (Graph B: `Territory`/`Franchisee`) is a separate,
  parallel hierarchy from the operational Brand/Region/Unit one and is
  explicitly out of scope for this ask — flagged in case it's wanted later
  (the resolver-registry design accommodates it as an additional level with
  no template change needed).
- **Phase 3's authorization model** is deliberately left as a design
  question for its own pass, not pre-decided here — it's the part of this
  epic with real security consequences and deserves focused scoping once
  Phases 1–2 exist to build against.
- **Multiple scopes per definition** (e.g. "this brand OR that brand") —
  out of scope; one `{level, id}` per definition, matching how `schedule_config`
  and `trigger_filter` are similarly single-shot today.

## Rollout

Phase 1 in `biffo-template` (Core API + portal, both template-owned per
`core-manifest.json`), distributed to `tabsii-platform` via `biffo core
upgrade`. Phase 2 lands directly in `tabsii-platform` (tabsii-owned resolver
code). Phase 3 lands in `tabsii-crm`, a separate repo, consuming the
(by-then-upgraded) Core API — no `biffo core upgrade` there since it's a
sibling, not a template-derived core. Each phase gets its own PR(s), get CI
green, merge, verify — no phase merges before the one it depends on is live.
