# ADR-0010: Event Registry — one source of truth for platform events (triggers)

**Status:** Accepted
**Date:** 2026-07-07
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

The orchestration engine (ADR-0003 plugin + the orchestration Core feature) lets an
admin build a **workflow**: a _trigger_ (an EventBridge event, identified by
`source` + `detail_type`) mapped to an _action_. As we set out to offer a **broader,
growing selection of triggers**, we found that "what a trigger is" is declared in
**four independent, hand-maintained places**, and they already drift:

1. `WORKFLOW_TRIGGERS` in `services/api/src/api/schemas/orchestration.py` — the
   builder's catalog **and** create/update validation.
2. The orchestrator plugin's Terraform `event_subscriptions` → its EventBridge rule
   (**Gate 1**: an event that doesn't match the rule never reaches the plugin).
3. The plugin's in-Lambda SDK router — `@self.subscribe("…")` in `plugin.py`
   (**Gate 2**: an event that reaches the Lambda but has no registered handler is
   silently dropped).
4. `biffo.plugin.json` `event_subscriptions` — a declarative mirror.

`lead.captured` is the proof: it is in the catalog (offered by the UI, accepted by
validation) but not in the gates, so a workflow built on it can never fire — a dead
trigger. Adding a new trigger today also requires a **plugin code change + redeploy**
(Gate 2). Four copies of the same fact is exactly the kind of duplication that bites.

Two facts make a clean fix possible:

- **Runtime dispatch is already decoupled from the catalog.** `dispatch_event`
  matches purely on the stored `WorkflowDefinition` rows (`trigger_source`,
  `trigger_detail_type`, `enabled`, `tenant_id`). The catalog is only a UI +
  validation concern, so it can change without touching the matching engine.
- **`BiffoEvent` has no type registry.** Events are constructed inline as
  `BiffoEvent(detail_type="…", payload=…)` with magic strings, so Core cannot even
  enumerate the events it defines.

## Decision

Introduce a **canonical Event Registry** — `services/api/src/api/events/registry.py` —
as the **single source of truth for what a platform event is.** Each event is
declared **once** as an `EventType(source, detail_type, label, description)` via
`register_event(...)`, which returns the constant so publishers bind it:

```python
DEMO_REQUESTED = register_event(
    EventType("biffo.core", "demo.requested", "Demo requested", "…")
)
# publish:  publisher.publish(DEMO_REQUESTED.build(payload))
```

That one declaration drives everything downstream:

- **Publishers** emit via the constant (`EVENT.build(payload)`) — the `detail_type`
  string lives in exactly one place, and Core gains a runtime-enumerable event set.
- **The builder catalog** (`GET /orchestration/workflows/catalog`) is built from
  `registered_events()` — `WORKFLOW_TRIGGERS` is deleted.
- **Create/update validation** accepts a trigger iff `find_event(...)` resolves it.

Registration happens at **import time** (like model discovery in `main.py`), so
instance- and plugin-owned events register their own `EventType`s from the module
that emits them — a downstream repo adds events **without editing this file**, and
without a duplicate list.

The two subscription gates that re-declare triggers are **eliminated, not
synchronised** (subsequent work, epic #210): the plugin becomes a **generic
forwarder** (a catch-all handler forwarding any event to Core) behind a **broad
EventBridge pattern**, leaving Core's DB match as the sole runtime filter. The
registry then also self-augments from events observed at dispatch, so the catalog
grows as new events appear on the bus.

## Consequences

- **One source of truth.** A trigger is declared once. Terraform and plugin code
  declare zero triggers; the enabled `WorkflowDefinition` rows are the separate,
  single source for _what is active_. No copy can drift because there are no copies.
- **Kills magic strings.** Publishers reference a typed constant; a renamed
  `detail_type` changes in one place.
- **Distribution follows ownership (ADR-0006).** The registry _facility_ and the
  Core reference events are template-owned (this repo) and reach instances via
  `biffo core upgrade`. Instance/domain events are declared in the instance's own
  emitting code — each still in exactly one place.
- **Migration.** `WORKFLOW_TRIGGERS` is removed; the two reference events
  (`demo.requested`, `lead.captured`) are ported into the registry, so the catalog
  and validation behave identically at first and broaden as more events are declared.
- **Trade-off.** Import-time registration means an event only appears in the catalog
  if its declaring module is imported — acceptable, as event-emitting routers are
  already imported by `main.py`, matching the existing model-discovery pattern.

## Status update (2026-07-25)

Epic #210 has shipped: the subscription gates elimination and broad EventBridge pattern
are now implemented. The generic forwarder and catch-all EventBridge rule are in
`modules/plugins/_template/main.tf:97-117` and `services/_plugins/orchestrator/src/orchestrator/plugin.py:138-142`,
and the self-augmenting trigger catalog is in `services/api/src/api/orchestration.py:105-118`
(`dispatch_event()` calling `observe_trigger(...)`). The "subsequent work" described above is complete.
