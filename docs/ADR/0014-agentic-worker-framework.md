# ADR-0014: Agentic workers — framework is code, workers are data

**Status:** Accepted
**Date:** 2026-07-21
**Amended:** 2026-07-21 — see *Amendment: UI distribution and the plugin question*
**Amended:** 2026-07-27 — §7's prohibition on writes is lifted under stated conditions by [ADR-0027](0027-agent-write-back-to-core-tables.md)
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Products built on Biffo are becoming agentic-AI heavy. The recurring need is not one agent but a **shell for rapidly creating agentic workers**: a standard runtime, a standard integration pattern, and a configurable definition of what each worker does.

Every such worker decomposes the same way:

- **Instructions** — the prompt, skill, or system message.
- **Context** — what it may read, from Core tables and from external sources.
- **A goal and outcome** — what "done" means.
- **Output** — where the result lands.

And every one needs the same plumbing: compute, an LLM integration (OpenRouter), memory, retries, and cost accounting.

The stated requirements are that workers be **publishable across Biffo implementations**, **installable more than once**, **upgradable**, and **repeatable**. Those requirements read like a description of the ADR-0003 plugin system, which is why the question was initially framed as "is an agentic worker a plugin?"

It is not, and the reason is that the framing conflates two artifacts.

### Two artifacts, two lifecycles

| | Agent **framework** | Agent **workers** |
| --- | --- | --- |
| What it is | Runtime, LLM client, tool loop, memory, cost accounting | Instructions, goal, read scope, output expectations, model |
| Nature | Code | Configuration |
| Installed | Once per instance | Many times, with different config |
| Changes | Rarely | Constantly |
| Upgraded by | A release of the framework | A new version of a definition |

ADR-0003 plugins are a **code**-distribution mechanism. They fit the framework and fail the workers on two counts:

1. **Multi-install is structurally impossible.** `biffo plugin install` writes to `services/<name>/` and `modules/plugins/<name>/` and declares fixed table names. Installing the same plugin twice collides on all three. "Installable more than once" — an explicit requirement — cannot be satisfied without templating a name through the entire pipeline.
2. **The declarative table schema cannot express a worker.** Plugin manifest columns are limited to `String, Integer, Text, Boolean, Float, DateTime` (`plugin_table.py`). An agent definition is irreducibly JSON — read scopes, tool lists, output expectations, model parameters. Storing it as `Text` forfeits queryability and validation.

Once the two are separated, both requirements have obvious answers. The framework ships as code, versioned with the platform. The workers are rows, created as often as wanted.

### The prior art is already here, and it is the right shape

The orchestration engine already implements exactly this split:

```
WorkflowDefinition (a row in Core)   ← data, many instances
  trigger_source, trigger_detail_type
  trigger_filter: dict
  action_type: str
  action_config: dict[str, Any]      ← arbitrary JSON config

ACTION REGISTRY (code in the engine)  ← code, one install
  send_email, send_google_chat, send_whatsapp
```

Workflows are data; actions are code. Adding a capability means registering a function and declaring its config fields. Triggers, idempotent claiming, and a run audit log come free.

The trigger for the first intended worker **already exists**:

```python
DEMO_REQUESTED = register_event(
    EventType(source="biffo.core", detail_type="demo.requested",
              label="Demo requested",
              description='Someone submits the "Book a demo" form.'))
```

### Why this is core capability, not a plugin

ADR-0013 characterises the orchestration engine precisely: *"core platform capability rather than an optional module — its tables, admin UI and trigger-matching all live in core, and only its dispatch worker is plugin-shaped."*

The agent framework is the same shape, and one of ADR-0013's own stated constraints settles it. Under that contract, plugins **do not ship React**; they declare UI capabilities (`head_scripts`, `nav_items`, `admin_pages`) that the portal renders generically, and ADR-0013 accepts the cost: *"a plugin wanting a genuinely novel UI … cannot have it."*

Agent authoring is a genuinely novel UI — a prompt editor, a read-scope picker, a test-run panel, a threaded run inspector. It is not a config form over a CRUD table. Building it inside the declarative UI contract would be fighting that contract; building it as core portal code is what the orchestration builder already does.

### Amendment: UI distribution and the plugin question (2026-07-21)

The argument above was re-examined the day this ADR was accepted, and it had a hole worth recording rather than quietly patching.

**The hole — and a correction to it (2026-07-23).** This amendment originally claimed a second hole: that the UI half does not distribute because `apps/` is user-owned, so it would need manual copy-in. **That was wrong.** #306 added `apps/portal/` to `templateOwned` as a single prefix, and longest-prefix-wins (len 12) beats `apps/` in userOwned (len 5) — so the entire portal, admin pages included, already travels with `biffo core upgrade`. The claim was written without re-checking the manifest against a `main` that had moved. It is struck here rather than quietly edited, because an Accepted ADR asserting a false gap is exactly the drift this project keeps catching elsewhere. The genuine re-derivation below never depended on it.

**Two of the three stated blockers were overstated.** Honestly assessed against ADR-0013's contract:

- *JSON columns* — the manifest's six scalar types are a `_TYPE_MAP` dict in `plugin_table.py`. Adding JSON is close to trivial, not a blocker.
- *A non-CRUD completion route* — completing a run **is** updating a row. It fits declarative CRUD, and #224's generic-CRUD emission would fire on it.
- *Novel UI* — this one survives. A threaded message view with tool calls and token accounting is not a config form over a CRUD table.

So the plugin path is materially more viable than this ADR originally implied, and ADR-0013's own trigger to implement — *"the first genuine plugin: optional, reusable across instances, extends the core data model"* — describes this framework at least as well as it describes payments.

**What actually decides it is optionality, not UI.** Plugins exist for capability a deployment may reasonably decline. Core exists for capability that is always present. Agentic AI is expected to be pervasive across Biffo products rather than an occasional add-on, so an install step would be machinery in service of a choice nobody makes. That is the same reasoning **ADR-0011** used to pull `rbac` out of the plugin tier: an optional, installable version of something every deployment needs is backwards.

The UI-expressiveness argument stands, but it is now the secondary reason, not the load-bearing one.

**There is no distribution gap.** The portal — including its `admin/` pages and the M5 run-inspector once it lands — distributes via `biffo core upgrade` today, because `apps/portal/` is template-owned (#306). #360, which this amendment originally cited as the fix-in-progress, was closed as already-resolved-by-#306; the narrow sub-path carve it proposed is the shape `cli/src/lib/portal-ownership.test.ts` forbids (it reintroduces the #279 trap of proposing to delete user code under the portal). The decision below rests on **optionality alone** — which was always the real reason.

---

## Decision

**The agent framework is first-party platform capability. Agent workers are data. Invocation and output are both events.**

### 1. The framework follows the orchestration precedent

| Concern | Where it lives |
| --- | --- |
| Agent definitions, runs, threads (tables + API) | `services/api/` — core |
| Authoring and run-inspection UI | `apps/portal/` — core portal |
| The execution runtime (LLM loop, tool calls) | `services/_plugins/agent-runtime/` — template-owned, plugin-shaped |

Distribution is `biffo core upgrade`, not the plugin registry. This is the channel ADR-0006 already provides and #243 carved `services/_plugins/` to serve.

JSON columns are available here because these are core SQLAlchemy models, not manifest-declared plugin tables — which is a further reason the framework cannot be an ADR-0003 plugin.

**The LLM provider is OpenRouter**, with the model selected per worker so alternatives can be compared without a code change — §10 records which model each run actually used, which is what makes that comparison meaningful after the fact. Provider access sits behind the runtime's own client and is never exposed to worker definitions, so changing provider later is a framework change rather than a migration of every worker.

### 2. Workers are data, authored in the portal

A worker is a **row**, created and edited through the admin UI by an authenticated platform user — not an installed artifact. "Installed more than once" is "create another row."

Whether that row lives in its own `agent_definitions` table or inside the binding workflow's `action_config` is **left to implementation**. The thesis is that workers are data; which table holds them is not load-bearing, and the extraction migration is trivial while worker counts are small. §4 explains why the usual reason to separate them — reuse across triggers — is not expected here.

### 3. Sharing is definition-based, not code-based — and nothing is built for it yet

Workers travel between Biffo implementations as **serializable definitions**, never as installable code. This is the answer to "is an agentic worker a plugin?" and it is load-bearing: the plugin registry distributes code, and almost everything worth sharing here is configuration.

**No catalog mechanism is built.** No registry repo, no `biffo agent import`, no import UI. With one instance and zero workers, building distribution before there is anything to distribute is exactly how the plugin registry came to ship `plugins: []` — the same failure mode one tier up. Copying JSON by hand is sufficient for now, and more informative: it reveals what genuinely needs parameterising instead of guessing.

**One guardrail:** a definition must remain **fully serializable**, with no hidden dependency on instance state beyond its explicit table references (§7). That is free while definitions are JSON, and it is the only property that would be expensive to retrofit. Everything else a catalog needs can be built when a second instance actually wants a worker.

### 4. Invocation is EventBridge, and only EventBridge

An agent run is started by an event on the bus. There is no synchronous invocation path.

Binding is a `WorkflowDefinition` with `action_type: "agent"` — reusing the trigger catalog (ADR-0010), payload filtering, idempotent claiming and run audit that already exist. Orchestrator dispatches; the agent runtime executes.

**Agents do not carry their own trigger fields.** Doing so would duplicate the trigger catalog, the payload-filter matching and the idempotent claim flow, and unwinding two such code paths after both exist is expensive. This is the one part of the binding question that is not deferrable.

**Nor is one agent bound to several triggers a goal.** Where a superficially similar task fires from different events, the assessment each needs is genuinely different — enriching a demo request is not the same judgement as enriching an inbound lead. Those are separate agents that happen to share a shape, not one agent reused. No cross-trigger reuse machinery exists, deliberately, and the maintenance cost of two similar prompts is accepted in exchange.

Accepted consequences: re-running a worker from the portal must **emit an event** rather than call the runtime; and all agent output is eventually consistent.

### 5. Output is the run record plus one event

A run writes its result to **its own run record** and emits `agent.run.completed`. It does not write to business tables.

- The event carries a **reference**, not the payload: `{run_id, agent, subject_ref, status, causation_id, depth}`. Consumers fetch the result through the API.
- One statically registered event type, with `agent_name` in the detail; subscribers discriminate via `trigger_filter`. Per-agent event types would require dynamic registration and break ADR-0010's one-place rule.
- **Core emits, not the runtime.** The runtime posts its result to Core; Core persists the run and emits through the existing post-commit buffer (#223).
- Terminal failures emit too, with status in the payload. A subscriber must be able to distinguish "failed" from "still running."

The security consequence is the point: **consumers act on their own authority.** An LLM-driven process never needs write access to business data, and chaining composes through the bus rather than through agent configuration.

#### What the post-commit buffer does and does not guarantee

Verified against the implementation rather than assumed, because §5 leans on it:

`emit_event` buffers onto the session's `.info` dict and never publishes inline (`events/emit.py`). `get_db` calls `publish_pending` **only** in the `else` branch after `await session.commit()` returns; the `except` path rolls back and re-raises without touching the buffer, which is discarded with the session (`database.py`). Both directions are tested.

So **an event cannot be published for a transaction that rolled back.** That is the phantom-event guarantee #223 was built for, and it holds.

**The converse does not hold, and an earlier draft of this ADR wrongly claimed it did.** `EventPublisher.publish` is best-effort by design (`events/base.py`): it logs and returns on both an exception and a non-zero `FailedEntryCount`, never raising into the request, so that API calls succeed in environments where EventBridge is unreachable. `publish_pending` also pops the buffer before publishing, so no in-memory copy survives. There is no retry, no outbox and no dead-letter, and no test covers the publish-failure path.

**A commit without an event is therefore possible; an event without a commit is not.**

That asymmetry matters more here than for the CRUD events the mechanism was built for. A lost `user.updated` is largely cosmetic. A lost `agent.run.completed` means the run record reads complete, no subscriber ever fires, nothing detects it, and the LLM work is already paid for — so re-running has a real cost. It is invisible until someone asks why a lead was never routed.

**Exposure in v1 is nil** — output goes to screen and nothing subscribes. It becomes real on the day the first subscriber exists, which is exactly when §5's composition argument starts being used.

Two consequences, deliberately unequal in urgency:

- **Deferred:** a transactional outbox — persist the event in the same transaction as the run, publish from a separate reader, mark delivered. This is the known fix and it closes the gap properly. It is not warranted while nothing subscribes, and it should land before the first subscriber does.
- **Do now:** alarm on the publish-failure log lines. A dropped event should be noisy rather than silent, and this costs almost nothing.

#### A second divergence point, at the other boundary

The runtime posts its result to Core. If that POST fails after the model work has completed, Core holds no result and the run is stranded in `running` — also paid for, and not addressed by anything above. It is a different boundary (runtime ↔ Core, rather than Core ↔ bus) with the same cost profile, and it needs a completion retry or a reaper for stale `running` runs. Recorded here so it is not mistaken for covered by the buffer discussion.

### 6. The run model is invocation-agnostic from the first commit

Synchronous agents (chat over data) are foreseeable but out of scope. The difference between async and sync is entirely at the edges — invocation, identity, delivery, conversation lifecycle — while the definition, tool registry, permission scoping, LLM client and turn loop are identical. Four data-model choices keep the core from encoding "I was triggered by an event":

1. **The agent run is its own record**, not the workflow run. Async is `event → workflow run → agent run`; a future sync path is `request → agent run`. Both produce identical runs.
2. **Every run carries an explicit principal** — `run_as: {kind: "system" | "user", user_id}` — set to `system` throughout v1. The field is trivial; retrofitting it means revisiting every permission check written before it existed.
3. **The loop is internally incremental**, yielding turn events even when the only consumer collects them into a final result. Streaming later becomes attaching a different consumer rather than rewriting the loop.
4. **Runs carry a nullable `thread_id`.** A *run* is one invocation to completion, bounded in cost and time. A *thread* is a sequence of runs sharing message history. Chat is a thread of runs, not one unbounded run.

None of these are abstractions or indirection. They are choices that avoid encoding an assumption known to be wrong.

### 7. Data access is a thin ceiling, narrowed by declaration, enforced by core

Effective read permission is the **intersection** of two independently maintained things:

1. **The agent principal's ceiling** — what agents may *ever* read in this deployment.
2. **The worker's declared read scope** — what this particular worker reads.

A worker cannot grant itself anything outside the ceiling, so editing a definition can never widen access. Scope is expressed as `(table, operation)` pairs — the primitives ADR-0004 already uses — not a new addressing scheme. This mirrors ADR-0013's "declare → review → enforce" shape, applied here to agent read-access rather than plugin installation.

**The ceiling reuses ADR-0004's declaration site, but deliberately not its role field.** A table becomes readable by agents by naming `system:agent-runtime` in an `allowed_principals` entry on its `__crud_permissions__` block — a field distinct from `required_role`, evaluated only for ADR-0009 service principals and never for authenticated users.

**That separation is structural, not a naming convention, and the distinction matters.** Putting the grant in `required_role` alongside Cognito groups would mean a Cognito group named `agent-runtime` silently conferring agent read access on every member. A reserved prefix alone does not close this: Cognito groups can be created out-of-band through the AWS console or CLI, so any guard on the portal's group-creation route is bypassable by the very people most able to abuse it. The `system:` prefix is kept for legibility; the security property comes from the field, which a Cognito group cannot populate at all.

Three properties follow for almost no new machinery:

- **Thin by default.** No table names the role, so a freshly scaffolded instance grants agents nothing at all. The ceiling starts empty and is widened one table at a time.
- **Widening is a reviewed code change, not an admin toggle.** The grant lives beside the model, so it arrives as a PR and a deploy. It cannot be escalated by whoever holds admin rights at the time — which is what makes this a genuine second layer rather than a restatement of the declaration.
- **Default-deny, 404-on-undeclared, and unconditional tenant scoping** are inherited unchanged from the existing handler path.

**Writes are not reachable through this path at all.** `agent-runtime` is never granted create, update or delete. A run's only write is completing itself, through a purpose-built internal route authorised by the run's own identity and state rather than by generic CRUD. A worker needing to write business data is a new decision requiring an amendment to this ADR — the right amount of friction for the thing §5 exists to prevent.

> **Amended 2026-07-27 by [ADR-0027](0027-agent-write-back-to-core-tables.md).** That friction was paid: writes are now reachable, but only through a purpose-built route with its own three-term ceiling, and never through this read path. `agent-runtime` is still granted no create/update/delete, and `allowed_principals` remains a read-only grant. Write-back is `create` and selector-bound `update` on **separately registered** `WriteBackTarget`s, executed by Core on an RLS session as the workflow's stored author — so §7's composition `ceiling ∩ declared scope ∩ the user's own permissions` is, for the first time, fully exercised: the `run_as_user_id` field §6.2 reserved is what supplies the third term. `delete` remains unreachable by any path.

**Authoring-time validation** still applies: saving a worker verifies both that its declared scope sits inside the ceiling, and that the *author* holds the permissions it declares. Failing at save beats failing at run.

**A table is only reachable if it has a Core model.** The ceiling lives on the model class, and an instance's business tables arrive as SQL via ADR-0005 DDL import, not as models. A DDL-imported table is therefore invisible to agents until the instance deliberately writes a model for it *and* names `agent-runtime` in its permissions — two steps, both reviewed. This is default-deny falling out of an existing boundary rather than a new rule, and it settles ownership: an instance owns its tables and therefore owns the decision to expose them. The template cannot pre-grant access to tables it has never heard of.

**Tools are not tables, and the registry is their ceiling.** §7 governs Core reads; the first worker's primary source is web search, which is no table at all. Tools are registered functions in the framework — as orchestrator's actions already are — so adding one is inherently a reviewed code change and needs no separate allowlist. A worker **declares which registered tools it uses, defaulting to none**, mirroring the default-deny posture above. This matters beyond tidiness: web search is the untrusted-content channel the security model identifies as the injection vector, and enabling it should be no less deliberate than exposing a table. Per-deployment tool gating (available in dev, off in prod) is deferred — it is configuration over an existing registry, addable with no lock-in.

**Two edge cases, both failing closed:**

- **The author's permissions change after a worker is saved.** Authoring-time validation checks the author at the moment of creation — it stops someone granting a worker reach they do not themselves hold. It is not a continuing binding: afterwards a worker's authority is ceiling ∩ declared scope, independent of who wrote it. That is deliberate, since the run principal is `system` rather than the author. The ceiling stays the continuous control, and the worker remains visible, editable and deletable by anyone who can administer them.
- **A table's model is deleted.** The permissions registry then holds no entry, `lookup_permission` returns `None`, and default-deny yields 404. Removing a model revokes agent access as a side effect — the correct direction to fail.

In v1 every run is `run_as: system`, so user-delegated authority is **designed for but not exercised**. Note what is and is not deferred: the ceiling and the declared scope are both live from the first run, and only the third term is missing. When `run_as: user` arrives it composes as `ceiling ∩ declared scope ∩ the user's own permissions`, with no change to the first two.

### 8. Cost and recursion are bounded by the framework, not by convention

Per-worker `max_turns`, token ceilings and wall-clock timeouts are enforced with hard stops. Events carry `causation_id` and `depth`, and dispatch refuses past a maximum depth — because event-triggered processes that emit events can cycle, and here each iteration has an invoice attached.

**The platform imposes a ceiling of its own.** A Lambda invocation is capped at 15 minutes, so a multi-turn loop must either finish inside one invocation or be resumable across several. §6's state machine and durable message array are what make the second possible — that is the operational reason for those choices, not only sync-readiness. Per-worker wall-clock limits therefore have to sit inside the platform ceiling, not merely inside a cost budget.

**Current posture on spend.** The deployment is single-operator, so volume is not the risk — runaway is. Limits should be set to make an unbounded loop impossible rather than to ration ordinary use, and generous per-run ceilings are acceptable while the maximum concurrent-run count stays small. That posture changes the moment the platform carries other people's traffic, and the enforcement points above are what make the change a configuration edit rather than a redesign.

### 9. Memory is deferred, with two guardrails

Three distinct things get called memory. **Thread history** — a run's message array, grouped by `thread_id` — is the only one v1 has, and §6 already provides it. **Working memory** (key/value an agent carries across runs) and **semantic recall** (vector search) are both deferred: each is purely additive, and no early worker needs either. Enrichment is stateless per subject.

Two constraints apply when they do arrive:

- **Memory is not retrieval.** Memory is what an agent remembers; retrieval is what it can look up. Vector search over business data is RAG — it belongs in the tool registry as a declared read tool subject to §7's ceiling, not in a memory subsystem. Blurring the two means building an embedding pipeline to serve a need the tool registry already covers.
- **Working memory is a write, and §7 forbids writes.** It would be the first exception to "writes are not reachable through this path at all", so it arrives as a deliberate amendment to §7 rather than a quiet addition — and namespaced per agent, not by opening the write path generally.

### 10. Runs are self-explaining; definitions mutate in place

A definition is edited in place. There is no versions table, no rollback and no diff — all deferrable, because all are reconstructible later.

What is **not** deferrable is capture. Every run records the **resolved definition it executed** — instructions, model, tool list, read scope, `max_turns`, budget — alongside a revision number from a counter the definition increments on save.

The asymmetry that forces this: memory (§9) and a catalog (§3) can be added later at full value, but **unrecorded data cannot be recovered**. A run that did not capture what it ran becomes permanently unexplainable the moment its definition moves on, and no later change can backfill it. The message transcript captures some of this incidentally — a rendered system prompt usually lands in the messages array — but not the model, tools or scope, which are exactly what explains a change in behaviour.

This is the model CI systems use: the run keeps the workflow file it ran. It delivers what versioning was wanted for — explaining a run after the fact — for roughly the cost of one column, and a versions table can be added later without invalidating anything already captured.

---

## Options Considered

### Option A — framework as core capability, workers as data (chosen)

**Pros:** matches the orchestration precedent exactly; satisfies multi-install trivially; JSON is available; custom authoring UI is unconstrained; distribution reuses `core upgrade`.

**Cons:** every instance carries the framework whether or not it uses agents. Optionality is by configuration (no workers defined) rather than by installation.

### Option B — one ADR-0003 plugin per worker

**Rejected.** Fails the explicit multi-install requirement — `services/<name>/`, `modules/plugins/<name>/` and table names all collide on a second install. The manifest's six scalar column types cannot express a worker definition. And under ADR-0013 the authoring UI would be bounded by declarative capabilities that cannot express a prompt editor.

### Option C — one plugin as the framework, workers as its rows

**Rejected, and re-examined after acceptance — see the amendment above.** Structurally reasonable, and more viable than first stated: of the three obstacles originally cited, JSON columns and the completion route both dissolve on inspection, leaving only run-inspection UI. It is rejected on **optionality** rather than expressiveness — agents are expected to be pervasive, so an installable framework would add an install decision nobody meaningfully makes (the ADR-0011 argument). Worth revisiting if that premise turns out to be wrong, or if the UI capability contract grows to cover bespoke pages.

### Option D — async now, a separate mechanism for sync chat later

**Rejected.** It duplicates the definition schema, the tool registry, and the permission model. The failure mode of two permission models is a scoping bug fixed in one path and not the other — the worst class of bug to invite deliberately. §6 gets the optionality for a few hours of care instead.

---

## Security model

The first intended worker enriches inbound demo requests, and it demonstrates the risks generally rather than incidentally.

- **Untrusted input reaches the model.** The demo form is public and attacker-controlled; a company-name field flows into agent context and then into web searches. Form fields must land in an **untrusted context channel kept structurally separate from instructions**.
- **Untrusted output must not be broadcast.** Enrichment text is LLM output derived from a public form and web results. It stays behind an API fetch (§5) rather than being pushed to every subscriber.
- **The trifecta is bounded by construction.** Access to private data, exposure to untrusted content, and an outbound channel is the dangerous combination. §5 removes the third by giving agents no write surface beyond their own run record.
- **PII leaves the platform, and is redacted before it does.** Prospect data is sent to OpenRouter from a UK business operating in `eu-west-2`. **Email addresses are redacted before any payload leaves the platform** — brand, size and role enrichment does not need them, and they are the highest-value identifier in the set. Redaction is the runtime's responsibility, not the worker author's, so it cannot be forgotten in a prompt. Note that name, company and role remain personal data after redaction, so the provider relationship still carries a processing obligation; that is reduced, not eliminated.
- **The provider credential is infrastructure, not configuration.** The OpenRouter API key lives in an **SSM SecureString** (`/<project>/<env>/agent-runtime/openrouter-api-key`), read once per cold start by the runtime's own client. Only the *parameter name* is a Lambda environment variable, so the key is in neither Terraform state nor the function's configuration, and the runtime's grant is `ssm:GetParameter` on that one parameter plus a `kms:ViaService`-fenced `kms:Decrypt`. Parameter Store rather than Secrets Manager because one key read at cold start uses none of what the latter adds and costs ~$0.40/month for it; this also matches how the orchestrator holds its WhatsApp credentials.
- **Cost is an availability concern**, not just a budget one. §8 treats it as such.

---

## Open questions — all resolved 2026-07-21

1. ~~**Trigger binding UX.**~~ **Resolved.** Split into three decisions with different deferability: agents reuse `WorkflowDefinition` rather than carrying trigger fields (decided, §4 — the only non-deferrable part); which table holds a worker definition is left to implementation (§2); the authoring UX is deferred entirely as a UI concern. One agent, one trigger.
2. ~~**Memory.**~~ **Resolved.** All three kinds deferred (§9); thread history from §6 is the only memory v1 has. Deferral locks nothing in — each is additive. Two guardrails recorded because both are free now and each prevents a wrong turn later: memory is not retrieval, and working memory collides with §7's no-writes stance.
3. ~~**Catalog location and format.**~~ **Resolved.** The stance stays (sharing is definition-based, §3) because it is load-bearing; the mechanism is deferred entirely — no registry, no CLI verb, no import UI. One guardrail: definitions stay fully serializable, the only property expensive to retrofit. Deferring this also simplifies Q4: with nothing distributing definitions, versioning is an internal explainability concern rather than a compatibility contract.
4. ~~**Definition versioning.**~~ **Resolved.** Definitions mutate in place; runs snapshot the resolved definition plus a revision counter (§10). A versions table, rollback and diff are deferred. This is the one question that resisted the deferral bias, and the reason is an asymmetry worth remembering: most deferrals here can be added later at full value, but unrecorded run provenance is lost permanently.
5. ~~**Where the first worker's read scope actually points.**~~ **Resolved.** The parameterisation half dissolved with the catalog (Q3) and the addressing half was answered by §7. Two residues surfaced and are recorded there: a table is unreachable until an instance gives it a Core model *and* grants the role (default-deny, instance owns the decision); and tools — the first worker's primary source — are scoped by the registry plus per-worker declaration defaulting to none. Per-deployment tool gating deferred.

---

## Consequences

### Positive

- Multi-install, upgradability and repeatability are satisfied by making workers data — no new distribution machinery.
- Agents inherit triggers, idempotent claiming, payload filtering and run audit from work already shipped (ADR-0010, #223–#226).
- Agents never need write access to business tables; chaining composes through the bus.
- A future synchronous path is an ingress and a delivery mode, not a second system.

### Negative / Trade-offs

- **Core carries the framework unconditionally**, used or not.
- **Two-step authoring** (§4), pending the resolution of open question 1.
- **User-delegated authority is designed but unexercised** in v1 (§7). Two of the three permission layers are live from the first run; the third stays unvalidated until a worker runs under a user's authority.
- **The portal half distributes via core upgrade** (`apps/portal/` is template-owned, #306) — no manual copy-in, contrary to an earlier draft of this ADR's amendment, which was corrected on 2026-07-23.
- **The ceiling is deliberately inconvenient to widen.** Granting agents a new table means a PR and a deploy, not an admin screen. That is the point, and it will still be irritating the first time a worker needs a table nobody anticipated.
- **Async-only** rules out conversational agents until the sync edges are built.
- **Event delivery is best-effort, not guaranteed** (§5). A committed run whose event fails to publish is lost silently. Harmless while nothing subscribes; an outbox is required before anything does.

### Neutral

- This ADR describes an architecture, not an implementation. Nothing in it is built.
- It does not amend ADR-0013. That contract governs third-party plugins; this is core capability, in the same tier as the orchestration engine.

---

## Amendment: first-party plugin infrastructure is template-owned (2026-07-23, closes #406)

§1 places `agent-runtime` in `services/_plugins/`, template-owned, distributed by
`biffo core upgrade`. That carried the plugin's *source* and its `terraform/`
module — but not the **instantiation**: the `module "plugin_<name>"` block that
actually creates the Lambda. `biffo plugin install` generates those for
third-party plugins, into the user-owned `plugins.generated.tf`; first-party
plugins had no equivalent, so the blocks were hand-wired per instance in the
user-owned `infra/environments/<env>/main.tf` and drifted (#406). One instance
had them and ran agents; a fresh instance had nothing, its agentic features were
dead, and every deploy still paid to look for the missing Lambdas.

This ADR already settles the ownership question — agentic capability is core, not
optional — so the instantiation is core's to distribute. A single template-owned
file, `infra/environments/dev/plugins.core.tf`, provisions the first-party
plugins (a carve-out inside the otherwise user-owned `infra/`, the same shape as
`apps/portal/` inside `apps/`). It depends only on the template-seeded shape every
instance has (`var.project_name`, `local.environment`, `local.tags`,
`module.events`, `module.api_gateway`) and passes the OpenRouter credential by
SSM-path convention (`/<project>/<env>/agent-runtime/openrouter-api-key`) rather
than a per-instance variable, so it upgrades cleanly into an older instance whose
`variables.tf` never gained the plugin vars. The plugin-allowlist module's
`core_plugins` default lists the same set, so the runtimes reach
`/api/v1/internal/*` with no edit to any user-owned root config. `enable_core_plugins`
(default true) is the deliberate opt-out for a deployment that runs no agents.

Consequence: every instance — present and future — gets the agentic plugins wired
identically, in parity by construction. Adding a first-party plugin is one block
in `plugins.core.tf` plus its name in the allowlist default; a drift guard
(`cli/src/lib/core-plugins-sync.test.ts`) fails the build if the two disagree.

---

## Amendment: §7's declared read scope is deferred, not built; tools gained an authoring path (2026-07-25, closes #569)

§7 describes effective read permission as the intersection of two things — the
agent principal's ceiling and the worker's declared read scope — and says, in
the present tense, that "**authoring-time validation still applies**: saving a
worker verifies both that its declared scope sits inside the ceiling, and that
the author holds the permissions it declares." That sentence overclaimed. An
audit (#562) found no `read_scope` field anywhere in the codebase — `grep -rl
"read_scope"` across the whole tree returned zero matches before this
amendment — and no validator comparing a declared scope to anything.

**What actually existed, honestly stated:**

- **The ceiling half is real but dormant.** `allowed_principals` on
  `PermissionRule` (`services/api/src/api/models/plugin_table.py`) is the
  mechanism §7 describes, and it works. But `system:agent-runtime` names no
  Core model's permissions block anywhere — the string appears only in its own
  field definition and in tests. No instance has ever granted an agent read
  access to a table, so the ceiling has never had anything to intersect with.
- **The declared-scope half did not exist at all.** Before this amendment, the
  "agent" action's authorable fields
  (`services/api/src/api/schemas/orchestration.py`) were exactly `agent_name,
  instructions, goals, model, max_turns, delivery` — the code's own comment
  said outright that tools and read scope were "deliberately absent in M1."
  There was no `read_scope` config field, no Pydantic model, no column, and
  therefore nothing an author-time validator could check a ceiling against.
  "Authoring-time validation still applies" was true of nothing.

**Decision: `read_scope` stays deferred, deliberately, not because it is hard
but because it has no consumer.** `docs/guides/agentic-workers.md` already
records that no worker has ever read a Core table — every worker so far is
enrichment over an event payload plus (optionally) web search. Building a
declared-scope field, its authoring-time validator, and the ceiling ∩ scope
intersection logic now would be speculative machinery serving a need nobody
has yet. This is the same deferral bias §3's catalog and §9's memory already
use, for the same reason: it is purely additive later, and guessing its shape
now is more likely to be wrong than useful. When the first worker actually
needs a table read, building `read_scope` for it — with a real consumer to
validate the design against — is the right time, not before.

**Tools, by contrast, already had a working runtime with no authoring path —
that gap is closed, not deferred.** `declared_tools()` / `resolve_tools()`
(`services/_plugins/agent-runtime/src/agent_runtime/tools.py`) were fully
functional before this amendment, but the "agent" action's `config_fields`
catalog had no `tools` entry, so nothing validated a declared tool name at
save time — `_validate_action_config` did not reject it, and the only way a
`tools` value reached a run was hand-editing `action_config` directly,
bypassing the review the portal builder otherwise provides. This amendment's
companion change adds `tools` to the catalog as an authoring-time-validated
field, checked against the runtime's registry the same way `_validate_delivery`
already validates the `delivery` sub-config. Low risk, because the runtime
side of this contract was never in question — only the missing front door was.

**Net effect on §7:** the ceiling and the tool registry are both load-bearing
and correctly described. The declared *read* scope is the one piece that was
never built, and is now explicitly marked deferred rather than left to imply,
by present-tense prose, that it exists.

---

## Related Decisions

- [ADR-0002](0002-api-only-data-integration-pattern.md) — why the runtime reaches Core over HTTP and never touches the database.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — the plugin system this deliberately does not use, and why.
- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the declarative permission model §7 extends to a new principal type.
- [ADR-0009](0009-internal-service-authentication.md) — how the runtime authenticates to Core (SigV4, allowlisted service principal).
- [ADR-0010](0010-event-registry-and-trigger-consolidation.md) — the event registry §4 and §5 bind to; the one-place rule that shapes §5.
- [ADR-0012](0012-identity-provider-seam.md) — the identity seam a future user-delegated run principal resolves through.
- [ADR-0013](0013-plugin-extension-contract.md) — the third-party plugin contract; its UI bound is why this is core capability.
