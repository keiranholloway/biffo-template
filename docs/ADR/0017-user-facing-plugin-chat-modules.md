# ADR-0017: User-facing plugin chat modules — generalising the buffered chat spine

**Status:** Accepted
**Date:** 2026-07-23
**Deciders:** Keiran Holloway (Technical Architect)

---

## Context

ADR-0016 (buffered amendment) gave Biffo a **synchronous chat spine**: Core is the
ingress — it authenticates the user, fences their message as untrusted data,
assembles the turn (trusted system prompt + bounded thread history + fenced user
message), synchronously invokes the agent-runtime Lambda, and persists the turn as
a *run in a thread* (#497). The runtime stays a pure internal service — it never
touches the database (ADR-0002) and is not a public surface.

That spine works, but it is **welded to a single agent**: the prompt assistant.
`routers/admin/agent_chat.py` is `require_admin`-gated and hard-wired to
`ASSISTANT_AGENT_NAME`, `ASSISTANT_SYSTEM_PROMPT`, and the `agent_assistant_*`
settings. There is exactly one system prompt, one gate, one model.

The forcing case is the **Ideation Engine** (`biffo-plugin-ideation`): the first
user-facing, agentic *plugin* module. Its orchestration is already built and
tested against a `CoreGateway` port — a `founder`-gated, 3–5-turn challenger chat
that drafts a PRD, then an async analyst run that scores viability and returns a
structured report via a `submit_ideation_report` tool call. It needs the same
buffered spine the prompt assistant uses, but with **its own** system prompt,
agent name, model, group gate, and a plugin-declared structured-output tool.

This ADR generalises the spine so any module — first-party or marketplace plugin —
can drive a buffered, group-gated chat, without weakening the security properties
ADR-0016 established. It also answers the question left open since ADR-0013: **can
a third-party plugin host a customer-facing agentic module?** The binding
constraints are unchanged and non-negotiable:

- **Data always lives in Core** (ADR-0002). Modules *declare* tables; Core owns,
  deploys, and serves them. Access is via the API, never a DB client.
- **Plugins are marketplace artifacts.** Their code is not trusted to run inside
  the Core Lambda process. Whatever a plugin contributes must cross a well-defined,
  authenticated seam.
- **Front-ends always use the APIs** — no direct DB connections; the API writes
  and emits the EventBridge event.
- **Shared Cognito** is the identity provider for all surfaces (ADR-0007, #492's
  shared `packages/cognito-auth` verifier).

## Decision

Generalise the buffered spine along five seams. The through-line: **the trusted
work (which system prompt, fencing, assembly, invoke, persist) stays inside Core,
keyed by an install-time–vetted registration; the plugin contributes only data it
is allowed to contribute, across an authenticated seam.**

### 1. A chat-agent registry (the trusted instruction channel, keyed)

Introduce a **registered chat agent**: an immutable record, established at plugin
install (ADR-0003 review-PR flow) and stored Core-side, that pins everything the
turn engine needs:

```
chat_agent:
  agent_key:               "ideation-challenger"     # stable handle
  system_prompt:           "<the challenger instructions>"   # the trusted channel
  model:                   "anthropic/claude-sonnet-4"
  required_group:          "founder"                  # Cognito group gate
  max_history_messages:    40
  max_output_tokens:       1024
  timeout_seconds:         20.0
```

A chat-turn request carries the **`agent_key`, never prompt text**. The founder
cannot supply, override, or read the system prompt — it is resolved server-side
from the registration. This preserves ADR-0016 §1's central property (the
instruction channel is trusted and not attacker-controlled) while letting the
*prompt author* be a plugin developer rather than a platform constant: the trust
comes from the **install-time review**, not from the prompt being built in.

The prompt assistant becomes the first registered agent
(`agent_key: "prompt-assistant"`, `required_group: "admin"`), authored in-tree —
its system prompt stays a platform constant, now stored as its registration rather
than a module-level string. No behaviour change for it.

### 2. Generalise `agent_assistant.py` into an agent-agnostic turn engine

Extract the agent-specific constants (`ASSISTANT_SYSTEM_PROMPT`,
`ASSISTANT_AGENT_NAME`, the `agent_assistant_*` settings reads) out of the shared
machinery. `system_message()`, `user_turn_message()` (fencing + marker
neutralisation), `thread_history()`, `assemble_messages()`, `RuntimeInvoker` /
`LambdaRuntimeInvoker`, and `_result_from_payload` all become generic and take the
**resolved agent config** as input. Fencing and the untrusted-input framing are
unchanged — they simply operate on the resolved system prompt instead of the
baked-in constant. This is a pure refactor; the prompt-assistant path is rebuilt
on top of the generic engine to prove parity.

### 3. Two ingresses, one turn engine

The turn engine (resolve agent → assemble → invoke → persist run) is reached two
ways, differing only in *who authenticates the caller*:

- **Browser → Core (Cognito).** `POST /agent-chat/{agent_key}` — replaces the
  hard-wired admin route. Cognito-authenticated; gated by the **agent's
  `required_group`** (not a fixed `require_admin`). For agents whose ingress *is*
  Core — the prompt assistant, and any first-party in-tree chat.

- **Plugin Lambda → Core (service principal + forwarded user JWT).** `POST
  /internal/agent-chat` — for a plugin's own Lambda driving a turn on behalf of a
  founder. **Dual-authenticated:** the SigV4 `require_service_principal` (ADR-0009)
  proves it is a known service, *and* the founder's Cognito access token is
  forwarded and **re-verified in Core** via `packages/cognito-auth` (#492). Core,
  not the plugin, is the authority on the founder's identity and group membership;
  `run_as_user_id` is then cryptographically grounded, not merely asserted by the
  plugin. Both checks must pass: the service principal must be registered to drive
  that `agent_key`, and the forwarded user must be in its `required_group`. (Note:
  the service-principal↔`agent_key` binding is not yet enforced; see **Compliance**
  §3.)

Both paths converge on the identical turn logic and both persist a run with
`run_as_kind="user"` and the verified `run_as_user_id` (ADR-0014 §6).

### 4. Plugin orchestration runs in the plugin's own Lambda

A plugin's session-level orchestration — the Ideation state machine (gathering →
analysing → complete), the 3–5-turn budget, `finalise`, report extraction — runs
in the **plugin's own authenticated Lambda** (the ADR-0013 `http_ingress`
capability, now built for real for a *founder-gated user surface*), **never inside
the Core process**. That Lambda is the founder-facing ingress; it holds the
`CoreGateway` adapter and drives Core's capabilities over the API:

- the chat turn → `POST /internal/agent-chat` (seam #3);
- its declared tables → seam #5;
- the async analysis → the existing `agent.run.requested` path (ADR-0014), now
  carrying an inline output-tool (seam #5).

This is the concrete answer to ADR-0013's open question: **a marketplace plugin
hosts a user-facing agentic module by owning its ingress Lambda + frontend and
renting Core's capabilities across authenticated seams — Core keeps the data, the
fencing, and the LLM invoke.** No plugin Python ever executes in the Core Lambda.

### 5. Two smaller Core seams the plugin needs

- **Inline output-tool schemas on a run.** A run's `definition_snapshot` may carry
  a plugin-provided function-tool JSON schema (e.g. `submit_ideation_report`). The
  runtime offers it to the model alongside its built-in tools (e.g. `web_search`),
  so the analyst can return structured output as a tool call (ADR-0014 — the
  runtime does tools, not `response_format`). Extraction stays plugin-side (already
  built) in the module's `agent.run.completed` subscriber.

- **Service-auth, owner-scoped access to closed tables.** `ideation_sessions` /
  `ideation_reports` keep all generic-CRUD permissions **closed** (ADR-0004): no
  tenant-facing CRUD. The owning module's Lambda reads/writes them through Core as
  a **service principal carrying the verified founder identity**, with a
  **mandatory `owner_sub` scope** Core enforces on every call. The data stays in
  Core, closed to tenants at large, served only to the module acting for its owner.

## Options Considered

### Orchestration placement

#### Option A — Plugin code loaded into the Core process

Core dynamically loads the plugin's orchestration module and exposes its routes.

**Pros:** native DB access; no new ingress; lowest latency.

**Cons:** runs **untrusted third-party Python inside the Core Lambda** — an
unacceptable trust and blast-radius step for a marketplace; contradicts ADR-0002/
0003's sandboxing posture; one plugin bug or dependency can take down Core.

#### Option B — Plugin Lambda + Core capabilities over authenticated seams (chosen)

The plugin owns an authenticated ingress Lambda; Core exposes the capabilities.

**Pros:** no plugin code in Core; data stays in Core; matches "front-ends via API
only"; the seam is auditable IAM + JWT; each plugin is independently deployable and
blast-isolated; the same capabilities serve first-party and third-party alike.

**Cons:** an extra network hop per turn; revives the need to build ADR-0013's
authenticated `http_ingress` + a user-facing frontend host (deferred work, but
work Ideation needs regardless).

### Founder identity across the plugin→Core seam

#### Option A — Plugin asserts the founder id

The plugin Lambda, having gated its own founder, tells Core "this is founder X".

**Pros:** simplest; one hop, no token forwarding.

**Cons:** Core trusts a plugin's unverified claim about *who* the user is; a
compromised or buggy plugin can act as any founder. Identity provenance is only as
strong as the weakest installed plugin.

#### Option B — Forward the founder's Cognito token; Core re-verifies (chosen)

The plugin forwards the founder's access token; Core verifies it with the shared
JWKS (#492) *and* checks the service principal.

**Pros:** `run_as:user` is cryptographically grounded; Core remains the identity
authority; defence in depth (plugin gate + Core gate); reuses #492.

**Cons:** the plugin must pass the token through; Core does a JWKS verify per turn
(already cached).

## Rationale

The deciding factor is **trust boundary integrity for a marketplace**. Everything
that must be trusted — the instruction channel, fencing, identity, the database —
stays inside Core, established either in-tree or at install-time review. Everything
a plugin contributes crosses an authenticated, least-privilege seam and is
re-validated by Core. Registration-by-key (seam #1) is what lets a plugin author a
prompt without the prompt ever being attacker-suppliable; dual-auth with a
forwarded JWT (seam #3) is what lets a plugin act *for* a user without becoming an
identity oracle. Option B on both forks costs a hop and some build work; Option A
on either quietly hands a marketplace plugin the keys to Core.

## Consequences

### Positive

- One buffered turn engine serves first-party and third-party chat alike; the
  prompt assistant is just its first registered agent.
- A marketplace plugin can ship a genuine user-facing agentic module (the Ideation
  Engine unblocks) without any plugin code in Core and without touching the DB.
- Identity and the instruction channel remain Core-owned and verifiable.
- The Ideation orchestration already targets exactly this shape (`CoreGateway`);
  the adapter becomes thin.

### Negative / Trade-offs

- Real new surface to build and secure: the registry, the generic `/agent-chat/
  {agent_key}` + `/internal/agent-chat` endpoints, inline output-tools in the
  runtime, service-auth owner-scoped table access, and (separately) the plugin
  `http_ingress` + frontend host.
- An extra network hop per founder turn (plugin Lambda → Core).
- Install-time prompt review becomes a security-relevant gate (a registered system
  prompt is trusted) — the review flow must treat it as such.

### Neutral

- The prompt assistant's behaviour is unchanged; it is rebuilt on the generic
  engine as the parity proof.
- The async analysis path is unchanged except for carrying an inline output-tool.

## Compatibility and lifecycle

Option B makes the plugin a **separately-lifecycled artifact** — its own repo,
dependency closure, IAM role, deploy cadence, and version. A Core upgrade never
rewrites plugin code (the plugin is distributed by the marketplace, ADR-0003, not
by `biffo core upgrade`, ADR-0006 — it is outside every template-owned path). The
only thing a Core upgrade can break is a **seam the plugin binds to**. This section
makes the resulting contract explicit, because it is the property that keeps
installed plugins working across Core releases.

### Capabilities are the unit of compatibility, and they are versioned

Each Core seam a plugin can bind is a **named, semver'd capability**, independent
of the Core release number:

- `chat-turn` — the buffered turn engine via `/internal/agent-chat` (seam #3).
- `agent-run-request` — kicking an async run (ADR-0014).
- `run-output-tool` — an inline function-tool schema on a run (seam #5).
- `owner-scoped-tables` — service-auth, owner-scoped access to CRUD-closed tables
  (seam #5).
- `chat-agent-registry` — registering a chat agent at install (seam #1).
- events (e.g. `event:agent.run.completed`) — each event schema is versioned too.

A breaking change to a seam bumps **that capability's major** — not merely the Core
version — so impact is scoped to the plugins that actually bind it.

### The plugin declares a dependency map at creation

At creation the plugin records, in its manifest, exactly which capabilities it
binds and at what version range — a **`core_capabilities` map** — plus a
`required_core_version` **floor** (the minimum Core that offers those capabilities
at all). The plugin uses `>=`/caret ranges: it opts in to compatible forward
movement and is *excluded* from a capability major it has not adopted. The map is
captured once, at creation, and only the owner widens it.

```jsonc
"required_core_version": ">=0.70.0",          // availability floor
"core_capabilities": {                         // the dependency map
  "chat-turn": "^1",
  "agent-run-request": "^1",
  "run-output-tool": "^1",
  "owner-scoped-tables": "^1",
  "chat-agent-registry": "^1",
  "event:agent.run.completed": "^1"
}
```

The dependency map, not the Core-version floor, is the precise contract: the floor
only says "new enough to have these"; the capability ranges say "and I depend on
*these* behaviours staying compatible."

### Breaking changes are Core's to communicate — targeted, not broadcast

The plugin does **not** defensively track Core; the burden of a breaking change
sits with Core, which is the only party that knows it is about to break something.
Core's obligations:

1. **No breaking change to a capability except on that capability's major bump**,
   preceded by a **deprecation window** in which both versions are served.
2. **Targeted notification.** The marketplace registry (ADR-0003) knows which
   plugins are installed, which capability versions each declared, and who owns
   them. A capability major bump notifies **exactly** the owners whose
   `core_capabilities` pin excludes the new version — not every plugin owner.
3. A plugin whose pins are all satisfied by the running Core is **guaranteed to
   keep working** across that upgrade; one that binds a now-majored capability is
   flagged incompatible (and its owner already notified) rather than silently
   breaking.

This is the two-way contract behind the earlier decisions: the plugin owns its
lifecycle and pins what it depends on; Core owns keeping those pins meaningful and
telling the affected owners when it cannot.

## Compliance

- The turn engine resolves the system prompt **only** from the registry by
  `agent_key`; no endpoint accepts prompt text in a chat-turn request (enforced by
  the request schema — there is no such field — and covered by a test that a
  registered prompt cannot be overridden).
- `/internal/agent-chat` requires **both** `require_service_principal` and a valid
  forwarded Cognito token; a request missing either is rejected (401/403), tested.
- The service principal must be a registered Biffo service (verified via SigV4,
  ADR-0009); the verified user must be in the agent's `required_group`, else 403.
  **Binding a service principal specifically to an `agent_key` is envisaged but not
  yet enforced** (tracked in #565) — the install flow (ADR-0003) that would
  establish and verify this binding does not exist yet, so today only the SigV4
  gate and required_group check are enforced.
- Closed-table access via the service seam **must** carry an `owner_sub` filter;
  Core rejects an unscoped call. `TID251` (ADR-0002) continues to bar any DB client
  outside `services/api/`.
- A user-facing plugin's manifest **must** declare a `core_capabilities` map naming
  every seam it binds, at a version range, alongside its `required_core_version`
  floor. Install validates the map against the running Core's capability versions;
  a pin that excludes a served version fails the install (the owner is directed to
  the migration for that capability's major).
- Core resolves each capability from a **single versioned registry**; a seam change
  that alters observable behaviour requires a capability major bump + a deprecation
  window, enforced in review (a CHANGELOG/registry check, not just convention).

## Decisions ratified

The load-bearing calls, ratified on acceptance:

1. **Orchestration placement → Option B** (plugin Lambda, not plugin-code-in-Core).
2. **Founder identity → Option B** (forward + re-verify the Cognito token).
3. **Closed-table access → service-auth owner-scoped**, rather than opening scoped
   tenant CRUD or building per-table bespoke endpoints.

## Build phasing

1. **Registry + generic turn engine** — extract the agent-agnostic engine from
   `agent_assistant.py`; add the chat-agent registry; rebuild the prompt assistant
   on it as `agent_key: "prompt-assistant"` (parity, no behaviour change).
2. **`POST /agent-chat/{agent_key}`** — Cognito, gated by the agent's
   `required_group`; migrate the admin route onto it.
3. **`POST /internal/agent-chat`** — dual-auth (service principal + forwarded JWT
   via #492); `run_as:user` grounded in the verified token.
4. **Inline output-tools** — runs may carry a function-tool schema; the runtime
   offers it alongside built-ins.
5. **Service-auth owner-scoped table access** — serve declared, CRUD-closed tables
   to the owning module's Lambda under a mandatory owner scope.
6. **Plugin `http_ingress` + frontend host** (ADR-0013) — the founder-gated Lambda
   ingress and the path-routed static frontend (ADR-0007 CDN). The Ideation
   `CoreGateway` adapter binds to seams 3–5; `/ideation` ships.

## Related Decisions

- **ADR-0016** — the buffered chat spine this generalises.
- **ADR-0013** — the plugin extension contract; this builds the `http_ingress`
  slice it left as design-only, for a founder-gated user surface.
- **ADR-0014 / ADR-0015** — the agentic worker framework and prompt library the
  prompt assistant (the first registered agent) serves.
- **ADR-0009** — internal service authentication (SigV4) used on the plugin→Core
  seam.
- **ADR-0003 / ADR-0006** — the marketplace registry (which drives targeted
  breaking-change notification) and core-upgrade/template-sync (whose ownership
  boundary keeps a Core upgrade from ever touching plugin code).
- **ADR-0002 / ADR-0004** — data stays in Core; the plugin's tables stay
  CRUD-closed and are served only across the owner-scoped service seam.
- **ADR-0007 / #492** — shared Cognito and the shared JWT verifier used to
  re-verify the forwarded founder token.
