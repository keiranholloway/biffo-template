# ADR-0021: Plugins are pure code on shared hosting — one plugin runtime, one app shell

## Status

Accepted (partially implemented). The **backend** design here is built and live:
one shared plugin-host Lambda (`services/_plugin-host/`) behind the Core API
Gateway at `/api/v1/plugins/*`, same-origin via CloudFront, with per-plugin
identity asserted by a signed `X-Biffo-Plugin` header (§1a). Verified serving the
Ideation Engine end-to-end on biffo-platform dev. The **shared frontend app-shell**
(§2) is **not yet built** — user-facing plugin *frontends* are still hosted the
ADR-0018 way (a per-plugin static bucket + `<name>/*` CloudFront behaviour) until
it lands; that work, and the full retirement of ADR-0018, is tracked in
[#558](https://github.com/keiranholloway/biffo-template/issues/558).

**Supersedes ADR-0018** (user-facing plugin hosting as an authenticated sibling)
for the backend today, completing the supersession once §2 lands. Narrows ADR-0007
(siblings) to genuinely standalone applications.

## Context

The premise of Biffo is that `biffo init` provisions the shared infrastructure
**once** (Core API, Cognito, EventBridge, CloudFront, RDS) and a plugin is *pure
code on top of it* — a declaration plus a little logic. For a plugin that only
declares tables (Core owns and serves them, ADR-0004), reacts to events, and
exposes generic CRUD, the platform still provisions a real Lambda, EventBridge
rule/target, and (when needed) an IAM policy per `modules/plugins/_template/main.tf:56-167`
— every first-party plugin today (orchestrator, agent-runtime) provisions all three.
What broke the old pattern (and what this ADR fixes) is a plugin needing a custom
authenticated API and a frontend, not the event/data shape.

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
and non-negotiable"** (a constraint also grounded in ADR-0002 directly). A compromised or buggy plugin must never reach the DB or
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

### 1a. Data authorization under a shared runtime

Owner-scoped table access authorizes on two things: **which caller** may touch a
table (`allowed_principals`, e.g. `system:ideation`, on the table's
`owner_scoped_service` axis) and **whose rows** (the owner, derived from the
forwarded founder token). With per-plugin Lambdas the *caller* was identified by
its own IAM role (ADR-0009). A shared plugin host removes that signal — every
plugin calls Core under the host's single role.

So the IAM role changes meaning, and Core gains a second check:

- **The IAM role authorizes "is this the plugin host at all"** — still the
  ADR-0009 `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST`, now one entry (the host's
  role) instead of one per plugin. This keeps *non-platform* callers out.
- **Which plugin is asserted by the host** as a trusted plugin-identity header on
  each internal call. The host is platform code — it already enforces
  group-gating and dispatches to the plugin's router, so it is the correct
  authority to name the plugin it is running. Core enforces the table's
  `allowed_principals` against that asserted identity (and the owner against the
  forwarded founder token), exactly as before. This keeps *one plugin* out of
  *another plugin's* tables.

The trust root moves from "each plugin proves itself by its own IAM role" to "the
platform host proves it is the host (IAM), and truthfully names the plugin it is
running" — consistent with the host being the enforcement point for authorization
generally (ADR-0011). An `isolated: true` plugin (its own host) keeps a distinct
role and needs no asserted identity, so the strong-isolation path is unchanged.

### 2. Frontend — ONE shared app shell, plugins mount UI routes

There is **one** founder-facing application shell (one origin, one S3 bucket, one
CloudFront behaviour, one Cognito App Client). A plugin declares `ui_mount` and
ships **UI routes/components** that the shell mounts at `<base>/<plugin>/*`. There
is no per-plugin bucket, no per-plugin CloudFront behaviour, and no
`sibling_origins`/`plugin_api_origins` registration for a plugin.

With a single SPA on a single origin, client-side routing owns every plugin path.
This removes the conflict that broke ADR-0018's plugin APIs — but **only if the
SPA deep-link fallback stops using distribution-wide CloudFront custom-error
responses.** Today the distribution maps `403/404 → /index.html (200)`; that is
distribution-wide, so it rewrites a plugin API's JSON `403/404` into HTML (this is
the live `Unexpected token '<'` bug). **Part of this seam is therefore replacing
those custom-error responses with per-behaviour SPA routing** — a CloudFront
Function (or S3 error document) scoped to the app-shell behaviour only, so the API
behaviour's error responses are never rewritten. It does not disappear for free;
it must be built.

The shared-session SSO mechanic from ADR-0007 §3 (same Cognito App Client →
shared session on same origin, zero extra code) carries over unchanged, and is
simpler here: one client, one origin, no per-sibling path client to reason about.

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

**Shared-runtime bundle.** The plugin host packages every installed plugin's
router and its dependencies, so its bundle and cold-start grow with plugin count.
For the target scale (tens of first-party wrappers) this is a non-issue; if it
ever bites, `isolated: true` peels a heavy plugin off into its own host, and the
host can move to a container image. Worth measuring, not worth pre-optimising.

**Marginal cost of a plugin** drops from "a production infrastructure project +
~30-min-per-mistake feedback loop" to "write a router (the prompts/logic that are
the actual product) + a few UI routes + declare your tables." One deploy, no new
AWS resources — an afternoon, flat at plugin #30.

**Congruence:**

| ADR | How this honours it |
| --- | --- |
| 0002 (no DB outside Core) | The plugin host has no DB access; it calls Core over HTTP. |
| 0007 (siblings) | SSO mechanic reused; siblings narrowed to standalone apps, not plugin UIs. |
| 0009 (SigV4 inbound) | The plugin host is a SigV4 caller of Core `/internal/*`, allow-listed by its role; per-plugin table access adds a host-asserted plugin identity (§1a). |
| 0011 (authz is core) | Group-gating moves out of plugin code into platform enforcement from the manifest. |
| 0013 (declare/review/enforce; no plugin code in Core) | Router/UI/group are declared and reviewed; enforcement is core; plugin code runs in the *plugin host*, never in Core. |
| 0018 (superseded) | Replaces per-plugin authenticated-sibling hosting with shared hosting. |

**What survives from the Ideation build:** all of the product — prompts, agent
definitions, chat orchestration, service layer, adapter, data model, SDK, and the
shared chat spine (ADR-0016/0017). Only the per-plugin infrastructure wrapper is
removed. Migrating Ideation onto this ADR (mount its existing router + UI, tear
down its Lambda/gateway/bucket) is the proof, and incidentally fixes its current
production bugs.

## Open decisions (resolve before the frontend seam)

1. **Where the app shell lives.** It cannot be the admin portal — the portal is
   strictly the `/admin` console (core-manifest / #306), and the instance's
   product UI belongs elsewhere. Recommendation: a **new template-owned founder
   app shell** — a single SPA served on the shared distribution at the founder
   paths, gated to the founder group, distinct from both `/admin` (portal) and
   `/` (the user's product sibling). This keeps the portal-is-admin boundary
   intact. Needs a nod before building the frontend.
2. **How plugin UI is delivered into the shell.** Build-time inclusion (the
   shell's build vendors installed plugins' UI, one deploy) is simplest and
   matches how the backend vendors routers; runtime module-federation is the
   heavier alternative. Recommend build-time first.

The **backend seam (§1/§1a) has no such open questions** and is where the
migration starts.

## Packaging — how the host Lambda gets plugin code

The shared plugin host is one Lambda whose deployment artifact bundles the host
runtime, every installed user-facing plugin's package, and the union of their
dependencies. Three facts make this a small step rather than a new system:

- **Dependency resolution is already solved.** Installed plugins are uv workspace
  members (`services/<name>/`), so the instance's single `uv.lock` resolves all of
  their dependencies together into one coherent set. Two plugins with incompatible
  dependencies fail at *install* time — loudly and locally, the right place — and
  `isolated: true` is the escape hatch for a plugin that genuinely needs its own
  set.
- **The build mechanism already exists.** The host deploys exactly like the Core
  API does today: a placeholder Lambda in Terraform (`ignore_changes = [filename]`)
  whose real code is pushed by the "Deploy Application" step. That step is
  *extended* to build the host artifact (host + plugin packages + resolved deps),
  not a new pipeline.
- **Discovery is deterministic.** The build generates one `installed-plugins.json`
  (`name → app_ref, required_group`) by scanning `services/*/biffo.plugin.json` for
  a `user_ingress`, and bundles it into the artifact. The host reads that registry
  — no runtime filesystem scan, no ambiguity about what is installed. (`discover.py`
  already models exactly this data.)

Installing or removing a user-facing plugin changes the host bundle; the next
Deploy Application rebuilds and updates the *one* host Lambda. No per-plugin
infrastructure, no two-apply, no wire step.

**Chosen: a single zip, reusing the Core-API deploy mechanism.** Rejected — a
container image (heavier CI/ECR, slower cold start; kept as the fallback if the
250 MB zip limit is ever reached) and Lambda layers (same dependency-merge problem,
tighter size limit, more moving parts). The zip is correct for the target scale
(tens of first-party wrappers); the container fallback and `isolated: true` cover
the tail.

## Migration

1. Build the shared plugin host + the `/api/v1/plugins/*` route and manifest
   `api_ingress` enforcement.
2. Build the shared app shell + `ui_mount` mounting.
3. Thin the plugin contract and `biffo plugin install` (drop terraform, two-apply,
   wire).
4. Migrate Ideation as the first consumer; delete its per-plugin infra.
5. Remove the superseded machinery (ADR-0018 hosting, OAC, `plugin_api_origins`,
   `plugin wire`).
