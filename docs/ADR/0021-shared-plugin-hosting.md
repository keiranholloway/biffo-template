# ADR-0021: Plugins are pure code on shared hosting — one plugin runtime, one app shell

## Status

Proposed. **Supersedes ADR-0018** (user-facing plugin hosting as an authenticated
sibling) and narrows ADR-0007 (siblings) to genuinely standalone applications.

## Context

The premise of Biffo is that `biffo init` provisions the shared infrastructure
**once** (Core API, Cognito, EventBridge, CloudFront, RDS) and a plugin is *pure
code on top of it* — a declaration plus a little logic. For a plugin that only
declares tables (Core owns and serves them, ADR-0004), reacts to events, and
exposes generic CRUD, this holds: it provisions nothing.

It broke the moment a plugin needed a **custom authenticated API and a
frontend** — i.e. an actual product (the Ideation Engine). The platform had no
shared-hosting answer for that shape, so ADR-0018 filled the gap the wrong way:
it gave each user-facing plugin **its own infrastructure** — a dedicated Lambda,
API Gateway/Function URL, S3 bucket, CloudFront behaviours, Terraform module, a
two-apply install with a re-wire step, and CDN registration.

That is the anti-pattern the platform exists to eliminate. Its costs, measured
building and deploying one trivial AI wrapper:

- **No economies of scale.** Plugin #30 costs almost as much as plugin #1 — each
  is a full AWS infrastructure project.
- **A ~30-minute deploy tax per change**, because per-plugin infra is only
  verifiable in production (CloudFront routing, OAC, IAM, Terraform ordering).
- **A swamp of AWS-primitive gotchas** re-hit by every plugin: OAC can't serve
  browser POSTs, distribution-wide custom-error-responses clobber a plugin API's
  JSON errors, Terraform can't order an OAC/behaviour delete, etc.

The mistake was conflating **isolated boundaries** (a data/security concern) with
**isolated infrastructure** (a deployment concern), and defaulting to the
microservices instinct of "one deployable per component" without ever pricing the
marginal cost of a new plugin.

### The binding constraints (why the obvious fix is wrong)

The tempting fix — mount plugin routers *inside the Core API process* — is
forbidden: **ADR-0013 §3, "No plugin code runs in the Core API process… unamended
and non-negotiable."** A compromised or buggy plugin must never reach the DB or
crash Core. Any design must also honour ADR-0002 (no DB client outside Core),
ADR-0009 (inbound internal calls are SigV4/IAM), and ADR-0011 (authorization —
including group-gating — is a core concern, never plugin code).

## Decision

**A user-facing plugin provisions no infrastructure. It contributes two things —
an API router and UI routes — that mount onto shared hosting the platform owns.**

### 1. Backend — ONE shared plugin runtime, separate from Core

All plugins run in a **single shared plugin-runtime Lambda** (the "plugin host"),
**not** the Core API process and **not** one Lambda per plugin. The host:

- Is fronted by the **existing** shared API Gateway. One route family,
  `ANY /api/v1/plugins/{plugin}/{proxy+}` → plugin host. No per-plugin gateway,
  Function URL, OAC, or CloudFront behaviour.
- **Has no database access** (ADR-0002) — it reads/writes core-owned data only by
  calling Core's `/api/v1/internal/*` over HTTP, signed SigV4 (ADR-0009), exactly
  as plugins do today. This is why it is a separate runtime from Core, not part of
  it (ADR-0013 §3 preserved).
- **Discovers and mounts** each installed plugin's router by path at startup, the
  same discovery already used for `biffo.plugin.json` tables/routes — generalised
  from "CRUD I generate for you" to "a router you hand me."

**Group-gating is enforced by the platform, not the plugin (ADR-0011, ADR-0013).**
The manifest declares `api_ingress.required_group`; the API Gateway's Cognito JWT
authorizer authenticates, and the plugin host enforces the declared group before
dispatching to the plugin's router. A plugin ships **no auth code** — it receives
an already-authorized founder identity, and forwards the token to Core for
owner-scoped writes.

**Isolation trade + escape hatch.** One shared runtime removes isolation *between*
plugins (a bad plugin can affect others in the host) while fully preserving the
boundary that matters — none of them can reach Core's DB. For first-party and
reviewed plugins this is the right default. A plugin that genuinely needs its own
runtime declares `isolated: true` and gets a dedicated plugin-host Lambda (same
contract, more cost) — congruent with ADR-0013's declare→review→enforce model.

### 2. Frontend — ONE shared app shell, plugins mount UI routes

There is **one** founder-facing application shell (one origin, one S3 bucket, one
CloudFront behaviour, one Cognito App Client). A plugin declares `ui_mount` and
ships **UI routes/components** that the shell mounts at `<base>/<plugin>/*`. There
is no per-plugin bucket, no per-plugin CloudFront behaviour, and no
`sibling_origins`/`plugin_api_origins` registration for a plugin.

Because there is a single SPA on a single origin, client-side routing owns every
plugin path and API errors flow through the shared API path as JSON — **the
distribution-wide `403/404 → index.html` custom-error-response conflict that broke
ADR-0018's plugin APIs simply cannot occur.** The shared-session SSO mechanic from
ADR-0007 §3 (same Cognito App Client → shared session on same origin, zero extra
code) carries over unchanged and is in fact simpler here: one client, one origin,
no per-sibling path client to reason about.

### 3. The plugin contract becomes thin

A user-facing plugin is: `biffo.plugin.json` (tables, events, `api_ingress`
{`mount`, `required_group`}, `ui_mount`) + an API router module + a UI-routes
module. **It ships no `terraform/` directory.** `biffo plugin install` copies the
code and registers it in the manifest; there is no per-environment module wiring,
no two-apply flow, and no `plugin wire` step. `biffo plugin install`/`upgrade`
remain a reviewable PR (ADR-0013 §2).

## Consequences

**Deleted:** the per-plugin Terraform module template; per-plugin Lambda / API
Gateway / Function URL / OAC; the CDN `plugin_api_origins` routing and the
`plugin wire` command; the two-apply install; per-plugin frontend buckets and
`sibling_origins` entries for plugin UIs. ADR-0007 siblings remain **only** for
genuinely standalone applications in separate repos, not for plugin UIs.

**Marginal cost of a plugin** drops from "a production infrastructure project +
~30-min-per-mistake feedback loop" to "write a router (the prompts/logic that are
the actual product) + a few UI routes + declare your tables." One deploy, no new
AWS resources — an afternoon, flat at plugin #30.

**Congruence:**

| ADR | How this honours it |
| --- | --- |
| 0002 (no DB outside Core) | The plugin host has no DB access; it calls Core over HTTP. |
| 0007 (siblings) | SSO mechanic reused; siblings narrowed to standalone apps, not plugin UIs. |
| 0009 (SigV4 inbound) | The plugin host is a SigV4 caller of Core `/internal/*`; still allow-listed per role. |
| 0011 (authz is core) | Group-gating moves out of plugin code into platform enforcement from the manifest. |
| 0013 (declare/review/enforce; no plugin code in Core) | Router/UI/group are declared and reviewed; enforcement is core; plugin code runs in the *plugin host*, never in Core. |
| 0018 (superseded) | Replaces per-plugin authenticated-sibling hosting with shared hosting. |

**What survives from the Ideation build:** all of the product — prompts, agent
definitions, chat orchestration, service layer, adapter, data model, SDK, and the
shared chat spine (ADR-0016/0017). Only the per-plugin infrastructure wrapper is
removed. Migrating Ideation onto this ADR (mount its existing router + UI, tear
down its Lambda/gateway/bucket) is the proof, and incidentally fixes its current
production bugs.

## Migration

1. Build the shared plugin host + the `/api/v1/plugins/*` route and manifest
   `api_ingress` enforcement.
2. Build the shared app shell + `ui_mount` mounting.
3. Thin the plugin contract and `biffo plugin install` (drop terraform, two-apply,
   wire).
4. Migrate Ideation as the first consumer; delete its per-plugin infra.
5. Remove the superseded machinery (ADR-0018 hosting, OAC, `plugin_api_origins`,
   `plugin wire`).
