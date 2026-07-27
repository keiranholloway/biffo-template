# ADR-0027: Agent write-back to Core tables

**Status:** Accepted
**Date:** 2026-07-27
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

An agent workflow (ADR-0014) runs an agentic worker on a trigger event and records
its result on the `AgentRun`. ADR-0020 then delivers that result to a *human*
destination — email, Slack, Google Chat, WhatsApp. What it cannot do is put the
result back into the product: a worker that qualifies an inbound lead can tell you
what it concluded, but cannot record the conclusion on the lead.

That is the capability this ADR adds, and ADR-0014 §7 is explicit that adding it is
a decision, not an increment:

> **Writes are not reachable through this path at all.** `agent-runtime` is never
> granted create, update or delete. […] A worker needing to write business data is
> a new decision requiring an amendment to this ADR — the right amount of friction
> for the thing §5 exists to prevent.

**This ADR is that amendment.** It is written against a security model that has so
far been deliberately, verifiably closed: no model in any instance declares
`allowed_principals`, the agent read path (#452) was specced and left unbuilt, and
an agent today reads nothing from Core and writes nothing anywhere.

### What already exists

Most of the *plumbing* is in place, which is why the decision here is about
authority rather than mechanism:

- **A completion event.** Every run emits `agent.run.completed` from
  `POST /api/v1/internal/agent-runs/{id}/complete` (ADR-0014 §5) — a **reference
  payload only** (`{run_id, agent, status, causation_id, depth}`), because the
  transcript and output are LLM-derived from attacker-influenceable input.
- **A job that reacts to it.** The orchestrator holds a dedicated subscription to
  `agent.run.completed` (`deliver_on_completion`) and fetches the run over IAM
  SigV4 (ADR-0009).
- **A destination contract snapshotted onto the run.** ADR-0020's `delivery`
  sub-config: `{ "type": …, "config": … }`, validated Core-side, secret-redacted,
  captured in `definition_snapshot` (ADR-0014 §10).
- **A structured-output channel.** `OutputTool` / `output_tools(snapshot)` in the
  agent runtime — a terminal submit-your-result tool carrying an arbitrary JSON
  Schema. Live, but never populated from the workflow builder.
- **A delegated-principal field designed for exactly this.** `AgentRun.run_as_kind`
  / `run_as_user_id` (ADR-0014 §6.2), always `"system"` today, with §7 stating that
  when `run_as: user` arrives it composes as
  `ceiling ∩ declared scope ∩ the user's own permissions`.

### What does not exist, and shapes the decision

1. **A workflow definition records no author.** `WorkflowDefinition` has no
   `created_by` / `run_as_user_id`. Nothing in the system knows who scheduled a
   job — so "the user scheduling the job" is not currently a principal that can be
   consulted at all.
2. **Delivery has no dedupe.** ADR-0020 records this as an accepted trade-off:
   `agent.run.completed` delivery is at-least-once and "a rare redelivery can send a
   duplicate message". A duplicate *message* is a nuisance; a duplicate *row* is
   data corruption.
3. **Delivery executors run in the plugin.** SES and webhook calls happen inside
   the orchestrator Lambda. A database write cannot: ADR-0002 forbids any component
   but Core touching the database, and the plugin holds no user identity.

### The requirement that drives everything below

> A job must not be able to write to a table if the user who scheduled it does not
> have permission to write to that table — and must stop being able to the moment
> that permission is taken away.

## Decision

Add **write-back**: an optional sub-config of the agent action that records the
agent's structured result into a Core table, on completion, under the authority of
the user who authored the workflow.

### 1. Write-back is a destination, executed by Core, triggered by the plugin

Write-back reuses ADR-0020's completion seam rather than introducing a second one.
It differs in one structural respect, which is the whole security story:

> **The orchestrator triggers; Core decides and executes.**

On `agent.run.completed` for a succeeded run whose snapshot carries `writeback`,
the orchestrator POSTs to a new internal Core route with a body of
**`{"agent_run_id": …}` and nothing else**. Target table, operation, column set,
values, row selection and principal are all resolved by Core from state it already
holds. The plugin carries no knowledge of tables, columns or identity, and cannot
supply any.

This hardens the rule `owner_data_handlers.py` already follows for ADR-0017 §5 —
*"the owner is taken from the verified token, never from the request"* — by one
step, because in an asynchronous write there is no live token to forward at all.

### 2. Authority is the author's, bound at save and re-checked at write

`WorkflowDefinition` gains `run_as_user_id` and `run_as_kind`, set to the
authenticated caller on **every create, update and enable**. Authority re-binds to
whoever last exercised it, so a definition always runs as a user who affirmatively
saved it in its current form. A definition with no `run_as_user_id` (every
pre-existing row) cannot carry a write-back.

Enforcement is in two places, and the second is the one that matters:

**At authoring time** — the caller must hold the target's `permission_code`, and it
must be reachable for the definition's `scope` via the instance's registered
authorizer (ADR-0025). Fail at save beats fail at run (§7's own principle), and the
catalog only offers targets the caller can already write, so the picker cannot
produce an unsaveable definition.

**At write time** — Core executes the statement on a session that has been **bound
to the stored `run_as_user_id`**, so the instance's own row-level policies decide
the outcome. **Never on an admin/BYPASSRLS engine.**

How a session is bound to a principal is **not something this template knows**, and
the distinction matters enough to be explicit. Row-level security and the
`SET LOCAL app.current_user_id` GUC plumbing were deliberately deferred from the
template (#229, ADR-0012's amendment): `db_app_role.py` splits privilege — the
request path connects as a least-privilege, non-owning `biffo_app` role — but the
template ships **no policies at all**. RLS is an instance concern, exactly as
ADR-0011 says authorization is.

So the binding is a **registered seam**, the third in the same family as ADR-0024's
scope resolver and ADR-0025's scoped authorizer:

- The **template** owns everything generic and testable once: resolving the target,
  claiming the run, building the row from the allowlist, emitting, auditing.
- The **instance** registers a principal-session provider — for tabsii, the
  `set_config('app.current_user_id', …, true)` its `require_rls_context` already
  performs for a live request, sourced here from stored state rather than a token.
- The template's default provider **refuses**. An instance that has registered
  nothing cannot write back at all, rather than writing on an unbound session where
  no policy would scope it.

That default is the important half. A template that wrote the row itself would be
promising an enforcement it has no ability to deliver, and the failure would be
silent and total: every write would succeed, unscoped, on a deployment with no
policies. Refusing instead means write-back is available exactly where an
enforcement mechanism actually exists.

PostgreSQL therefore re-evaluates the instance's own row policies against the
author's **current** role assignments, at the instant of the write. Demote the
author, revoke their brand assignment, deactivate them, delete their role — the very
next write fails `WITH CHECK` (SQLSTATE 42501) and is recorded as a denial. There is
no cached grant to invalidate and no second copy of the policy to keep in step,
because **the check is in the database, not in the application**.

Core also re-checks the endpoint-level permission code in Python immediately before
the statement. That is deliberately redundant: its job is a legible failure and a
clean audit entry, not authorization.

### 3. A three-term ceiling, all terms required

Effective write permission is the intersection of three independently maintained
things — ADR-0014 §7's `ceiling ∩ declared scope`, now supplying the third term §7
designed for and never exercised:

**Term 1 — the ceiling (code, reviewed, deploy-gated).** A table is write-back
eligible only if it is registered as a `WriteBackTarget`, declaring its allowed
operations, its **column allowlist**, its `permission_code`, and the service
principals permitted to trigger it. Default-deny: the registry is empty, so a
freshly scaffolded instance can write nothing and no admin toggle can change that.
Widening it is a PR and a deploy — §7's stated reason for putting the ceiling in
code rather than in configuration.

Registration follows the seam pattern this codebase already uses for
template/instance policy splits (`register_scope_resolver`, ADR-0024;
`register_workflow_scope_authorizer`, ADR-0025): the template ships the registry
and a fail-closed empty default; an instance registers its own targets from its
product-domain module (ADR-0022).

**Term 2 — the declared scope (config, validated at save).** The definition's
`action_config.writeback` names exactly one target, one operation, and a mapping of
allowlisted columns to sources. Validated against the registry on create/update: an
unregistered table, a disallowed operation, or a column outside the allowlist is a
422. A declaration can only ever narrow the ceiling.

**Term 3 — the author's own authority.** As in §2.

### 4. Columns that participate in an authorization decision are server-derived

A `WriteBackTarget` declares two disjoint column sets:

- **`columns`** — what the agent may supply. Business content only.
- **`derived`** — what Core sets itself, from trusted state: the tenant from the
  ADR-0001 seam, the hierarchy scope from the **definition's validated `scope`**,
  and any fixed provenance marker.

The distinction is not tidiness, it is the escalation guard. Any column an
instance's row policies evaluate — for the driving case, a lead's `brand_id` — is a
column whose value decides the authorization outcome. If the model could supply it,
an author scoped to one brand could have their agent write into another, with
attacker-influenceable text feeding an authorization decision. So such columns are
`derived`, taken from state already validated at authoring time, and RLS then
re-checks the result independently.

**This is enforced structurally, not by review**: registration rejects a target
whose `columns` name the tenant column, the primary key, an audit column, or any
column the target declares as scope-bearing.

### 5. The write surface is bounded: create, and selector-bound update

**`create`** — insert a new row. The natural first surface: it adds information
without destroying any.

**`update`** — amend an existing row, under three constraints that together keep it
from becoming "an agent may edit the database":

- **The row is never chosen by the agent.** An update target declares a
  `row_selector` naming a field of the *trigger event's* payload that carries the
  row's primary key (e.g. `lead_id` on `leads.updated`). At authoring time the
  selector is validated against the event registry's declared payload fields — the
  same declared-payload machinery ADR-0026 already validates trigger scopes with —
  so a workflow cannot be saved whose trigger can never identify a row. At write
  time the id comes from the stored trigger event, never from the model's output.
- **Visibility is authority.** The statement runs on the author's RLS session, so
  the `USING` clause of the instance's update policy decides which rows exist at
  all. A row the author cannot see is a zero-row update, recorded as a denial — not
  a leak, and not a write.
- **Human input is not silently overwritten.** Each column declares an overwrite
  mode — `if_empty` (the default for update targets), `append`, or `always`. An
  agent enriching a record does not clobber what a person typed unless the target
  explicitly says it may.

**`delete` is not offered, at all.** There is no declaration that enables it.

### 6. The result contract is generated from the ceiling

When a definition carries a write-back, Core derives an `OutputTool` JSON Schema
from the target's allowlisted columns (typed, required-marked, enum-constrained
where the column is) and **overrides** `definition_snapshot.output_tools` when the
run is created. The runtime already supports this; it has simply never been
populated from the workflow builder.

Two consequences worth stating plainly. The model is *required* to return exactly
the writeable columns as structured data, so extracting the payload is never text
parsing. And the schema is generated server-side **from the ceiling**, so the model
is never offered a field it may not write — the tool schema *is* the permission
boundary, expressed in the one place the model actually reads.

### 7. Write-back claims a run, so it is exactly-once and auditable

Core claims a `WorkflowRun` with `dedupe_key = "writeback:{agent_run_id}"` before
writing. The existing `uq_orch_run_dedupe` unique constraint then gives at-most-once
for free: a redelivered completion event claims the same run and no-ops, exactly as
a replayed trigger event already does. The outcome is recorded as an `ActionLog`.

This closes the gap ADR-0020 accepted for messages, for the destination where it is
not acceptable, and it does so by reusing machinery rather than adding a bespoke
claims table — write-back appears in the existing run-history surfaces with no new
read model.

### 8. Denial is loud

A write-back that fails authorization records a failed `ActionLog` with a
human-readable reason, and emits a declared `workflow.writeback.denied` event. After
a configurable number of consecutive denials the definition is disabled
automatically. A workflow whose owner has left the company stops trying, visibly.

The emitted state-change event for a successful write carries the run's
`causation_id` and `depth + 1`, so a workflow that writes a row and is itself
triggered by that row's change hits ADR-0014 §8's existing depth ceiling instead of
running away.

## Options Considered

### Option A — Write as a service principal with a table ceiling (no user term)

Grant the orchestrator (or agent-runtime) a write principal, gated only by the
table-level ceiling — the mirror image of §7's read design.

**Pros:**

- Smallest build: no author field, no stored principal, no RLS impersonation.
- Symmetric with the read ceiling as specified in #452.
- Deterministic — a write never fails because someone's role changed.

**Cons:**

- **Fails the actual requirement.** Every user who can author a workflow gets the
  union of what the ceiling permits, regardless of their own permissions. A Brand HQ
  for one brand could write into another, because the principal is the plugin.
- Makes the ceiling the *only* control, so widening it for one team widens it for
  everyone — the escalation shape ADR-0011 exists to prevent.
- Discards `run_as_user_id`, which ADR-0014 §6.2 added specifically so this would
  not have to be retrofitted.

### Option B — Author-bound authority, permissions snapshotted at save time

Record the author's effective permissions when the workflow is saved; replay them at
write time.

**Pros:**

- Deterministic and trivially auditable — the grant is a value, visible in the row.
- No impersonation machinery; no RLS session juggling.
- A write cannot fail for a reason invisible at authoring time.

**Cons:**

- **A revoked user keeps writing.** Someone offboarded on Monday continues to have
  their workflows write until a human notices and edits them. That is precisely the
  failure this ADR exists to prevent.
- Creates a second copy of the authorization state that must be kept in step with
  the RBAC catalog forever — a class of drift bug with no natural detection.
- Scheduled workflows (ADR-0023) can fire weeks after authoring, making the stale
  window arbitrarily long.

### Option C — A dedicated per-tenant automation service account

Writes run as a named automation principal, granted roles like any other user.

**Pros:**

- Survives staff churn: no workflow dies because its author left.
- Visible in the existing RBAC management UI; grantable and revocable by admins.
- One principal to audit rather than one per author.

**Cons:**

- Decouples the write from "the user who scheduled the job" — the requirement.
- Becomes a standing escalation target: whoever can author a workflow can act with
  the automation account's authority, which is a superset of their own.
- Needs its own grant surface, its own least-privilege discipline, and its own
  answer to "who is allowed to point a workflow at it".

### Option D — Author-bound `run_as`, re-checked at write time under RLS (chosen)

The definition stores the author; Core writes on an RLS session as that stored user;
PostgreSQL re-evaluates the instance's policies against their current assignments.

**Pros:**

- **Answers the requirement exactly**, including the revocation half: authority is
  re-derived at the instant of the write.
- The enforcement point is the database, so there is one copy of the policy and no
  cache to invalidate. An instance that changes its RBAC rules changes write-back's
  behaviour with it, for free.
- Uses `run_as_kind`/`run_as_user_id` for the purpose ADR-0014 §6.2 anticipated, and
  supplies §7's missing third term without revisiting the first two.
- Fails closed in every degenerate case: no author, inactive author, deleted role,
  out-of-scope row — all end in a zero-row statement or a policy violation.

**Cons:**

- A workflow can stop working for a reason not visible in its own configuration
  (someone else changed a role assignment). Mitigated by §8: denial is recorded,
  legible, surfaced in run history, and eventually disables the definition.
- A departed author's workflows die with them and need reassignment — real
  operational cost, addressed with an explicit "reassign owner" action rather than
  by weakening the model.
- Requires impersonating a stored principal on a database session, which must be
  held to a single, well-tested code path.

## Rationale

Option D is the only one that satisfies the stated requirement, and the deciding
factor is *where the check lives*. Options A and C move authority off the user
entirely; Option B keeps the user but freezes their permissions, which converts a
revocation into a silent, unbounded-duration privilege leak.

Option D instead reuses the enforcement point the platform already trusts for every
human request. ADR-0011 established that authorization is a core concern, and
ADR-0010 put it in PostgreSQL row policies precisely so it could not be bypassed by
whichever application path happened to reach the table. An asynchronous write is
just another path. Making it sit on the same RLS session as a synchronous one means
write-back inherits every policy an instance has written, every policy it writes in
future, and every revocation — without write-back knowing anything about them.

That the check is asynchronous and the principal is stored rather than presented is
the only genuinely new thing here, and it is contained to one route.

The write-surface bounds (§5) and the generated result contract (§6) follow the same
instinct as §7's read design: make the safe thing structural rather than advisory.
An agent cannot choose a row, cannot set a scope-bearing column, cannot silently
overwrite a person's text, and cannot even be *offered* a field outside the ceiling
— not because a reviewer will catch it, but because there is no representation for
it.

`delete` is excluded not because it is hard but because nothing has asked for it,
and the friction §7 describes is worth preserving for the operation that cannot be
undone.

## Consequences

### Positive

- An agent's conclusion lands in the product, not just in an inbox — the capability
  ADR-0020 stopped one step short of.
- **Revocation is immediate and total**, with no code path aware of it. Taking a
  role away stops the writes.
- No user can build a workflow that exceeds their own hand authority, so write-back
  adds no new privilege to any existing account.
- Write-back is exactly-once and appears in the existing run history, closing
  ADR-0020's accepted dedupe gap where it counts.
- `run_as: user` becomes real, completing ADR-0014 §7's composition with no change
  to the ceiling or the declared scope.
- Payload extraction is a typed schema rather than parsing, and the schema is
  derived from the permission ceiling.

### Negative / Trade-offs

- A workflow can fail for a reason outside its own configuration. Mitigated by
  recorded, legible denials, run-history surfacing, and auto-disable — not
  eliminated.
- A departed author's workflows require reassignment.
- Instance targets are code, so a new writeable table is a PR and a deploy. This is
  the intended friction, and it is a real cost.
- Core now impersonates a stored principal on a database session. It is one route,
  fail-closed, and heavily tested — but it is a genuinely sensitive code path and
  should be reviewed as one.
- **A deployment with no row-level security gets no write-back.** The template
  ships no policies (#229), so an instance must register a principal-session
  provider before a single row can be written. That is the correct default rather
  than an incidental gap — but it does mean write-back is not a capability the
  template alone confers, and a plain Biffo instance adopting it has RLS as a
  prerequisite, not an option.
- Agent-supplied values persist in `input_payload` / `result` / `trigger_event`
  JSON. Existing redaction covers declared **secrets**, not PII; write-back does not
  change that posture and does not claim to.

### Neutral

- **The read ceiling stays unbuilt.** Write-back needs no Core read — the agent
  works from the trigger payload, as every worker does today. #452 remains the
  design of record for reads and is not implied by this ADR.
- **`delete` is deferred** with no seam beyond "add an operation to a target".
- **Approval modes** (#527's suggest-only / act-with-approval) are deferred. Nothing
  here forecloses them: a pending-proposal queue would sit between §6's structured
  result and §2's write, reusing both.
- A future ADR-0020-style generalisation to multi-step workflows could subsume
  write-back as one step type.

## Compliance

- **Ceiling.** `WriteBackTarget` registration validates that `columns` excludes the
  tenant column, primary key, audit columns and any declared scope-bearing column;
  that `operations` ⊆ `{create, update}`; and that `allowed_principals` entries are
  non-empty `system:<name>` strings. An unregistered table is answered **404**, as
  ADR-0004 §4 indistinguishability requires.
- **Declared scope.** `WorkflowDefinitionBody` validates `action_config.writeback`
  against the registry on create and update; a malformed or over-reaching
  declaration is a 422. The catalog returns only targets the calling user may write.
- **Authoring authority.** The workflow router checks the target's
  `permission_code` against the caller and the definition's `scope` through the
  ADR-0025 authorizer before persisting, and stamps `run_as_user_id` on every
  create, update and enable.
- **Write authority.** The internal write route accepts `{agent_run_id}` only,
  resolves everything else from stored state, and executes on a session bound to the
  stored author by the instance's registered principal-session provider. Tests
  assert that the route never acquires an admin engine, and that with no provider
  registered the route writes nothing and records a denial.
- **Exactly-once.** The route claims a `WorkflowRun` on
  `dedupe_key = "writeback:{agent_run_id}"` before writing; a replayed completion
  event is asserted to produce exactly one row.
- **Denial.** Authorization failure produces a failed `ActionLog` and a
  `workflow.writeback.denied` event; consecutive denials disable the definition.
- **Loop safety.** The emitted state-change event carries the run's `causation_id`
  and `depth + 1`, so ADR-0014 §8's ceiling applies.
- **Dry-run.** A test asserts the workflow dry-run path performs no write-back.
- **End-to-end.** The instance suite proves, on real PostgreSQL: a scoped
  non-admin author's write lands in their own scope; the same write is refused after
  their permission is revoked; a cross-scope write is refused; a replayed event
  writes once; and an update neither selects a row the author cannot see nor
  overwrites a populated column declared `if_empty`.

## Related Decisions

- **ADR-0014** (Agentic worker framework) — amended here: §7's prohibition on
  writes is lifted under the conditions above, and §6.2's `run_as_user_id` is
  exercised for the first time.
- **ADR-0020** (Agent result delivery on completion) — extended here: a
  non-message destination, and the delivery dedupe that ADR deferred.
- **ADR-0010** (Database-enforced RBAC with RLS) — the enforcement point write-back
  delegates to. Instance-side; the template ships no policies.
- **ADR-0012** (Identity-provider seam), amendment / #229 — why RLS and the
  `app.current_user_id` GUC are deferred from the template, and therefore why the
  principal-session binding is a registered seam with a refusing default.
- **ADR-0011** (Authorization is a core concern) — why the check is not in the
  plugin.
- **ADR-0002** (API-only data integration) — why the plugin triggers and Core
  executes.
- **ADR-0009** (Internal service authentication) — the SigV4 path the trigger uses.
- **ADR-0004** (Generic CRUD and table permissions) — the declaration site the
  ceiling is a third axis alongside.
- **ADR-0017** (User-facing plugin chat modules) — §5's owner-scoped service access,
  whose "never from the request" rule this hardens.
- **ADR-0022** (Product-domain modules are user-owned guests) — where an instance
  registers its targets.
- **ADR-0024 / ADR-0025 / ADR-0026** (scope resolver, scoped authorization,
  trigger scope reachability) — the registry pattern and the authoring-time scope
  validation reused here.
- **ADR-0023** (Scheduled workflow actions) — why a permissions snapshot's stale
  window is unbounded.
