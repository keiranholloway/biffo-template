# Implementation Plan: Scheduled / Delayed Workflow Actions

**Status:** Draft
**Date:** 2026-07-26
**Source PRD:** inline (this conversation) — no separate ticket
**Data model sources consulted:** none required — extends the existing orchestration-engine schema, no new product/domain tables

## Context

Every workflow action fires the instant its trigger event arrives — there is no
way to say "wait, then act." The concrete need: a follow-up email 2 weeks after
a user is onboarded. Today that's impossible; `dispatch_event` claims a run and
the plugin executes its action synchronously, in the same Lambda invocation
that received the triggering event (confirmed by reading the actual dispatch
path — see below). This plan adds an optional delay to a workflow definition,
using AWS EventBridge Scheduler to fire a one-time callback at the right time,
authored via a "When" control tucked into the portal builder's existing
Advanced section (matching the user's ask for "an advanced section").

## Current state (confirmed by reading the code)

- **Model** (`services/api/src/api/models/orchestration.py`): `WorkflowDefinition`
  (line 37) has no timing concept — `trigger_source`/`trigger_detail_type`/
  `trigger_filter`/`action_type`/`action_config`/`enabled` only. `WorkflowRun`
  (line 83) has `status` (`RUN_STATUSES = ("pending", "dispatched", "succeeded",
  "failed", "skipped")`, line 32) but nothing ever sets `"dispatched"` today —
  a run goes straight `pending` → terminal, because dispatch is synchronous.
- **Dispatch is fully synchronous, single Lambda invocation, no queue anywhere.**
  `services/api/src/api/orchestration.py:105` `dispatch_event` matches enabled
  definitions and calls `_claim_run` (line 55, idempotent insert inside a
  SAVEPOINT keyed on `dedupe_key = f"{definition_id}:{idempotency_key}"`).
  The plugin (`services/_plugins/orchestrator/src/orchestrator/plugin.py:168`
  `process_event`) POSTs the event to Core's `/internal/orchestration/events`
  (router: `services/api/src/api/routers/internal_orchestration.py:37`), gets
  back `ClaimedRun`s, and for every `created=True` run calls `_execute_run`
  (line 283) **immediately, in the same invocation** — bounded in-process retry
  only (`_MAX_ATTEMPTS=3`, comment at line 298 explains the 60s Lambda timeout is
  sized for exactly this). No SQS, no Step Functions, no `aws_scheduler_schedule`
  anywhere in the repo (grepped) — the only existing schedule-like construct is
  agent-runtime's fixed recurring reap tick (`services/_plugins/agent-runtime/terraform/main.tf:191`,
  a `rate(1 minute)` cron, not a per-item future-fire primitive).
- **Plugin already runs two independent event subscriptions on the same Lambda**
  (`plugin.py:145-156`): `@self.subscribe_all()` (the generic forwarder, calls
  `process_event`) *and* `@self.subscribe(_AGENT_RUN_COMPLETED)` (calls
  `deliver_on_completion`) — "the dispatcher runs detail-type handlers *and*
  wildcard handlers" (comment, line 151). This is the existing pattern for
  adding a second, purpose-specific reaction alongside the generic one.
- **`observe_trigger` runs unconditionally at the top of every `dispatch_event`
  call** (`orchestration.py:117`) — every (source, detail_type) pair that
  reaches it gets upserted into the self-building `trigger_catalog` (ADR-0010),
  making it selectable as a trigger in the portal. This matters: an internal
  plumbing signal must **not** flow through `dispatch_event`, or it pollutes the
  trigger picker with a fake "trigger" no one should ever bind a workflow to.
- **Lambda entrypoint** (`services/_plugins/orchestrator/src/orchestrator/main.py:39`
  `handler`) converts every invocation via `create_event_handler` (`packages/python-sdk/src/biffo_plugin_sdk/events.py:115`),
  which **requires** an EventBridge-rule-shaped envelope (`source`/`detail-type`/
  `detail`) and raises `ValueError` otherwise — a raw Scheduler-Lambda-target
  invocation (an arbitrary JSON `Input`) cannot flow through this function
  unchanged.
- **Terraform** (`services/_plugins/orchestrator/terraform/main.tf`): the engine
  Lambda's execution role gets extra least-privilege statements via
  `data.aws_iam_policy_document.engine` (line 79) — `execute-api:Invoke` on Core's
  internal routes, `ses:SendEmail`, WhatsApp SSM read — attached by
  `aws_iam_role_policy.engine` (line 132). This is the exact place a new
  `scheduler:CreateSchedule`/`DeleteSchedule` + scoped `iam:PassRole` statement
  belongs.
- **Portal** already has an "Advanced" disclosure in the builder's outcome
  journey (`apps/portal/src/app/admin/orchestration/page.test.tsx` section
  marker "Outcome journey: sections, presets, Advanced disclosure (Phase 1)") —
  the natural home for a new "When" control; no delay/timer/schedule UI exists
  today (grepped `page.tsx` for those terms — zero hits).
- **No ADR discusses timers or delay** as a stated non-goal or existing decision
  (checked 0010/0014/0020). Next ADR number is **0023**
  (`docs/ADR/` ends at `0022-product-domain-modules-are-user-owned-guests.md`).

## Scope (v1)

A workflow definition may declare a **fixed delay from the moment its trigger
fires** — covers the stated need exactly ("2 weeks after onboarded" = the
onboarding event *is* the trigger, so trigger-time + 14d is correct). Delay
relative to a timestamp *inside the payload* (e.g. a stored `onboarded_at` that
differs from event-arrival time) is **out of scope for v1**, but the schema is
shaped so it's additive later (see Data model).

## Architecture decision — new ADR-0023

Introduces a materially new AWS primitive (EventBridge Scheduler, plus a second
IAM role the Scheduler service assumes to invoke the Lambda) — same bar that
justified ADR-0020 (delivery-on-completion) and ADR-0021 (shared plugin
hosting). Milestone 1 includes drafting `docs/ADR/0023-scheduled-workflow-actions.md`
recording: why EventBridge Scheduler (native one-time `at()` schedules,
`ActionAfterCompletion=DELETE` needs no cleanup code) over alternatives (SQS
delay queues cap at 15 minutes — too short for "2 weeks"; Step Functions
`Wait` state is a much heavier dependency for one field); why the scheduled-fire
callback bypasses `dispatch_event`/the wildcard forwarder entirely (trigger-
catalog pollution, above) rather than reusing the subscribe-both-handlers
pattern that superficially looks consistent.

## Design

**1. Data model** (`services/api/src/api/models/orchestration.py`):
- `WorkflowDefinition` gains `schedule_config: dict | None` (JSON, nullable) —
  `{"type": "fixed_delay", "delay_seconds": N}` today; the `type` discriminator
  is exactly the extensibility seam for a future `"payload_field"` variant
  without a schema migration, mirroring how `action_config`/`delivery` already
  use a type-discriminated JSON blob rather than dedicated columns.
- `WorkflowRun` gains `scheduled_for: datetime | None` and `schedule_name: str | None`
  (deterministic `wf-run-{run_id}`, so a future "cancel" admin feature has
  something to call `DeleteSchedule` with — not needed for v1 execution itself,
  since `ActionAfterCompletion=DELETE` self-cleans).
- `RUN_STATUSES` gains `"scheduled"` — a claimed run waiting on its fire time,
  distinct from `"pending"` (claimed, about to dispatch *now*).
- New Alembic migration in `services/api/`, carried to instances by the
  existing additive migration-carry mechanism (`core-manifest.json`'s
  documented handling of `services/api/migrations/versions/`).

**2. Core API** (`services/api/src/api/orchestration.py`, `schemas/orchestration.py`,
`routers/internal_orchestration.py`):
- `WorkflowDefinitionBody` (schemas, line 758) gains an optional `schedule`
  field validated the same way `_validate_action_config` already validates
  `action_config` — positive `delay_seconds`, capped at a sane max (1 year) to
  keep costs/sanity bounded.
- `dispatch_event`/`_claim_run`: when the matched definition carries
  `schedule_config`, the claimed run is created with `status="scheduled"` and
  `scheduled_for = now() + delay_seconds` instead of `"pending"`; `ClaimedRun`
  gains `scheduled_for: datetime | None` so the plugin knows to schedule rather
  than execute.
- **New endpoint**, deliberately separate from `/events`:
  `POST /internal/orchestration/runs/{run_id}/fire` — atomically transitions
  `status` from `"scheduled"` to `"dispatching"` (a `WHERE status='scheduled'`
  conditional UPDATE, guarding EventBridge Scheduler's at-least-once delivery
  from double-executing the action) **and** re-checks the owning definition is
  still `enabled`/not deleted. Returns the `ClaimedRun`-shaped payload to
  execute on a real transition; returns a "skip" (definition disabled/deleted,
  or already fired) otherwise — the caller records `status="skipped"` and does
  nothing further. This is the safety-valve for "I turned the workflow off
  after it scheduled but before it fired": re-validated at fire time, not
  assumed valid from claim time weeks earlier.

**3. Plugin** (`services/_plugins/orchestrator/src/orchestrator/plugin.py`,
`main.py`):
- `process_event`: when a `ClaimedRun` carries `scheduled_for`, call new
  `_schedule_run(run)` instead of `_execute_run` immediately. `_schedule_run`
  uses `boto3`'s `scheduler` client to `CreateSchedule`: one-time
  `at(<scheduled_for UTC ISO>)`, target = this Lambda's own ARN, `Input` = a
  small JSON envelope carrying only `run_id` (**not** an EventBridge-rule-shaped
  event — see below), `ActionAfterCompletion="DELETE"`, name `wf-run-{run_id}`.
- **`main.py`'s `handler`** gets one new early branch, *before* `create_event_handler`:
  if the raw Lambda event is this plugin's own Scheduler-`Input` shape (a
  sentinel key, e.g. `"biffo_scheduled_run_id"`), call `plugin.fire_scheduled_run(run_id)`
  directly and return — bypassing `create_event_handler`/`BiffoEvent`/the
  subscribe-dispatch machinery entirely. This is a deliberate departure from
  the `agent.run.completed` precedent (a second `@self.subscribe(...)` handler
  alongside the wildcard forwarder): reusing that pattern here would still run
  the callback through `process_event` → Core's `/events` → `observe_trigger`,
  polluting the trigger catalog with an internal signal no one should ever
  pick as a trigger. Bypassing the event-subscription system entirely avoids
  that at the cost of one small branch in an entrypoint that's already a thin
  shim.
- `fire_scheduled_run(run_id)`: calls the new `/runs/{run_id}/fire` endpoint;
  on a real claim, executes the action via the existing `ACTION_HANDLERS` +
  records the result via the existing `record_result` call (both paths reused
  unchanged from `_execute_run`, refactored so the core "run the handler,
  retry transient failures, record the outcome" logic is shared between the
  immediate and scheduled paths rather than duplicated).

**4. Terraform** (`services/_plugins/orchestrator/terraform/main.tf`):
- New `aws_scheduler_schedule_group` (namespaces this plugin's one-time
  schedules per environment).
- New `aws_iam_role` trusted by `scheduler.amazonaws.com`, with an inline
  policy granting `lambda:InvokeFunction` on this specific Lambda's ARN only —
  the role EventBridge Scheduler assumes to invoke the target (distinct from
  the Lambda's *own* execution role; needs confirming during Milestone 2
  whether Scheduler additionally requires a Lambda resource-based permission
  the way an EventBridge Rule target does, or whether the invocation role's own
  IAM policy is sufficient — flagged as an open technical question to resolve
  against AWS docs/a real `terraform apply` rather than asserted here).
- Extend the existing `data.aws_iam_policy_document.engine` (line 79) with a
  `scheduler:CreateSchedule`/`DeleteSchedule`/`GetSchedule` statement scoped to
  the new schedule group's ARN, plus a narrowly-scoped `iam:PassRole` statement
  naming only the new Scheduler-invocation role's ARN (required for the
  Lambda's own `CreateSchedule` call to pass that role to the Scheduler
  service) — same `aws_iam_role_policy.engine` resource, no new one needed.

**5. Portal** (`apps/portal/src/app/admin/orchestration/page.tsx`):
- A "When" control inside the existing Advanced disclosure: "Run immediately"
  (default, current behaviour, zero UI change for every existing definition)
  vs. "Run after a delay" — a number input + unit `<select>` (minutes / hours /
  days / weeks), converted to `delay_seconds` on save. Reuses the existing
  `fieldControl`-adjacent form patterns rather than inventing new input
  chrome.
- Run history: show `scheduled_for` when present, so an admin can see a run is
  waiting rather than assume it silently vanished.

## Data model mapping

| Requirement | Column/field | Core API surface | Plugin/AWS surface |
|---|---|---|---|
| Author a delay | `WorkflowDefinition.schedule_config` | `WorkflowDefinitionBody.schedule` | catalog default `None` (immediate) |
| Track a pending fire | `WorkflowRun.scheduled_for`, `.schedule_name`, `status="scheduled"` | `ClaimedRun.scheduled_for` | `_schedule_run` → `CreateSchedule` |
| Fire safely, once | (status transition only, no new column) | `POST /runs/{id}/fire` | `fire_scheduled_run` → existing `ACTION_HANDLERS`/`record_result` |

## Milestones

1. **Core API**: model columns + migration, `schedule` validation, `dispatch_event`
   scheduling branch, new `/runs/{id}/fire` endpoint with the atomic
   transition + enabled/deleted re-check, ADR-0023 draft. Tests: schedule
   validation (positive/negative/over-cap), claim produces `status="scheduled"`
   + `scheduled_for`, fire endpoint transitions once and rejects a second call,
   fire endpoint skips a disabled/deleted definition.
2. **Plugin + Terraform**: `_schedule_run` (`boto3` `scheduler.create_schedule`
   call shape), `main.py`'s early-branch dispatch, `fire_scheduled_run`, the
   schedule group + Scheduler-invocation IAM role + engine-policy additions.
   Tests: `_schedule_run` calls `CreateSchedule` with the right `at()`
   expression/target/Input (mocked boto3 client, matching the existing
   `FakeSes`/`FakeHttp` fixture style in `services/_plugins/orchestrator/tests/orchestrator_fakes.py`),
   `fire_scheduled_run` success/skip/retry, `main.py` routes the sentinel
   payload correctly without touching `create_event_handler`.
3. **Portal UI**: the "When" control in the Advanced section + `scheduled_for`
   display in run history, with `page.test.tsx` coverage mirroring the
   recipient-payload-templating picker tests (render gated correctly, value
   round-trips on save/edit).
4. **End-to-end verification**: a workflow with a short real delay (e.g. 60–120s)
   against a real trigger on a dev deployment, confirming the schedule
   actually fires and the action executes at approximately the right time —
   manual, like the prior feature's Milestone 4 (AWS-real-infra dependency,
   not unit-testable).

## Testing plan

Unit tests per milestone as listed above, following the existing test file
conventions (`services/api/tests/test_orchestration_admin_router.py`,
`services/_plugins/orchestrator/tests/test_actions.py` and its `plugin.py`
counterpart, `apps/portal/src/app/admin/orchestration/page.test.tsx`). Manual
E2E required per `[[e2e-testing-required]]` project convention — not "done" on
green tests alone, same discipline as the recipient-templating feature.

## Open questions / explicitly deferred

- Delay relative to a payload timestamp field (not just trigger-arrival time) —
  the `schedule_config.type` discriminator is the seam; deferred until a real
  need names it.
- Cancelling an already-scheduled run when its definition is disabled/deleted
  *before* fire time — v1 answer is "let it fire and self-skip" (the fire-time
  re-check), not proactive cancellation; `schedule_name` is stored for a future
  admin "cancel" action but nothing calls `DeleteSchedule` early in v1.
- Whether EventBridge Scheduler needs an explicit Lambda resource-based
  permission (`aws_lambda_permission`) in addition to the invocation role —
  resolve during Milestone 2 against real Terraform apply, not assumed here.
- Multiple delays / branching schedules per definition — out of scope, matches
  the original engine's stated non-goals ("no timers/branching/retries yet").

## Rollout

Same distribution shape as the recipient-payload-templating feature: build and
merge in `biffo-template` (Core API + plugin + Terraform + portal, all
template-owned per `core-manifest.json` including `apps/portal/`), then
distribute to `tabsii-platform` via `biffo core upgrade` (additive migration
carry handles the new columns). No teardown of any live environment; the new
Terraform resources are purely additive (a schedule group + a new IAM role),
so the upgrade's `terraform apply` should be low-risk, but Milestone 2 should
still confirm the plan against a real `terraform plan` before merging into a
live instance.
