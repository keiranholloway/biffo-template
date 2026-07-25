# ADR-0015: Prompt library — composable, parameterised prompt components

**Status:** Accepted
**Date:** 2026-07-23
**Accepted:** 2026-07-23
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

An agent worker (ADR-0014) is a `WorkflowDefinition` whose `instructions` and
`goals` live inline in its `action_config`. There is **no reuse**: two similar
workers duplicate their prompt text, and improving a phrasing means editing every
worker by hand. As agents multiply this compounds, and it is friction on exactly
the authoring experience ADR-0014's builder work set out to improve.

ADR-0014 §3 deliberately deferred *cross-instance* definition sharing ("no
catalog mechanism is built… copying JSON by hand is sufficient for now"). This
ADR addresses the distinct, nearer need: **in-instance reuse of prompt content.**

Two concrete reuse scenarios drive the design; the others were considered and
explicitly excluded:

- **Shared components / house style** — a clause reused across many agents
  ("state confidence per claim", "cite sources", a standard tone). *In scope.*
- **Parameterised family** — many agents that are the same task with different
  parameters (the same lead-scorer per region/brand). *In scope.*
- **Clone-and-tweak whole templates** — *excluded.* A clone drifts from its
  source and preserves the duplication problem this ADR exists to remove.
- **Cross-instance sharing** — *excluded here*; remains ADR-0014 §3.

The two in-scope scenarios are not two features. They are one model seen twice: a
prompt assembled from reusable **components**, some of which carry **author-time
variable slots**. House style is a component with zero variables; a parameterised
family is a component with variables, referenced by several definitions that each
supply different values.

## Decision

**A prompt is composed from ordered parts — inline text and references to
reusable, optionally-parameterised components. Components are referenced, not
copied. Composition is resolved in Core at run-creation and frozen into the run
snapshot. Variables interpolate author-time values only.**

### 1. `PromptComponent` — the library entry

A new Core table, `TenantScopedModel` (in-instance, single-tenant per ADR-0001):

- `name` — the referenceable identifier.
- `description` — what it is for (drives the authoring picker).
- `body` — the prompt text, which may contain variable placeholders.
- `variables` — declared slots: `name`, `description`, `required`, optional
  `default`. Zero variables is the house-style case.

**Mutable in place. No version table** — see §3; live resolution plus the run
snapshot *is* the history, so versioning is deliberately not built.

### 2. Composition is an ordered list of parts

`instructions` and `goals` each become an **ordered list**, where every part is
either:

- `{inline: "<text>"}` — bespoke text authored on this definition, or
- `{component: "<name>", values: {<var>: <value>, …}}` — a reference to a library
  component, with author-time values for its declared variables.

Parts resolve in order. A house-style agent is `[{component: house-style},
{inline: "the bespoke task"}]`; a parameterised-family member is simply
`[{component: lead-scorer, values: {region: "Midlands"}}]`. There is **no
separate "family" object** — a family is N definitions referencing one component
with different `values`.

### 3. Reference, not copy — with live resolution and a per-run snapshot

A definition **references** components; it does not snapshot them at author time.
Editing a component propagates to every referencing agent — which is the entire
point, since copy would leave the duplication this ADR removes.

Propagation is governed by **live resolution + per-run snapshot**:

- At **run-creation**, Core resolves the definition: fetch the referenced
  components (their current text), substitute the author-time values, compose the
  ordered parts, and write the **resolved** `instructions`/`goals` into the
  ADR-0014 §10 run snapshot.
- So a run always uses the latest component text *as of when it ran*, and the
  snapshot records exactly what it ran. Propagation is immediate; reproducibility
  is exact. These do not conflict because resolution is a definition-time concept
  and the run is always a snapshot.

### 4. Resolution is Core-side — the runtime does not change

Because resolution happens at run-creation and the snapshot holds the *resolved*
prompt, `agent-runtime` continues to read `instructions`/`goals` from the snapshot
exactly as it does today (ADR-0014). **It never learns that components exist.**
The prompt library is entirely a Core + authoring concern. The M5 run inspector
already renders the snapshot's system message, so the composed result is already
inspectable.

This is the direct consequence of resolve-then-snapshot, and it is a deliberate
simplification: no runtime change, no new cross-service contract.

### 5. Variables interpolate author-time values only — enforced by construction

A variable's value comes from the definition's `action_config` (authored when the
worker is defined). **There is no mechanism to source a value from runtime data**
— a form field, a tool result. This is not a runtime check that could be
forgotten; it is a structural property: `values` exist only as static authored
config.

This matters because interpolating untrusted runtime data into a component body
would inject it into the **instruction** channel, bypassing the `<untrusted-
context>` / `<untrusted-tool-result>` fencing ADR-0014 §5/§7 depends on. The
parameterised-family scenario is naturally the safe kind — "one agent per region"
sets `region` at authoring time — which is why it fits without a runtime variable
mechanism, and why one must not be added without revisiting §5/§7.

### 6. Failures are loud, at the earliest point

- **Author-time** (`create`/`update` of a definition): validate that every
  referenced component exists and that supplied `values` match the component's
  declared `variables` (all required present; no undeclared keys). Fail the save.
- **Run-creation:** if a referenced component was since deleted, or a required
  variable is unsupplied, **abort the run creation loudly** rather than emit a
  broken or half-substituted prompt — the same posture as ADR-0014 §8's depth
  ceiling.

## Worked scenarios

**House style** (shared component, no variables):

```
PromptComponent house-style: body="State confidence per claim. Cite sources. Be concise." variables=[]
Agent A .instructions = [ {component: "house-style"},
                          {inline: "Assess this demo request for legitimacy and brand size."} ]
```
Editing `house-style` updates every referencing agent's next run; each run
snapshots the text it used.

**Parameterised family** (component with a variable, one definition per member):

```
PromptComponent lead-scorer: body="Score leads for {{region}}. Prioritise operators HQ'd in {{region}}."
                             variables=[{name:"region", required:true}]
Member Midlands .instructions = [ {component:"lead-scorer", values:{region:"Midlands"}} ]
Member London   .instructions = [ {component:"lead-scorer", values:{region:"London"}} ]
```
Editing the template propagates to both members on their next run. The `region`
value is static authored config — trusted by construction.

## Options Considered

### Composition model — ordered parts (chosen) vs bespoke-text-plus-attached-components

Bespoke text + an attached list of components is a smaller first step, but it
models a family member awkwardly (empty bespoke text, one attached component that
*is* the whole prompt) and fixes the position of shared blocks. Ordered parts
models both scenarios cleanly and interleaves freely, at the cost of a richer
authoring UI. Chosen because the family case is first-class in it and it does not
foreclose anything.

### Reference vs copy — reference (chosen)

Copy is safe and needs no versioning story, but it preserves the exact
duplication this ADR removes: improving a shared phrasing would mean editing every
copy. The stated need is propagation, so reference is chosen; the §10 snapshot
makes it safe.

### Propagation — live resolution + snapshot (chosen) vs pinned versions

Pinned versions with explicit upgrade never surprise a live agent, but reintroduce
per-agent action (dilating the "make reuse easy" goal) and require building a
version model now. Live resolution + the §10 snapshot gives immediate propagation
with exact run history and no version table. Its residual risk — editing a shared
component silently changes live agents' behaviour — is real; it is mitigated by
run history and, later, an "affected agents" preview on edit (not built now).

### Runtime-side vs Core-side resolution — Core-side (chosen)

Resolving in the runtime would require the runtime to fetch components and re-
implement composition, and a new cross-service contract. Core-side resolution at
run-creation writes the resolved prompt into the snapshot the runtime already
consumes, so the runtime is untouched. Chosen.

## Consequences

### Positive

- Kills the duplication: a phrasing fixed once propagates everywhere it is used.
- Parameterised families become trivial — one component, many definitions.
- The runtime is untouched; the change is Core + authoring only.
- Reproducibility is preserved for free — the §10 snapshot already records the
  resolved prompt.
- The untrusted-interpolation risk is closed by construction, not by a check.

### Negative / Trade-offs

- **Editing a shared component changes live agents' behaviour** on their next run.
  Accepted as the cost of propagation; an "affected agents" preview and the run
  history are the mitigations. Do not add a runtime variable source without
  revisiting §5/§7.
- **Ordered-parts authoring is a richer UI** than two textareas — Phase 2 work.
- **No versioning** means you cannot pin an agent to an old component revision.
  Deliberate; if it is ever needed, it is additive (a version table plus a pin on
  the reference) and does not invalidate anything here.

### Neutral

- This ADR is in-instance only. Cross-instance distribution of components remains
  ADR-0014 §3, and would layer on top.
- Describes an architecture, not an implementation.

## Compliance / build phasing

- **Phase 1 — functional core.** `PromptComponent` model + CRUD API; Core-side
  resolution at run-creation (compose ordered parts, substitute variables);
  author-time and run-creation validation; fail-loud. Runtime untouched.
  Authorable via the API to begin with.
- **Phase 2 — authoring UX.** The ordered-parts builder and the component-
  management surface in the portal.
- **Deferred / adjacent.** Cross-instance sharing (ADR-0014 §3). The #474
  authoring assistant could *generate* components, and a worker that *reads* the
  library would be a consumer of the ADR-0014 §7 read-scope ceiling (#452).

## Implementation

The design is fully implemented in `services/api/src/api/prompt_parts.py` (242 lines),
which defines the `PromptComponent` model, composition logic, and live-resolution
at run-creation. The module is imported by `internal_agents.py` and `orchestration.py`
and is exercised in production code paths. A comprehensive test suite validates the
model, resolution, and error cases in `services/api/test/test_prompt_parts.py`.

## Related Decisions

- [ADR-0014](0014-agentic-worker-framework.md) — the agent framework; §3
  (deferred cross-instance catalog), §5/§7 (untrusted-input fencing — the
  variable-trust constraint), §10 (run snapshot — the reproducibility invariant).
- [ADR-0004](0004-generic-crud-layer-and-table-permissions.md) — the CRUD/permission
  model a `PromptComponent` admin surface fits into.
- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) —
  `PromptComponent` is tenant-scoped like every other table.
- #475 (this design's exploration issue), #474 (authoring assistant), #452
  (read-scope ceiling).
