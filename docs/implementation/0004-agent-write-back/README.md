# Implementation Plan: Agent Write-Back to Core Tables

**Status:** Draft
**Date:** 2026-07-27
**Decision of record:** [ADR-0027](../../ADR/0027-agent-write-back-to-core-tables.md)
(amends [ADR-0014](../../ADR/0014-agentic-worker-framework.md) §7 and
[ADR-0020](../../ADR/0020-agent-result-delivery-on-completion.md))
**Source PRD:** inline (design session 2026-07-27) — no separate ticket
**Related:** #527 (outcome-oriented builder epic — "Delivery: … CRM"; "Permissions shown"),
#452 (read-scope ceiling, specced and deliberately unbuilt — **not** implied by this plan)

## Scope

**This plan covers Phase A only** — the Core contract, the permission model, the
executor, the plugin reaction, and the tabsii `leads` wedge proven end to end on dev.

Explicitly **out of scope here**, each needing its own plan:

- **Phase B** — the portal Workflows builder's `writeback` editor (`tabsii-platform`
  `apps/portal`).
- **Phase C** — the CRM Automations write-back editor (`tabsii-crm`).

One cross-repo bug fix (M8) is in scope because Phase C is unsafe without it and it is
worth landing on its own merits.

At the end of Phase A a write-back works and is provably permission-bound, configurable
by API. No UI renders it yet.

## Current state (confirmed by reading the code, 2026-07-27)

The reaction plumbing exists; the authority does not.

**Exists:**

- `agent.run.completed` emitted at `services/api/src/api/routers/internal_agents.py`
  (`emit_event(db, AGENT_RUN_COMPLETED, _reference_payload(run), …)`), a reference
  payload only — `{run_id, agent, status, causation_id, depth}`.
- A dedicated orchestrator subscription to it:
  `services/_plugins/orchestrator/src/orchestrator/plugin.py`
  `@self.subscribe(_AGENT_RUN_COMPLETED)` → `deliver_on_completion()`, which fetches the
  run over SigV4 (ADR-0009) and dispatches via `prepare_delivery` (`actions.py`).
- `delivery` as a validated, secret-redacted, snapshotted sub-config
  (`schemas/orchestration.py`, `type: "delivery"`).
- `OutputTool` / `output_tools(snapshot)` —
  `services/_plugins/agent-runtime/src/agent_runtime/tools.py` — an arbitrary-JSON-Schema
  terminal submit tool. **Never populated from the workflow builder.**
- `AgentRun.run_as_kind` / `run_as_user_id` (`models/agent_run.py`), always `"system"`.
- `require_rls_context` (`dependencies.py`) —
  `set_config('app.current_user_id', …, true)` on the app session.
- The ADR-0025 authorizer registry (`orchestration_authz.py`) and tabsii's implementation
  (`domains/tabsii/orchestration_authz.py` → `tabsii.fn_ura_scope_reachable`).

**Does not exist:**

- **No author on a workflow definition.** `models/orchestration.py` `WorkflowDefinition`
  has no `created_by` / `run_as_user_id`. Nothing knows who scheduled a job.
- **No write-back ceiling.** No `WriteBackTarget` concept. (Separately: no model anywhere
  declares `allowed_principals` either — the §7 *read* ceiling is unexercised. Write-back
  needs no read and does not build it.)
- **No delivery dedupe.** `deliver_on_completion` has no claim record.
- **No Core write path reachable by a service principal on behalf of a stored user.**
  `owner_data_handlers.py` (ADR-0017 §5) is the closest analogue but requires a *live*
  forwarded token (`X-Biffo-User-Token`), which an asynchronous completion does not have.

## Cross-repo boundary

| Path | Ownership (`core-manifest.json`) | Mechanism |
|---|---|---|
| `services/api/src/api/**` (except `domains/`, `migrations/versions/`) | template-owned | build here → `biffo core upgrade` |
| `services/_plugins/orchestrator/**` | template-owned (the `_plugins` carve-out, #243) | build here → `biffo core upgrade` |
| `services/api/migrations/versions/` | user-owned, *additive carry* by upgrade (#198) | authored here, appended + re-chained into the instance |
| `services/api/src/api/domains/tabsii/**` | user-owned (ADR-0022) | authored directly in `tabsii-platform` |
| `tabsii-crm/apps/frontend/**` | separate repo | its own PR |

M1–M6 land in **`biffo-template`**. M7 lands in **`tabsii-platform`** (a core upgrade PR
carrying M1–M6, plus a hand-written `domains/tabsii/` registration). M8 lands in
**`tabsii-crm`** and is independent of everything else — it can run in parallel.

Expect the usual upgrade friction: tabsii's `routing/crud_handlers.py` has diverged
(soft-delete `deleted_at`, RLS caller deps), and plugin-Terraform changes do not
auto-trigger tabsii's infra deploy.

## Data model mapping (the tabsii wedge)

Target: **`tabsii.leads`**, both operations.

From `db/imports/tabsii/011_rls_policies.sql`:

```sql
CREATE POLICY leads_create ON tabsii.leads FOR INSERT
  WITH CHECK (fn_authorized('leads.create', tenant_id, brand_id, NULL, NULL, franchisee_id));
CREATE POLICY leads_update ON tabsii.leads FOR UPDATE
  USING      (fn_authorized('leads.read',   tenant_id, brand_id, NULL, NULL, franchisee_id))
  WITH CHECK (fn_authorized('leads.update', tenant_id, brand_id, NULL, NULL, franchisee_id));
```

So `brand_id` is the column the authorization decision turns on ⇒ it is **`derived`**, never
agent-settable (ADR-0027 §4). Permission codes `leads.create` / `leads.update` already exist
(`017_rbac_permission_catalog.sql`); `models/crm.py` already declares
`create: {allowed: True, permission_code: "leads.create"}`. **No new DDL module and no new
permission code is required** — write-back deliberately reuses the codes a human already
needs, so it can never exceed hand authority.

Update row selection uses `lead.captured`'s declared payload (`events/registry.py`
`LeadCapturedPayload`: `lead_id`, `brand_id`, `brand_slug`, `pipeline_stage_id`, `source`,
`status`) — selector `lead_id`. Generic-CRUD `leads.*` events carry the full row, so `id`
serves there.

| Target column | Set by | Notes |
|---|---|---|
| `tenant_id` | derived (ADR-0001 seam) | never settable |
| `id`, `created_at`, `updated_at`, `deleted_at` | derived / auto | rejected at registration if named in `columns` |
| `brand_id` | derived from the definition's validated `scope` | the escalation guard |
| `pipeline_stage_id` | derived — the brand's default stage | create only |
| `source` | derived literal `"agent"` | provenance |
| `first_name`, `last_name`, `email`, `phone`, `company` | agent (`create`) | |
| `notes` | agent (`create` and `update`) | update mode `append` |
| `status` | **not writeable in v1** | a pipeline decision, not an agent one |

## Milestones

One PR each, in order. M8 is independent.

### M1 — Write-back target registry (biffo-template)

`services/api/src/api/writeback_targets.py` (new): `WriteBackTarget`, `WriteBackColumn`
(`name`, `label`, `type`, `required`, `enum`, `overwrite` ∈ `if_empty|append|always`),
`DerivedValue` (`from_tenant`, `from_scope(level)`, `literal`, `callable`), `RowSelector`
(`payload_field`), plus `register_writeback_target()` / `resolve_writeback_target()` /
`writeback_targets()`. Empty default — fail closed.

Registration-time validation (this is the structural half of ADR-0027 §4, and must reject,
not warn):

- `columns` may not name the tenant column, the primary key, any audit column, or any
  column also named in `derived`.
- `operations` ⊆ `{create, update}`; `delete` has no representation.
- `update` requires a `row_selector`; `create` must not carry one.
- `allowed_principals` entries are non-empty `system:<name>` strings (mirrors
  `PermissionRule._validate_allowed_principals`).
- `permission_code` is non-empty.

**Tests:** each rejection above; unregistered lookup returns `None`; a valid target
round-trips; registration is idempotent-by-replace like the other registries.

### M2 — `run_as` on the workflow definition (biffo-template)

- `models/orchestration.py`: `WorkflowDefinition.run_as_user_id: str | None`,
  `run_as_kind: str` (default `"system"`).
- `migrations/versions/0011_workflow_run_as.py` (additive, nullable — existing rows keep
  `NULL` and therefore cannot carry a write-back).
- `routers/orchestration.py`: stamp `run_as_user_id = caller.user_id`,
  `run_as_kind = "user"` on **create, update and `set_enabled`**.
- `schemas/orchestration.py`: expose `run_as_user_id` on `WorkflowDefinitionResponse`
  (the UIs need it for the "Runs as …" badge).

**Tests:** stamped on all three routes; a definition saved by user A then enabled by user B
runs as B; the field is never accepted from the request body.

### M3 — Write-back config: catalog, validation, authoring authority (biffo-template)

- `schemas/orchestration.py`: new config-field type `writeback` on the agent action; value
  `{"table", "operation", "columns": {col: source}, "row_selector"?}` where a source is a
  literal, `{output.<field>}` or `{payload.<field>}`. `_validate_writeback_config()` checks
  the target is registered, the operation allowed, every column in the allowlist, every
  required column present, and — for `update` — that the selector names a field the chosen
  trigger's `payload_fields()` actually declares (reusing ADR-0026's machinery).
- `WorkflowCatalog` gains `writeback_targets`, **filtered to targets the calling user may
  write** (their `permission_code` ∩ their reachable scope), so the picker cannot produce an
  unsaveable definition.
- `routers/orchestration.py` create/update: before persisting a definition carrying a
  write-back, require the caller to hold the target's `permission_code` and to pass the
  ADR-0025 authorizer for the definition's `scope`. 403 otherwise.
- Reject a write-back on a definition with no `scope` when the target declares a
  `from_scope` derived column (there would be no brand to derive) — 422 with that reason.

**Tests:** every rejection; catalog filtering per caller; a scoped non-admin can save a
write-back inside their scope and cannot outside it; secrets/redaction untouched by the new
field type.

### M4 — Derive the agent's output contract from the ceiling (biffo-template)

When a definition carries a write-back, build a `submit_<table>_record` output-tool JSON
Schema from the target's `columns` (types, `required`, `enum`) and **override**
`definition_snapshot.output_tools` at `POST /api/v1/internal/agent-runs`
(`routers/internal_agents.py` / `agent_runs.py`) — the plugin's submitted value is never
trusted for this.

**Tests:** schema matches the allowlist exactly; a column outside the allowlist never
appears; a plugin-supplied `output_tools` is discarded; no write-back ⇒ unchanged behaviour.

### M5 — The executor (biffo-template) — the security-critical PR

`routers/internal_writeback.py` (new): `POST /api/v1/internal/orchestration/writeback`,
`require_service_principal`, body **`{"agent_run_id": …}` and nothing else**.

Ordered steps, each failing closed:

1. Load the run; require `status == "completed"` and a `writeback` in its snapshot.
2. Resolve the target; **404** if unregistered or the principal is not in its
   `allowed_principals` (ADR-0004 §4 indistinguishability).
3. Resolve `run_as_user_id` from the definition; 403 if absent, or the user is missing/
   inactive.
4. Re-check the target's `permission_code` against that user's *current* permissions —
   for the legible failure, not as the authorization.
5. **Claim** a `WorkflowRun` with `dedupe_key = "writeback:{agent_run_id}"`; an already-
   claimed key returns the prior outcome and writes nothing.
6. Build the row: agent values from the run's `result`, coerced per column type and
   filtered through the allowlist; `derived` values from tenant/scope/literals. For
   `update`, select by the stored trigger event's selector field and apply each column's
   `overwrite` mode.
7. Execute on the **RLS session** with `app.current_user_id` = the stored author. Never
   `get_admin_db`.
8. Emit the table's state-change event via `emit_event`, carrying `causation_id` and
   `depth + 1` from the run (ADR-0014 §8 loop ceiling).
9. Record an `ActionLog`; on denial also emit `workflow.writeback.denied` and increment the
   definition's consecutive-denial count, disabling it at the configured threshold.

**Tests:** happy path create and update; unregistered target → 404; wrong principal → 404;
missing/inactive author → 403; a `WITH CHECK` violation maps to a failed `ActionLog` with a
legible reason and no row; replay writes exactly once; `if_empty` does not overwrite a
populated column; `append` concatenates; an update whose selector field is absent from the
stored event fails closed; **an explicit assertion that this route never acquires the admin
engine**.

### M6 — Orchestrator reaction (biffo-template plugin)

`plugin.py` `deliver_on_completion`: when the snapshot carries `writeback`, POST the run id
to the Core route, reusing the existing transient/permanent split and bounded retry. Message
delivery and write-back are independent — a definition may do both, and one failing must not
suppress the other. The plugin gains **no** table, column, value or identity knowledge.

**Tests:** posts on a completed run with a write-back; posts nothing without one; a failed
run posts nothing; transient errors retry, permanent ones do not; delivery + write-back both
fire.

### M7 — Distribute to tabsii and register the `leads` target (tabsii-platform)

1. `biffo core upgrade` PR carrying M1–M6. Expect conflicts in `crud_handlers.py` /
   `main.py`; resolve by hand.
2. `services/api/src/api/domains/tabsii/writeback_targets.py` (new, user-owned): register
   `leads` per the Data model mapping above — `create` and `update`, `permission_code`
   `leads.create` / `leads.update`, `allowed_principals = ("system:orchestrator",)`,
   `brand_id` from `from_scope("brand")`, `notes` `overwrite="append"`. Imported from the
   domain module's `__init__` alongside `scope_resolver` and `orchestration_authz`.
3. Deploy to dev; confirm the migration applied and the new route is live (401/404 unauthed).

**Tests:** a `domains/tabsii/tests/` unit test asserting the registration's shape; plus M8's
E2E below.

### M8 — Fix the CRM automation edit round-trip (tabsii-crm) — independent

**Pre-existing bug, found while surveying; a Phase-C blocker in its own right.**
`apps/frontend/src/components/AutomationsPanel.tsx` `save()` rebuilds the request body from
rendered form state and sends `trigger_filter: null` and `schedule_config: null`
unconditionally, with `action_config` filtered to catalog-known field names. So **editing a
portal-authored workflow in the CRM silently discards its trigger conditions and its
schedule**, and would mangle any structured sub-config the panel does not render.

Fix: load the full definition on edit and preserve every field the panel does not own —
`trigger_filter`, `schedule_config`, and any `action_config` key the panel did not render —
rather than reconstructing the body from form state. Reproduce first (a test that fails on
today's code: load a definition with a `trigger_filter` and a `schedule_config`, rename it,
assert both survive).

**Tests:** the reproduction above; an unrendered structured `action_config` key survives an
edit; a rendered field still updates.

### E2E acceptance (runs with M7 — the milestone that proves the feature)

Against dev, on real PostgreSQL, per the ecosystem's standing E2E requirement:

1. Seed a **Brand HQ** user scoped to Demo Brand — deliberately *not* a platform admin.
2. As them, author a write-back workflow scoped to that brand.
3. Fire the trigger → agent completes → **a lead exists with `brand_id` = Demo Brand**,
   `source = "agent"`, and only allowlisted columns populated.
4. **Revoke their `leads.create`** (or their brand assignment) and replay the completion
   event → **no row is written**; a failed `ActionLog` carries a legible reason; the denial
   is queryable.
5. Replay the same completion event twice → **exactly one row**.
6. Author a cross-scope write-back attempt → refused at save.
7. Update path: a populated `notes` is appended to, not clobbered; a lead the author cannot
   see is not updated.

Step 4 is the point of the entire feature. A green build without it proves nothing.
Clean up seeded users/leads afterwards (they otherwise join the orphan set tracked in
tabsii-platform#53).

## Testing plan

- **Unit** (biffo-template `services/api/tests/`, `services/_plugins/orchestrator/tests/`):
  per-milestone as listed. The suite runs on SQLite, which cannot exercise RLS — so the
  RLS-session behaviour is asserted structurally (the route sets the GUC; the route never
  acquires the admin engine) and behaviourally only in the instance E2E.
- **Real-PostgreSQL** (tabsii-platform): the policy-level assertions — a Brand HQ's insert
  succeeds in their brand and fails outside it; the same insert fails after revocation.
- **Frontend** (tabsii-crm, M8): Vitest reproduction + regression.
- **Dry-run**: an explicit test that the workflow dry-run path performs no write-back.

## Open questions

1. **Unscoped write-backs.** A tenant-wide definition has no brand to derive. M3 rejects
   this at save when the target declares a `from_scope` column. Alternative — derive from
   the trigger payload's `brand_id` with ADR-0026 reachability validation — is deferred; it
   widens the trust surface to payload content and is not needed for the wedge.
2. **Auto-disable threshold.** Consecutive-denial count before a definition disables itself.
   Proposed default 3, configurable.
3. **PII in run state.** Agent-supplied values persist in `result` / `trigger_event` JSON.
   Existing redaction covers declared secrets only. Not addressed here; flagged in ADR-0027.
4. **`status` / stage moves.** Deliberately not writeable in v1. If moving a lead's pipeline
   stage is wanted, it is an `enum`-constrained column addition, not a design change.
