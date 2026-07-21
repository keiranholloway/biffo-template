# ADR-0014: Agentic workers — framework is code, workers are data

**Status:** Proposed
**Date:** 2026-07-21
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

### 2. Workers are data, authored in the portal

A worker is a **row**, created and edited through the admin UI by an authenticated platform user — not an installed artifact. "Installed more than once" is "create another row."

Whether that row lives in its own `agent_definitions` table or inside the binding workflow's `action_config` is **left to implementation**. The thesis is that workers are data; which table holds them is not load-bearing, and the extraction migration is trivial while worker counts are small. §4 explains why the usual reason to separate them — reuse across triggers — is not expected here.

### 3. Cross-instance sharing is a definition catalog, not a code registry

Workers travel between Biffo implementations as **versioned JSON definitions** — a catalog imported into an instance as new rows, with an alias. Upgrading is re-importing a newer version, with conflict handling when the local copy has been edited.

This is deliberately *not* the plugin registry. That registry distributes code and has shipped `plugins: []` since it was built; almost everything worth sharing here is configuration.

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
- **Core emits, not the runtime.** The runtime posts its result to Core; Core persists the run and emits through the existing post-commit buffer, so a run and its event cannot diverge.
- Terminal failures emit too, with status in the payload. A subscriber must be able to distinguish "failed" from "still running."

The security consequence is the point: **consumers act on their own authority.** An LLM-driven process never needs write access to business data, and chaining composes through the bus rather than through agent configuration.

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

A worker cannot grant itself anything outside the ceiling, so editing a definition can never widen access. Scope is expressed as `(table, operation)` pairs — the primitives ADR-0004 already uses — not a new addressing scheme.

**The ceiling reuses ADR-0004 rather than adding a mechanism.** The runtime resolves to a principal holding a single pseudo-role, `agent-runtime`. A table becomes readable by agents by naming that role in its `__crud_permissions__` read entry, and in no other way. Three properties follow for no new machinery:

- **Thin by default.** No table names the role, so a freshly scaffolded instance grants agents nothing at all. The ceiling starts empty and is widened one table at a time.
- **Widening is a reviewed code change, not an admin toggle.** The grant lives beside the model, so it arrives as a PR and a deploy. It cannot be escalated by whoever holds admin rights at the time — which is what makes this a genuine second layer rather than a restatement of the declaration.
- **Default-deny, 404-on-undeclared, and unconditional tenant scoping** are inherited unchanged from the existing handler path.

**Writes are not reachable through this path at all.** `agent-runtime` is never granted create, update or delete. A run's only write is completing itself, through a purpose-built internal route authorised by the run's own identity and state rather than by generic CRUD. A worker needing to write business data is a new decision requiring an amendment to this ADR — the right amount of friction for the thing §5 exists to prevent.

**Authoring-time validation** still applies: saving a worker verifies both that its declared scope sits inside the ceiling, and that the *author* holds the permissions it declares. Failing at save beats failing at run.

In v1 every run is `run_as: system`, so user-delegated authority is **designed for but not exercised**. Note what is and is not deferred: the ceiling and the declared scope are both live from the first run, and only the third term is missing. When `run_as: user` arrives it composes as `ceiling ∩ declared scope ∩ the user's own permissions`, with no change to the first two.

### 8. Cost and recursion are bounded by the framework, not by convention

Per-worker `max_turns`, token ceilings and wall-clock timeouts are enforced with hard stops. Events carry `causation_id` and `depth`, and dispatch refuses past a maximum depth — because event-triggered processes that emit events can cycle, and here each iteration has an invoice attached.

### 9. Memory is deferred, with two guardrails

Three distinct things get called memory. **Thread history** — a run's message array, grouped by `thread_id` — is the only one v1 has, and §6 already provides it. **Working memory** (key/value an agent carries across runs) and **semantic recall** (vector search) are both deferred: each is purely additive, and no early worker needs either. Enrichment is stateless per subject.

Two constraints apply when they do arrive:

- **Memory is not retrieval.** Memory is what an agent remembers; retrieval is what it can look up. Vector search over business data is RAG — it belongs in the tool registry as a declared read tool subject to §7's ceiling, not in a memory subsystem. Blurring the two means building an embedding pipeline to serve a need the tool registry already covers.
- **Working memory is a write, and §7 forbids writes.** It would be the first exception to "writes are not reachable through this path at all", so it arrives as a deliberate amendment to §7 rather than a quiet addition — and namespaced per agent, not by opening the write path generally.

---

## Options Considered

### Option A — framework as core capability, workers as data (chosen)

**Pros:** matches the orchestration precedent exactly; satisfies multi-install trivially; JSON is available; custom authoring UI is unconstrained; distribution reuses `core upgrade`.

**Cons:** every instance carries the framework whether or not it uses agents. Optionality is by configuration (no workers defined) rather than by installation.

### Option B — one ADR-0003 plugin per worker

**Rejected.** Fails the explicit multi-install requirement — `services/<name>/`, `modules/plugins/<name>/` and table names all collide on a second install. The manifest's six scalar column types cannot express a worker definition. And under ADR-0013 the authoring UI would be bounded by declarative capabilities that cannot express a prompt editor.

### Option C — one plugin as the framework, workers as its rows

**Rejected, but the closest alternative.** Structurally reasonable and it becomes more plausible once ADR-0013 is implemented. It fails today on the UI constraint: ADR-0013 explicitly accepts that plugins cannot have novel UI, and agent authoring needs it. Worth revisiting if the UI capability contract ever grows to cover bespoke pages.

### Option D — async now, a separate mechanism for sync chat later

**Rejected.** It duplicates the definition schema, the tool registry, and the permission model. The failure mode of two permission models is a scoping bug fixed in one path and not the other — the worst class of bug to invite deliberately. §6 gets the optionality for a few hours of care instead.

---

## Security model

The first intended worker enriches inbound demo requests, and it demonstrates the risks generally rather than incidentally.

- **Untrusted input reaches the model.** The demo form is public and attacker-controlled; a company-name field flows into agent context and then into web searches. Form fields must land in an **untrusted context channel kept structurally separate from instructions**.
- **Untrusted output must not be broadcast.** Enrichment text is LLM output derived from a public form and web results. It stays behind an API fetch (§5) rather than being pushed to every subscriber.
- **The trifecta is bounded by construction.** Access to private data, exposure to untrusted content, and an outbound channel is the dangerous combination. §5 removes the third by giving agents no write surface beyond their own run record.
- **PII leaves the platform.** Prospect name, email, company and role are sent to a third-party LLM provider from a UK business operating in `eu-west-2`. This requires an explicit processing decision and a DPA — and redaction of fields the task does not need. Brand enrichment does not need an email address.
- **Cost is an availability concern**, not just a budget one. §8 treats it as such.

---

## Open questions for review

1. ~~**Trigger binding UX.**~~ **Resolved.** Split into three decisions with different deferability: agents reuse `WorkflowDefinition` rather than carrying trigger fields (decided, §4 — the only non-deferrable part); which table holds a worker definition is left to implementation (§2); the authoring UX is deferred entirely as a UI concern. One agent, one trigger.
2. ~~**Memory.**~~ **Resolved.** All three kinds deferred (§9); thread history from §6 is the only memory v1 has. Deferral locks nothing in — each is additive. Two guardrails recorded because both are free now and each prevents a wrong turn later: memory is not retrieval, and working memory collides with §7's no-writes stance.
3. **Catalog location and format.** A git repo of versioned JSON is the obvious start. Does it want a CLI verb (`biffo agent import`), or is portal-side import enough?
4. **Definition versioning.** Do edits to a live worker version it, or mutate in place? Run reproducibility argues for versioning; authoring ergonomics argue against.
5. **Where the first worker's read scope actually points.** The demo/lead table is instance-owned (tabsii), not template. Worker definitions are therefore instance-scoped in what they read, and a shared catalog needs table references parameterised.

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
- **The ceiling is deliberately inconvenient to widen.** Granting agents a new table means a PR and a deploy, not an admin screen. That is the point, and it will still be irritating the first time a worker needs a table nobody anticipated.
- **Async-only** rules out conversational agents until the sync edges are built.

### Neutral

- This ADR describes an architecture, not an implementation. Nothing in it is built.
- It does not amend ADR-0013. That contract governs third-party plugins; this is core capability, in the same tier as the orchestration engine.

---

## Related Decisions

- [ADR-0002](0002-api-only-data-integration-pattern.md) — why the runtime reaches Core over HTTP and never touches the database.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — the plugin system this deliberately does not use, and why.
- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the declarative permission model §7 extends to a new principal type.
- [ADR-0009](0009-internal-service-authentication.md) — how the runtime authenticates to Core (SigV4, allowlisted service principal).
- [ADR-0010](0010-event-registry-and-trigger-consolidation.md) — the event registry §4 and §5 bind to; the one-place rule that shapes §5.
- [ADR-0012](0012-identity-provider-seam.md) — the identity seam a future user-delegated run principal resolves through.
- [ADR-0013](0013-plugin-extension-contract.md) — the third-party plugin contract; its UI bound is why this is core capability.
