# ADR-0024: Hierarchy-scoped workflows — a resolver-registry seam, matched in Core

**Status:** Accepted
**Date:** 2026-07-26
**Deciders:** Core team

---

## Context

A workflow definition (`services/api/src/api/models/orchestration.py`)
matches an incoming event by `(trigger_source, trigger_detail_type)` plus an
optional flat, exact-match `trigger_filter`. There is no way to author a rule
at a coarse organizational level that automatically covers everything
beneath it — e.g. "notify this brand's ops team whenever any of its units
onboards" requires one identical rule per unit today. The concrete ask
(docs/implementation/0003-hierarchy-scoped-workflows) is Tenant / Brand /
Region / Unit scoping for a tabsii-style instance, where a Brand-scoped rule
should fire on that brand's Region and Unit events too, without one rule per
descendant.

**The template itself has no concept of an organizational hierarchy at all.**
Tenant/Brand/Region/Unit is tabsii's product domain
(`services/api/src/api/models/hierarchy.py` in the tabsii-platform instance,
not this repo) — a different instance might have no hierarchy, a two-level
one, or a completely different shape. The orchestration engine
(`services/api/src/api/orchestration.py`), by contrast, is Core-owned
(ADR-0002) and reusable across every Biffo instance. This ADR is about how a
Core-owned engine gains a generic scoping *capability* without the template
ever encoding one specific instance's hierarchy into it.

## Decision

**A generic, template-owned scope-resolver registry** — the same
"instance registers, template ships a no-op default" shape as the Event
Registry (ADR-0010, `events/registry.py`) — with **matching performed inside
Core's `dispatch_event`**, not the orchestrator plugin.

1. **`WorkflowDefinition.scope`**: nullable JSON, `{"level": <str>, "id":
   <str>}`. `None` (every existing definition) means unscoped/tenant-wide —
   today's behavior, unchanged. `level` is an opaque string the template
   never hardcodes; what levels exist and their ordering is defined entirely
   by whichever resolver an instance registers.

2. **`services/api/src/api/scope_resolvers.py`** (new template module):

   ```python
   ScopeResolver = Callable[
       [AsyncSession, str, str, dict[str, Any]],   # db, source, detail_type, payload
       Awaitable[Mapping[str, str | None]],         # {"brand": id, "region": id, ...}
   ]
   ```

   `register_scope_resolver(resolver, levels=(...))` is called once, at an
   instance's own domain-module import time — mirroring `register_event`'s
   idempotent, last-registration-wins shape (there is exactly one active
   resolver, because an instance has exactly one hierarchy shape, unlike
   events which are keyed by type). The template ships a default resolver
   that reads only literal `f"{level}_id"` keys already present on the event
   payload, with no database access — an instance that registers nothing
   still gets correct, if less powerful, single-level matching.

3. **`dispatch_event` gains a scope check**, resolved lazily and cached once
   per event: the ancestor chain (`resolve_scope_chain`) is computed at most
   once, and only the first time a candidate definition actually declares a
   `scope` — the common case (Phase 1 ships with nothing scoped yet) pays no
   extra resolver or database cost. `scope_matches_chain` is then a pure,
   synchronous check per definition against that one cached chain. Because
   the resolver always returns the event's **full** ancestor chain regardless
   of how granular the triggering event itself is, a Brand-scoped definition
   matches a Region or Unit event under that brand for free — this is the
   entire mechanism that delivers "a higher level covers everything
   beneath it."

4. **Shape-only validation in the template**
   (`WorkflowDefinitionBody`/`_validate_scope`): non-empty `level`/`id`
   strings, and — only when an instance has registered a resolver at all —
   `level` must be one of its declared levels. The template has no way to
   validate that a given id is a real, existing brand/region/unit; that
   belongs to the resolver-owning instance (tabsii-platform#228), not here.

## Options Considered

### Option A — Hardcode Tenant/Brand/Region/Unit into the template

**Pros:** simplest possible implementation; no registry indirection.
**Cons:** bakes one instance's product domain into Core-owned, cross-instance
code — directly against the shape every other extensible concern in this
engine already uses (events, action types). An instance with no hierarchy, or
a different one (e.g. a franchisee/territory shape, which tabsii itself has
as a *separate*, parallel graph — see docs/implementation/0003 "Open
questions"), would carry dead fields or need its own fork of the matching
logic.

### Option B — Matching lives in the orchestrator plugin, not Core

**Pros:** keeps `dispatch_event` unchanged; scoping logic stays with the
thing that "acts."
**Cons:** violates ADR-0002 directly — a plugin has no database access, and
resolving a scope chain can require one (tabsii's real gap: `unit.onboarded`
carries `brand_id` + `unit_id` but not `region_id`; a resolver must look the
unit up to fill in its region). Pushing the check to the plugin would either
strip it of the DB lookup it needs, or require the plugin to call back into
Core for it — more moving parts than performing the check where the data
access is already legal.

### Option C — Resolver registry, matched in Core (chosen)

**Pros:** the registry shape is a proven precedent (ADR-0010) that downstream
teams already understand; matching runs where `dispatch_event` already owns
the database session, so a resolver needing a lookup (tabsii's
region-from-unit gap) is unremarkable, not a boundary violation; the default
no-op resolver means zero behavior change for every instance that doesn't
adopt this feature, template-wide.
**Cons:** an instance must write and register its own resolver to get real
ancestry-aware matching (Phase 2, tabsii-platform#228) — the template alone
only gets literal-payload-id matching via the default resolver.

## Rationale

Option C is the only one that keeps the Core/plugin boundary intact (ADR-0002
requires database access to live in Core) while keeping the template itself
free of any specific instance's organizational model — exactly the
extension-point pattern ADR-0010 already established for triggers. Option A
was rejected for coupling a Core-owned, cross-instance engine to one
instance's product domain. Option B was rejected outright: it requires either
violating ADR-0002 or adding a Core round-trip the resolver-in-Core design
gets for free.

## Consequences

### Positive

- Zero behavior change for every existing workflow definition (`scope` is
  `None`) and for every instance that never registers a resolver (the
  default resolver's literal-payload-id matching is a strict superset of
  today's unscoped behavior — it's simply never consulted unless a
  definition sets `scope`).
- A Brand-scoped rule automatically covers that brand's Regions and Units,
  with no per-descendant duplication, the moment tabsii registers a resolver
  that knows how to compute the ancestor chain (Phase 2).
- The template stays instance-agnostic: no "brand"/"region"/"unit" string
  appears anywhere in `biffo-template`'s own source.
- The common (unscoped) dispatch path pays no resolver or database cost —
  `scope_chain` is computed at most once per event, and only lazily, the
  first time a candidate definition needs it.

### Negative / Trade-offs

- An instance gets no ancestry-aware matching until it writes its own
  resolver — the template's default is deliberately weak (literal payload
  keys only, no lookups) so it never has to guess at an instance's schema.
- One resolver per instance, not a registry keyed by event type or level —
  an instance with a genuinely branching or multi-hierarchy shape (tabsii's
  own separate Territory/Franchisee graph, explicitly out of scope for this
  feature) would need one resolver that understands all of it, not several
  independent ones.

### Neutral

- The portal's authoring UI for `scope` (Phase 1) is deliberately generic — a
  level `<select>` from `scope_levels` plus a free-text id field, not a
  polished brand/region/unit tree. A polished, hierarchy-aware picker is
  tabsii-crm's job (tabsii-crm#100), built from screens that repo already
  has and the portal does not.

## Compliance

- **Contract validation.** `WorkflowDefinitionBody.scope` is validated on
  create/update (`_validate_scope`,
  `services/api/src/api/schemas/orchestration.py`) — a missing/empty
  `level`/`id`, or a `level` not among a registered resolver's declared
  levels, is a 422.
- **Lazy, cached resolution.** `dispatch_event`
  (`services/api/src/api/orchestration.py`) computes `scope_chain` at most
  once per event and only when a candidate definition's `scope is not None`.
- **No database access outside Core.** The `ScopeResolver` type takes an
  `AsyncSession` and runs only inside `dispatch_event`, itself Core-owned
  (ADR-0002) — a plugin never touches it.
- **Tests.** `test_scope_resolvers.py` covers the registry (idempotent
  registration, the default resolver's literal-key behavior, hierarchy
  matching semantics including "higher level covers lower levels" and
  sibling-brand non-matching). `test_orchestration_admin_router.py` and
  `test_internal_orchestration_router.py` cover the API contract
  (validation, round-tripping `scope`) and the end-to-end dispatch-time
  match/no-match behavior against a fake registered resolver.

## Related Decisions

- ADR-0002 — Core is the single data plane; this ADR's matching logic runs
  inside Core specifically because a resolver may need a database lookup.
- ADR-0010 — the event registry's "instance registers, template ships a
  no-op default" shape, reused here for hierarchy scope resolution.
- ADR-0022 — product-domain modules (an instance's own hierarchy, e.g.
  tabsii's `models/hierarchy.py`) are user-owned guests; this ADR is the
  template-owned seam such a module plugs into, not a change to that
  ownership boundary.
