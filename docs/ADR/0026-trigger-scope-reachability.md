# ADR-0026: Trigger scope-reachability — reject a scope a trigger's payload can never carry

**Status:** Accepted
**Date:** 2026-07-26
**Deciders:** Core team

---

## Context

Phases 1–3 (ADR-0024, ADR-0025) let a workflow definition carry an optional
hierarchy `scope` (`{"level": <str>, "id": <str>}`) and let a scoped,
non-admin caller author within their own reach. Nothing stopped an author —
admin or scoped — from binding that scope to a trigger whose payload could
never carry an id at that level. `demo.requested`'s payload
(`{demo_request_id, email, company}`) carries no `brand_id`/`region_id`/
`unit_id` at all: a Brand-scoped workflow on it creates successfully (Phase
3's authorization is only about *who* may act on a scope, not whether the
resulting rule can ever fire), but `scope_matches_chain` (ADR-0024) can never
see a brand id in that event's resolved chain, so the workflow silently never
runs. This was raised directly against a real, live example — a "Demo
Requested" automation authored inside a brand's own scope in tabsii-crm that
looked configured but was structurally dead.

This is not an authorization gap: tracing `resolve_scope_chain` +
`scope_matches_chain` against `demo.requested`'s real payload confirms no
caller can trigger an action outside their reach — an unreachable scope+
trigger combination simply never matches anything, for anyone. The actual
defect is authoring-time: the catalog offered every trigger to every scope
level with no signal that some combinations are dead on arrival.

## Decision

**A pure, generic `trigger_reachable_levels()` function**
(`scope_resolvers.py`), computed entirely from data the template already has
— the registered levels (ADR-0024) and a trigger's declared payload field
names — with no instance-specific hook, consistent with ADR-0024's principle
that the template never hardcodes an instance's hierarchy shape.

1. **The formula.** Given the registered levels in broad-to-narrow order and
   a trigger's declared field names, the trigger's *native* granularity is
   the narrowest level whose `f"{level}_id"` is among those names (the
   broadest level, index 0, if none match at all — a trigger with no
   hierarchy id is only ever tenant-wide). Every level from the broadest up
   to and including the native one is reachable: because
   `resolve_scope_chain` always resolves an event's **full** ancestor chain
   regardless of how granular the event itself is (the same guarantee
   `scope_matches_chain` already relies on for "a higher level covers
   everything beneath it"), a scope at or above native can still match even
   when an intermediate level's id isn't literally in the payload — e.g.
   `unit.onboarded` carries `brand_id` and `unit_id` but not `region_id`, and
   is still region-reachable, since tabsii's own resolver derives the region
   from the unit by lookup. A level narrower than native can never match: the
   event carries no id to narrow to.

2. **The catalog** (`GET /orchestration/workflows/catalog`) carries a new
   `reachable_levels` key on every trigger, computed from the same field data
   already serialized for the "Only when…" editor — declared events, generic-
   CRUD `<table>.<op>` events, and observed-but-undeclared events (which
   carry no known fields, and so are reachable only at the broadest level).

3. **Server-side validation** on create/update: a submitted `scope` whose
   `level` isn't in the resolved trigger's `reachable_levels` is a 422, via a
   new `_require_scope_reachable` check in the router (alongside the existing
   `_require_known_trigger`). A no-op when no resolver is registered at all —
   nothing to reason about reachability against, mirroring `_validate_scope`'s
   own leniency in that case.

4. **A shared lookup, `_trigger_field_names`,** resolves a trigger's declared
   field names by `(source, detail_type)` for both the catalog and the
   validation, so the two can never disagree about what a trigger's payload
   looks like.

## Options Considered

### Option A — Leave it to the UI only (client-side filtering, no server check)

**Pros:** simplest; the catalog's new `reachable_levels` field alone lets a
well-behaved client filter its dropdown.
**Cons:** the API is the only enforcement point every caller of it (the
portal, tabsii-crm's sibling backend, any future client) actually goes
through — a client that doesn't filter (or a direct API call) would still
create a dead workflow with no signal anything is wrong. Given the whole
premise here is "an author built something that looks fine but silently does
nothing," relying on every future client to catch it defeats the point.

### Option B — Instance-specific hook: let the resolver itself declare reachability

**Pros:** would let an instance encode reachability rules the generic formula
can't express (e.g. some hypothetical trigger reachable only at levels that
skip the native one).
**Cons:** no real instance need for this exists — tabsii's own resolver
behavior (unit lookups included) already matches the generic geometric
formula exactly, verified by hand-tracing three real triggers
(`demo.requested`, `lead.captured`, `unit.onboarded`). Adding an extensibility
seam nothing currently needs is exactly the premature abstraction ADR-0024
already argues against for the resolver itself.

### Option C — Pure, generic geometric formula computed from declared fields + registered levels (chosen)

**Pros:** zero instance-specific code, matches real tabsii behavior exactly
(verified against all three example triggers above), enforced server-side so
every caller benefits regardless of client behavior, and the catalog's
`reachable_levels` gives every client the same data to build a good picker
from.
**Cons:** relies on a trigger's declared fields actually including the
hierarchy id at its narrowest level — a hand-written `EventType.fields` (the
escape hatch for a payload that can't be modelled via `payload_model`) that
omits a real id field would under-report reachability. Accepted: the same
risk already exists for the "Only when…" condition editor's fields, and a
too-narrow `reachable_levels` fails safe (rejects a legitimately reachable
scope, rather than silently accepting a dead one) — the opposite of the
degradation this ADR closes.

## Rationale

Option C is the only one that closes the gap at its actual enforcement
boundary (the API, not a client the API cannot see) with no template code
that knows what a "brand" or "unit" is — the same discipline ADR-0024 and
ADR-0025 already established for scope resolution and authorization
respectively. The formula is deliberately conservative in the safe direction:
it never claims a scope is reachable when the payload genuinely can't carry
that level's id, matching `scope_matches_chain`'s own real behavior rather
than approximating it.

## Consequences

### Positive

- A dead scope+trigger combination is rejected at authoring time (422) with
  an actionable message (which levels the trigger *does* reach), instead of
  creating a workflow that looks configured but structurally never fires.
- Zero instance-specific code — `trigger_reachable_levels` is computed
  entirely from data the template already tracks.
- The catalog's new `reachable_levels` lets every client (the portal,
  tabsii-crm) build a trigger picker that's pre-filtered by the current
  scope, rather than a picker that lets an author walk into the trap.
- A no-op when no resolver is registered keeps every existing deployment's
  behavior byte-for-byte unchanged (matches ADR-0024/0025's own precedent).

### Negative / Trade-offs

- A hand-written `EventType.fields` declaration (rather than `payload_model`)
  that omits a real hierarchy id field under-reports reachability for that
  trigger — fails safe (over-rejects), not silently wrong, but worth noting
  as a sharp edge for a future event author to get right.
- Observed-but-undeclared triggers (a compliance anomaly under ADR-0010) are
  always reachable only at the broadest level, since their payload shape
  isn't known — correct today, but means a genuinely narrow observed event
  can't be scoped narrowly until it's properly declared.

### Neutral

- The formula treats "narrowest level whose id is present" as the trigger's
  native granularity even when an intermediate level's id is absent from the
  payload (the `unit.onboarded` case) — this is deliberate, not an oversight:
  see the Decision section's reasoning about `resolve_scope_chain` always
  resolving the full chain regardless of what the payload literally carries.

## Compliance

- **Contract.** `scope_resolvers.trigger_reachable_levels(field_names) ->
  list[str]`, pure and DB-free — reusable anywhere a trigger's field names are
  already known.
- **Catalog.** Every trigger dict in `WorkflowCatalog.triggers` carries
  `reachable_levels`, computed via the shared `_trigger_field_names` lookup
  in `routers/orchestration.py`.
- **Validation.** `_require_scope_reachable`, called from both `create_workflow`
  and `update_workflow`, 422s a scope+trigger combination the trigger's
  payload can never satisfy.
- **Tests.** `test_scope_resolvers.py` covers the formula directly (no
  resolver registered, no hierarchy id at all, a mid-level id, and the
  narrowest-present-id-skips-a-level case). `test_orchestration_admin_router.py`
  covers the router end to end: reject on create/update for an unreachable
  scope, accept a reachable one, no-op when nothing is registered, and the
  catalog's `reachable_levels` values for two real triggers.

## Related Decisions

- ADR-0010 — the event registry this feature reads declared payload fields
  from; an observed-but-undeclared trigger's unknown shape is why it degrades
  to broadest-only reachability.
- ADR-0024 — the scope-resolver registry and `scope_matches_chain`'s "higher
  level covers everything beneath" semantics this ADR's formula is derived
  from and must stay consistent with.
- ADR-0025 — the scoped-authorization registry this ADR is the reachability
  complement to: ADR-0025 answers "may this caller author at this scope";
  this ADR answers "could this trigger's payload ever actually match it."
