# ADR-0016: The prompt assistant — a synchronous, streaming agent that helps author prompts

**Status:** Proposed
**Date:** 2026-07-23
**Amended:** 2026-07-23 — see *Amendment: buffered, not streamed (Python-runtime reality)*
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

Authoring an agent worker (ADR-0014) or a prompt-library component (ADR-0015)
still means facing a blank textarea. The intended remedy (issue #474) is an
**interactive chatbot that helps shape the prompt** — a user converses with an
assistant, which drafts and refines `instructions`, `goals`, and reusable
components, aware of what already exists in the library.

That single word — *interactive* — is the crux. The agent framework is
deliberately **asynchronous and EventBridge-only**: ADR-0014 §4 states "invocation
is EventBridge, and only EventBridge; there is no synchronous invocation path,"
and §6 explicitly deferred synchronous agents ("foreseeable but out of scope").
But §6 also did the work to make this addable later, baking four
invocation-agnostic choices into the run model *for exactly this moment*:

1. an agent run is its own record (so a sync path is `request → run`, not
   `event → workflow → run`);
2. `run_as: {system | user}` (a chatbot is user-invoked → `run_as: user`);
3. an internally-incremental loop (so streaming is a consumer, not a rewrite);
4. a nullable `thread_id` (a *chat is a thread of runs sharing history*).

This ADR is the moment §6 anticipated. It is also the largest single step the
framework has taken, because it sits at the convergence of three deferred
foundations: **§6** (the synchronous, streaming path), **§7 / #452**
(`run_as: user`, exercised for the first time), and **ADR-0015** (the assistant's
output is prompt-library content). That convergence is the value — one concrete
feature validates all three — and the reason it must be phased rather than built
at once.

## Amendment: buffered, not streamed (Python-runtime reality) — 2026-07-23

Before any code, implementation surfaced a hard fact that invalidates a premise
of §3 and §4 below, so they are corrected here rather than left to mislead.

**The finding (verified against AWS docs).** Lambda response streaming is
supported only on **Node.js managed runtimes**; for Python you must use a *custom
runtime* or the *Lambda Web Adapter*. The agent runtime is managed `python3.13`,
so it **cannot stream a response at all** — regardless of ingress. (A related
correction: streaming *can* now traverse API Gateway too, not only a Function URL
as §3 assumed — but that is moot, since the blocker is the Python runtime, not
the ingress.)

So real streaming would require re-architecting the runtime (custom runtime or
LWA) on a security-critical public path — a large, novel-infra change bought for a
*nicety* on an authoring assistant.

**The decision: buffered request-response, no streaming (for now).** Each user
turn is one request returning the full reply. This changes the ingress
architecture in §3 as follows, and is a net simplification:

- **Ingress is Core's existing API Gateway, with its existing Cognito auth** —
  **not** a new Function URL on the runtime. This eliminates the new public
  surface, in-runtime JWT verification, CORS, and the custom-runtime problem
  entirely. It also aligns with §5: Core already authenticates the user and
  assembles context; it now also fronts the turn.
- **Core synchronously invokes the runtime** (`lambda:InvokeFunction`,
  RequestResponse) for the LLM turn. The runtime keeps the **same OpenRouter
  client** (§4) but uses its existing full-response `complete()`, not streaming.
  The runtime gains an internal *direct-invoke* dispatch case alongside its
  EventBridge subscription — both AWS-internal, neither public.
- The runtime therefore **stays a pure internal service** (invoked by EventBridge
  or by Core), never a public ingress. ADR-0009 (service identity) and ADR-0002
  (runtime never touches the DB) are untouched.

**New constraint this accepts:** API Gateway caps integration at ~29s, so a turn
must complete within it. The §8 cost ceilings (bounded output, wall-clock) are
sized to fit. If a turn ever legitimately needs longer, the fallback is a
*buffered* (non-streaming) Function URL on the runtime — 15-minute timeout — at
the cost of a new public surface and in-runtime auth (which is why it is the
fallback, not the default).

**Effect on the Stage-1 work already merged:** the streaming path added to the
OpenRouter client (#489) is dormant, kept for a future streaming revisit; the
shared `biffo-cognito-auth` verifier (#492) remains valid as a clean extraction
Core uses, though its runtime-side verification motivation is removed by
Core-as-ingress. Neither is reverted.

§3 and §4 below are read through this amendment: "Function URL" → "Core API
Gateway ingress + sync invoke of the runtime"; "streaming" → "buffered
`complete()`". §1, §2, §5, §6, §7 (minus the Function-URL specifics), §8 stand.

---

## Decision

**The prompt assistant is a synchronous, streaming *thread of agent runs*,
invoked by an authenticated user through a Lambda Function URL into the existing
runtime, reading authoring data under the user's own authority, and emitting
draft prompt content into the authoring UI. It reuses the runtime, the run/thread
model, and — critically — the one OpenRouter client. It is not a workflow.**

### 1. It reuses the runtime and the run model — it is not a worker

The assistant is not a `WorkflowDefinition`, has no trigger, and is never
dispatched by the orchestrator. It reuses the *runtime* (the OpenRouter loop,
fencing, cost accounting) and the *run/thread record* (ADR-0014 §6), through a new
**synchronous** entry point. The distinction ADR-0014 bundled — the **worker**
concept (definition + trigger + async dispatch) versus the **runtime + run model**
(LLM machinery + audit record) — is separated here: the assistant takes only the
second.

Its own system prompt (what makes it good at helping author) is a **built-in
platform capability**, not a user-authored worker definition — authoring the
authoring-assistant would be circular.

### 2. A chat is a thread of runs; history lives in Core

Each user turn creates a **run** carrying the conversation's `thread_id`
(ADR-0014 §6.4). Prior turns' messages are the thread history, assembled as
context for the next turn. Thread and message state live in **Core** (ADR-0002);
the runtime holds none. A run is still one invocation-to-completion; a thread is
the sequence. This is the first use of `thread_id`, which §6 added and left dormant
for precisely this.

### 3. Synchronous, streaming ingress via a Lambda Function URL

ADR-0014 §6 flagged that response streaming needs a **Lambda Function URL**, not
API Gateway REST. So the runtime gains a Function URL as a second entry point
(alongside its EventBridge subscription), serving streamed responses. This is a
new **public, user-facing** ingress and is treated as a first-class security
surface (§7 below).

### 4. The same OpenRouter client — extended with streaming, not forked

The assistant uses the **same** `openrouter.py` client the async runtime uses —
same SSM-resolved key (`OPENROUTER_API_KEY_PARAMETER`), same model handling, same
cost accounting. There is no second LLM integration and no second key.

The client is non-streaming today (its docstring: "deliberately thin — no
retries, no streaming"). This ADR **adds a streaming call path to that same
client** — SSE from OpenRouter streamed out through the Function URL — alongside
the existing full-response `complete()` the async workers use. Streaming becomes a
capability of the one client, exercised first by the assistant (§6's
"streaming is a consumer" made real). Model selection reuses the same curated
mechanism; the assistant's model is a platform config value, not per-user.

### 5. Reads happen under the user's authority — but the runtime keeps its service identity

The assistant is **library-aware**: it reads existing prompt components (ADR-0015)
and agent definitions to suggest reuse and build on patterns. Two decisions make
this safe and bounded:

- **It reads via the existing admin CRUD APIs, not §452's generic read-scope
  route.** Components and definitions are *authoring* data with purpose-built
  endpoints (ADR-0015's `/admin/prompt-components`, orchestration's definition
  CRUD). §452's generic ceiling exists for arbitrary *business* tables and is
  **not** needed here. **Consequence:** being library-aware does *not* pull in
  the §452 consumer build; that route stays genuinely deferred until a worker
  needs to read business data.
- **Core assembles the context under the user's authority; the runtime does not
  authenticate as the user.** The Function URL request carries the user's Cognito
  identity. Core performs the authoring-data reads with *that user's* permissions
  and hands the assembled context to the runtime — the same shape as an async
  worker receiving its payload. The runtime keeps its SigV4 service identity
  (ADR-0009) and never touches the database (ADR-0002). So `run_as: user` here
  means *the authority for what was read is the user's*, enforced Core-side —
  not "the runtime acts as the user."

This is the first exercise of `run_as: user`. It composes with §7's model as
`ceiling ∩ declared scope ∩ the user's own permissions`, but for authoring data
the first two terms are the existing admin endpoints' own permissioning.

### 6. Output is draft prompt content handed to the authoring UI

The assistant produces draft `instructions`, `goals`, and/or component bodies.
These are **surfaced to the user in the builder** — a "use this" affordance that
populates the ordered-parts editor or the component form (ADR-0015 Phase 2). The
assistant never writes a definition or a component itself; the human reviews and
saves through the existing authoring surfaces. This keeps the write path exactly
where ADR-0014 §5 put it (agents do not write business/authoring data; a human,
or a consumer on its own authority, does).

### 7. The Function URL is a first-class security surface

A public, user-facing, streaming ingress invoked with a user identity gets the
scrutiny the async internal routes got:

- **Authenticated:** the Function URL verifies the caller's Cognito JWT; an
  unauthenticated or non-admin caller is rejected. It is not open.
- **The untrusted-input model still holds.** The user's typed messages are
  untrusted content; any library text read in is third-party content. Both are
  fenced exactly as ADR-0014 §5/§7 require — the assistant's built-in system
  prompt is the instruction channel; conversation and read-in content are data.
- **Blast radius is small by construction:** the assistant reads authoring data
  under the user's own permissions and writes nothing — its output is a draft
  shown back to the same user. It cannot exfiltrate (no outbound tool beyond the
  LLM call) or mutate. The lethal trifecta is not present: there is no
  write/outbound channel.
- **Cost:** streamed chat turns are metered on the same per-run accounting; the
  §8 ceilings (max turns per run, wall-clock, and a bound on thread length) apply.

## Options Considered

### Reuse the runtime via a sync ingress (chosen) vs a separate prompt-drafting chat

A standalone chat feature (portal + a thin Core→OpenRouter endpoint) would ship
faster and skip the sync-ingress/thread/`run_as` work. Rejected: it is a second
LLM-invocation path — the duplication ADR-0014 Option D warned against (its own
model handling, fencing, cost, audit), a second place the OpenRouter key is used,
and it would reuse neither the run inspector nor the fencing. The user constraint
"must use the same OpenRouter mechanism" is decisive: one client, extended, not
two.

### Streaming (Function URL) vs request-response (API Gateway)

Request-response reuses the existing ingress and needs no streaming work, but
delivers a worse chat feel. Streaming was chosen for the interactive experience,
accepting the cost: a new public ingress surface (§7) and a streaming path added
to the OpenRouter client (§4).

### Library-aware via existing admin APIs (chosen) vs via §452's generic read route

Reading the library through §452's generic business-table ceiling would be
larger and would conflate authoring data with business data. Reading via the
existing purpose-built admin endpoints, under the user's authority, is bounded
and leaves §452 deferred. Chosen.

### The runtime authenticates as the user vs Core assembles context under the user's authority (chosen)

Threading a user identity into the runtime's own Core calls would make the
runtime a user-scoped caller and complicate ADR-0009's service-principal model.
Having Core assemble the reads under the user's authority and pass context to the
runtime keeps the runtime a pure service principal and ADR-0002 intact. Chosen.

## Consequences

### Positive

- The synchronous, streaming path §6 designed for finally exists, validating that
  design; and one OpenRouter client now streams, for every future sync need.
- Authors get conversational help that knows the existing library.
- Reuses the runtime, run/thread model, fencing, cost accounting, and the M5
  inspector — no second agent system, no second LLM path, no second key.
- `run_as: user` is exercised without making the runtime a user-scoped DB caller.
- Library-awareness does **not** force the §452 generic-read build; that stays
  deferred.

### Negative / Trade-offs

- **A new public, streaming ingress** (Function URL) is real new attack surface
  and new infra, mitigated by §7 but not eliminated.
- **Streaming is genuinely new** in the OpenRouter client and in the portal; the
  static-export/deploy caveats (ADR-0014 build notes) apply to the chat UI.
- **First `run_as: user` path** — the identity-to-Core-reads plumbing is new, even
  in the bounded "Core assembles context" form.
- **Largest single feature** in the framework; must be phased or it sprawls.

### Neutral

- Describes an architecture, not an implementation.
- Does not amend ADR-0014 §4's async-only rule for *workers*; the assistant is not
  a worker. It realises §6's provision for synchronous *runs*.

## Compliance / build phasing

Deliberately phased so each step is a working increment:

- **Phase 1 — the sync run/thread spine.** The Function URL ingress (Cognito-auth),
  a thread of runs in Core, `run_as: user` identity flow, and a streaming path
  added to the OpenRouter client. Delivers a streamed chat that drafts *from the
  conversation alone* — no library reads yet. Proves §6's sync path end to end.
- **Phase 2 — library-aware context.** Core assembles authoring-data context
  (components + definitions) under the user's authority and feeds it to the
  assistant. Delivers the "aware of what exists" help.
- **Phase 3 — authoring-UI handoff.** The chat UI in the portal and the "use this"
  affordance that populates the ordered-parts editor / component form.

Phase 1 is the load-bearing one (it is where the new ingress, streaming, and
`run_as: user` all first appear); Phases 2–3 layer capability onto it.

## Related Decisions

- [ADR-0014](0014-agentic-worker-framework.md) — the agent framework; §4
  (async/event-only for *workers*), §5/§7 (untrusted-input fencing, the write
  boundary), §6 (the synchronous-run provisions this realises), §8 (cost ceilings),
  §10 (the run record the thread is built from).
- [ADR-0015](0015-prompt-library.md) — the components the assistant reads and drafts.
- [ADR-0009](0009-internal-service-authentication.md) — the runtime's service
  identity, kept intact by §5's "Core assembles context" choice.
- [ADR-0002](0002-api-only-data-integration-pattern.md) — why the runtime never
  reads the DB directly, even for the user's data.
- #474 (this feature's issue), #452 (§7 read-scope ceiling — deliberately *not*
  pulled in; §5 explains why).
