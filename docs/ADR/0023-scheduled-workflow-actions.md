# ADR-0023: Scheduled / delayed workflow actions

**Status:** Accepted
**Date:** 2026-07-26
**Deciders:** Core team

---

## Context

Every workflow action fires the instant its trigger event arrives —
`dispatch_event` claims a run and the engine executes its action
synchronously, in the same Lambda invocation that received the event
(`services/api/src/api/orchestration.py`, `services/_plugins/orchestrator/src/orchestrator/plugin.py`).
There is no way to say "wait, then act." The concrete need: a follow-up email
2 weeks after a user is onboarded — the onboarding event *is* the trigger, so
the gap is a delay from trigger time, not a second trigger.

No existing mechanism in the platform schedules a single future action per
item. The closest thing, agent-runtime's stale-run reaper
(`services/_plugins/agent-runtime/terraform/main.tf`), is a fixed recurring
`rate(1 minute)` tick that sweeps *all* stale rows — not a per-run future
fire-time. Adding one means picking a delay mechanism and deciding how the
callback re-enters the engine without corrupting state the callback has
nothing to do with — specifically, the self-building trigger catalog
(ADR-0010): every event that reaches `dispatch_event` is recorded as an
observable trigger via `observe_trigger`, so a naive "treat the callback as
just another event" design would pollute the trigger picker with an internal
plumbing signal no one should ever bind a workflow to.

## Decision

**EventBridge Scheduler**, one one-time schedule per scheduled run, calling
the engine Lambda back directly — routed around the trigger-matching path
entirely, through a dedicated internal endpoint.

1. **A workflow definition may declare `schedule_config`**: `{"type":
   "fixed_delay", "delay_seconds": N}`, validated at authoring time
   (`_validate_schedule_config`, positive, capped at 1 year). `None` (every
   existing definition) means "fire immediately" — today's behaviour,
   unchanged.

2. **Claiming a scheduled run sets `status="scheduled"` and `scheduled_for`**
   instead of dispatching (`_claim_run`, `ClaimedRun.scheduled_for`). The
   engine, seeing `scheduled_for` set, creates a one-time EventBridge
   Scheduler schedule (`at(<scheduled_for>)`, `ActionAfterCompletion=DELETE`
   — no cleanup code needed) targeting its own Lambda, instead of executing
   now.

3. **The fire-time callback is a dedicated endpoint, `POST
   /internal/orchestration/runs/{run_id}/fire`, never `dispatch_event`.** It
   atomically transitions `status` from `"scheduled"` to `"dispatching"` (a
   conditional `UPDATE ... WHERE status = 'scheduled'`, guarding EventBridge's
   at-least-once delivery from double-firing — the same row-count-as-verdict
   shape `agent_runs.claim_run` already uses for the same reason) and
   re-checks the owning definition is still enabled and not deleted before
   handing back the action to execute. On the plugin side, the Scheduler's
   raw Lambda-target invocation is detected *before* it reaches
   `create_event_handler`/the `BiffoEvent` subscription machinery at all — it
   is not shaped like an EventBridge-rule event and is not meant to be one.

## Options Considered

### Option A — SQS delay queue

**Pros:** already a first-class primitive in `modules/cloud/aws/compute`;
simple mental model (send now, receive later).
**Cons:** SQS message delay caps at 15 minutes — useless for "2 weeks."
Long delays would need a delay-then-requeue chain, which is more moving parts
than the problem needs.

### Option B — Step Functions `Wait` state

**Pros:** natively expresses "wait until a timestamp, then do X"; no separate
Scheduler primitive to learn.
**Cons:** a Step Functions state machine is a much heavier dependency to
introduce for one field on one action — a new execution model, new IAM
surface, new observability story — when the actual need is "fire this Lambda
once, later."

### Option C — Reuse the wildcard-forwarder/`dispatch_event` path for the callback

Make the Scheduler's callback look like an EventBridge event (a synthetic
`source`/`detail-type`) and let it flow through the same
`subscribe_all`/`process_event`/`dispatch_event` path every other event uses
— superficially consistent with how `agent.run.completed` already runs
through both the wildcard forwarder *and* a dedicated `@self.subscribe(...)`
handler (`plugin.py:145-156`).

**Pros:** no new endpoint; reuses machinery that already exists.
**Cons:** `dispatch_event` unconditionally calls `observe_trigger`
(`orchestration.py:137`) — routing the callback through it pollutes the
self-building trigger catalog with a fake, internal "trigger" a user could
select and bind a workflow to, which makes no sense and is hard to explain in
the UI. This was the deciding rejection: the callback is not a business event
and must not be discoverable as one.

### Option D — EventBridge Scheduler + dedicated fire endpoint (chosen)

**Pros:** native one-time `at()` scheduling with no 15-minute cap; auto-cleans
via `ActionAfterCompletion=DELETE`; the dedicated `/fire` endpoint keeps the
callback wholly outside `dispatch_event`/`observe_trigger`, so it can never
pollute the trigger catalog; the atomic status transition reuses an existing,
proven pattern (`agent_runs.claim_run`) rather than inventing a new one.
**Cons:** a second IAM role (the one EventBridge Scheduler assumes to invoke
the Lambda) alongside the Lambda's own execution role — more Terraform
surface than Option A, though still additive and small.

## Rationale

Option D is the only one that both handles an arbitrarily long delay natively
and keeps the scheduled-fire callback from corrupting a system (the trigger
catalog) built for a different purpose. The bypass in point 3 looks like a
departure from the `agent.run.completed` precedent, but that precedent's
dual-subscription shape assumes the event *should* be discoverable as a
trigger (agent chaining is a real, intended use) — the Scheduler callback has
no such legitimate reading and must not be offered as one.

## Consequences

### Positive

- A workflow definition can delay its action by any duration up to a year,
  covering the motivating case (a 2-week follow-up) with no artificial
  15-minute ceiling.
- The fire-time re-check (definition still enabled/exists) means disabling or
  deleting a workflow after it schedules, but before it fires, is safe — the
  run self-skips rather than firing an action for a rule that no longer
  applies.
- `ActionAfterCompletion=DELETE` means no schedule ever needs manual cleanup
  in the normal case.
- Zero behavior change for every existing definition (`schedule_config` is
  `None`, `_claim_run` takes the exact same `"pending"` path as before).

### Negative / Trade-offs

- A second IAM role (Scheduler → Lambda invocation) and a scoped
  `iam:PassRole` grant on the engine's own execution role — more moving
  Terraform parts than a simpler queue-based approach, accepted for the delay
  ceiling this need actually requires.
- No proactive cancellation of an already-scheduled run when its definition
  is disabled/deleted before fire time — v1 relies entirely on the fire-time
  re-check, not a `DeleteSchedule` call at disable/delete time.
  `WorkflowRun.schedule_name` is stored for a future admin "cancel" action but
  nothing calls it yet.

### Neutral

- **Delay relative to a payload timestamp** (e.g. a stored `onboarded_at`
  that differs from event-arrival time), not just trigger-arrival time, is
  deferred — `schedule_config.type` is the extensibility seam, unused until a
  real need names the second variant.
- **Multiple delays / branching schedules per definition** — out of scope,
  consistent with the orchestration engine's original stated non-goals ("no
  timers/branching/retries yet").

## Compliance

- **Contract validation.** `WorkflowDefinitionBody.schedule_config` is
  validated on create/update (`_validate_schedule_config`,
  `services/api/src/api/schemas/orchestration.py`) — unknown `type`,
  non-positive or over-cap `delay_seconds` are all 422s.
- **Atomic fire-time claim.** `fire_scheduled_run`
  (`services/api/src/api/orchestration.py`) uses the same
  conditional-`UPDATE`-plus-rowcount pattern as `agent_runs.claim_run`, not a
  read-then-write race.
- **No trigger-catalog pollution.** The Scheduler callback never reaches
  `dispatch_event`/`observe_trigger` — verified by routing it through a
  dedicated `/runs/{run_id}/fire` endpoint and a dedicated early branch in the
  plugin's Lambda entrypoint, both bypassing the event-subscription machinery
  entirely.
- **Tests.** Schedule validation (valid/invalid shapes, cap), a scheduled
  claim produces `status="scheduled"` + `scheduled_for`, the fire endpoint
  transitions exactly once and skips a disabled/deleted definition, and (in
  the plugin) the `CreateSchedule` call shape and the entrypoint's routing of
  the Scheduler payload are covered in the Core and orchestrator suites.

## Related Decisions

- ADR-0002 — Core is the single data plane; the engine holds no state of its
  own, including no schedule bookkeeping beyond what Core records.
- ADR-0003 — the orchestration engine is a plugin; this ADR extends its
  Terraform and Lambda code, not its packaging.
- ADR-0009 — the engine reaches Core over the IAM-signed internal API; the
  new `/fire` endpoint is another route on that same surface.
- ADR-0010 — the event registry and self-building trigger catalog whose
  integrity motivated bypassing `dispatch_event` for the fire callback.
- ADR-0020 — the precedent for a second, purpose-specific subscription
  alongside the wildcard forwarder; explicitly not followed here, for the
  reason given in Options Considered.
