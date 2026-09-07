# ADR-0021: Plugins are pure code on shared hosting — one plugin runtime, one app shell

## Status

Accepted (partially implemented). Amended 2026-07-26 — see the trust-based
isolation decision at the end of this document (#579). Amended 2026-09-07 (§2
rewritten; [#558](https://github.com/keiranholloway/biffo-template/issues/558)
Milestone 1, issue #1914) — §2 below now specifies **option B**, decided
2026-08-16 and reconfirmed 2026-09-06: extend the shared plugin host's
already-live static-shell serving (built for `admin_ingress`) to
`user_frontend` too, rather than building the separate shared founder
app-shell SPA this section originally described (**option A**, kept below
under "Open decisions" as the deferred, not abandoned, alternative).

The **backend** design (§1/§1a) is built and live: one shared plugin-host
Lambda (`services/_plugin-host/`) behind the Core API Gateway at
`/api/v1/plugins/*`, same-origin via CloudFront, with per-plugin identity
asserted by a signed `X-Biffo-Plugin` header. Verified serving the Ideation
Engine end-to-end on biffo-platform dev.

The **frontend mount** (§2) is specified below but has no code behind it yet —
building it (manifest plumbing, the `mount.py` static mount, the two API
Gateway routes, and the deploy-packaging change) is Milestone 2 of #558.
Until M2 and the cross-repo migration land, user-facing plugin frontends are
still served the ADR-0018 way (a per-plugin static bucket + `<name>/*`
CloudFront behaviour) — see §2's migration order for the full sequence.

**Fully supersedes ADR-0018.** ADR-0018's backend model (§1, a per-plugin
authenticated Lambda) was already superseded by §1/§1a above; this amendment
settles ADR-0018's frontend half (§2) the same way, so ADR-0018 carries no
unsuperseded content — see its own Status line. Narrows ADR-0007 (siblings) to
genuinely standalone applications.

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
  each internal call. The host binds this identity once per request, in
  `group_gate` (`services/_plugin-host/src/plugin_host/mount.py`), before
  dispatching to the plugin's router, and the SDK's default `self.api` client
  (`SignedCoreClient`, `packages/python-sdk/src/biffo_plugin_sdk/signed_client.py`)
  reads it to stamp the outbound `X-Biffo-Plugin` header. Core enforces the
  table's `allowed_principals` against that asserted identity (and the owner
  against the forwarded founder token), exactly as before.

**What this guarantee actually covers, and what it does not (corrected by
[#563](https://github.com/keiranholloway/biffo-template/issues/563)).** For
*well-behaved* plugin code that uses the SDK's default client as intended,
`group_gate` correctly binds and asserts the right plugin's identity, and this
keeps one plugin's ordinary CRUD calls out of another plugin's tables. But it is
**not** a cryptographic or process-level isolation boundary against a plugin's
own code that deliberately chooses to assert a different identity. The identity
binding is an ordinary, mutable `ContextVar`: any code sharing the host process
— including the mounted plugin's own request handler — can read or overwrite it
before making its own outbound call. Worse, hardening that specific mechanism
(e.g. binding identity in a closure instead of a module-level `ContextVar`)
would not close the underlying gap either, because the *credentials* are the
real shared resource: any code running in the shared host Lambda has access to
the host's IAM role via the standard AWS SDK credential chain
(`botocore.session.get_session().get_credentials()`, exactly what
`SignedCoreClient` itself calls) and could hand-construct its own SigV4-signed
request naming any plugin identity, independent of whatever in-process
convenience wrapper the SDK offers.

So the trust root is honestly: "the platform host proves it is the host (IAM),
and — for plugin code that behaves — truthfully names the plugin it is
running." That protects against accidental cross-plugin data access by
ordinary, non-adversarial plugin code sharing the host. It does **not** protect
against a plugin an operator does not trust: genuine isolation against a
malicious or fully-untrusted plugin requires `isolated: true` — a dedicated
Lambda with its own IAM role, where the caller's identity is the role itself,
not a header the plugin's own process could rewrite. Consequently, **the shared
host is an appropriate default only for plugins the operator trusts to the same
degree as each other** — first-party plugins, or third-party plugins that have
been through real code review — not as a security boundary between
mutually-distrusting plugins.

This is a **deliberate, ratified decision**
([#579](https://github.com/keiranholloway/biffo-template/issues/579)), not a gap
awaiting a fix. Per-plugin STS-scoped credentials — the host assuming a
plugin-scoped role immediately before dispatch, so a plugin's code never sees
the host's full role — were considered and **explicitly not adopted**: they add
an `sts:AssumeRole` round-trip (and its rate limits) to every dispatch plus a
non-trivial session-policy design, a cost not justified when every plugin
reaching the shared host is install-reviewed (ADR-0013) and the host, by policy,
runs only plugins the operator trusts to the same degree. The escape hatch for a
user-facing plugin an operator will *not* fully trust is `isolated: true` — its
own Lambda with its own IAM role, where the role itself is the identity and no
`X-Biffo-Plugin` assertion is involved, so the strong-isolation path is
unaffected by any of the above. That path **remains unbuilt** — there is no
third-party user-facing plugin to need it (everything in the shared host today
is first-party and mutually trusted) — and is tracked in
[#595](https://github.com/keiranholloway/biffo-template/issues/595), to be built
when first needed. See the amendment at the end of this document.

### 2. Frontend — the shared host serves a plugin's `user_frontend` bundle; no per-plugin origin

**Decided 2026-08-16, reconfirmed 2026-09-06 (#558 Milestone 1, issue #1914):
option B.** Extend the mechanism the host already runs in production for
`admin_ingress` — serve a built static bundle from inside the host's own
mount, exempt exactly those paths from the token check, and add matching
unauthenticated API Gateway routes — to `user_frontend` too, rather than
building a separate shared founder app-shell SPA (**option A**, this
subsection's original design, kept below under "Open decisions" as deferred,
not abandoned: the manifest field is `user_frontend` either way, so if
founder-facing plugin count or asset traffic ever outgrows what this document
prices, A is a straightforward next step and none of the manifest contract or
the migration below is wasted).

**The URL.** `GET /api/v1/plugins/<name>/ui` and
`GET /api/v1/plugins/<name>/ui/{proxy+}` — two new unauthenticated API Gateway
routes on the **existing** shared `api/v1/plugins/*` behaviour (§1), mirroring
the pair that already exists for the admin shell
(`plugin_admin_shell_root`, `plugin_admin_shell_assets`,
`infra/environments/dev/plugin-host.core.tf:116,128`). No new CloudFront
behaviour, no new S3 origin, no `sibling_origins` entry — the whole point of
reusing §1's route family. (The `/ui` proxy route is deliberately broader than
the admin pair, whose second route is scoped to `/admin/assets/{proxy+}`
only: `/ui/{proxy+}` must catch **every** path under `/ui/`, not just
`/assets/*`, because an unknown path there is a client-side SPA route that
needs the `index.html` fallback below, not a 404 — see SPA deep links.)

This **retires** the old per-plugin URL, `<name>/*` (a dedicated S3 origin +
`ordered_cache_behavior` per ADR-0018 §2), **with no redirect kept**. A
redirect needs somewhere to live, and the somewhere — a per-plugin CloudFront
behaviour — is exactly the infrastructure this migration deletes (M4);
keeping one alive defeats the consolidation it exists to complete. A
founder's stale bookmark to the old URL 404s once, which is the accepted,
one-time cost against never provisioning per-plugin CDN infrastructure again.

**Who serves it.** The host, not the plugin. `services/_plugin-host` mounts
`StaticFiles(directory=BIFFO_PLUGINS_ROOT/<name>/<user_frontend.dir>,
html=True)` at `/<name>/ui` for every installed plugin whose manifest
declares `user_frontend`, driven by `discover.py`'s `DiscoveredPlugin`
(plumbing, not new validation — `PluginManifest` already parses the field).
This is a deliberate divergence from `admin_ingress`, which makes **each
plugin** mount its own `StaticFiles` inside its own app module
(`biffo-plugin-ideation/src/ideation/admin_app.py:217-242`:
`_resolve_static_dir` + `app.mount("/", StaticFiles(...), name="admin-ui")`).
That shape is per-plugin code doing a platform job: every admin-surfaced
plugin re-derives the same `BIFFO_PLUGINS_ROOT`-relative path, the same
Vite build-output convention (`index.html` + hashed `assets/*`), and the same
bare-path/trailing-slash trap `_normalize_bare_admin_paths`'s docstring exists
to document — logic that has already needed one fix
(`_is_public_admin_asset`, `mount.py:110-111`) and would otherwise be
copy-pasted into a second and third plugin's own source rather than fixed
once. `user_frontend` does this in the host instead, for the same reason the
platform generates CRUD instead of asking each plugin to write it.

**Converging `admin_ingress` onto this host-served shape is a deferred
follow-up, not forgotten.** It would touch `biffo-plugin-ideation` and
`biffo-plugin-idea-scout` as well as the template, which is out of scope for
a template-only epic (#558); recorded here so the next reader of
`admin_app.py`'s static-mount code knows a shared replacement exists rather
than assuming the duplication is permanent.

Two comments already in the tree pre-date this decision and describe **option
A's** premise instead: `mount.py:104-106`'s docstring and the comment above
the admin routes in `plugin-host.core.tf` both say a founder-facing
`user_frontend` "gets its own unauthenticated CloudFront distribution"
(ADR-0018's model). That assumption is exactly what this document supersedes;
both comments are stale as of this decision and will need correcting when M2
builds the code they describe.

**What `required_group` does and does not gate.** ADR-0018 §2 said it "gates
the UI client-side (a non-founder is bounced)." **Nothing has ever
implemented that gate, and option B cannot implement it either.** Both new
`/ui` routes are `authorization_type = "NONE"`, by construction — a plain
browser navigation (an address-bar URL, an `<a href>` click, a bookmark) has
no hook to attach a bearer token to, which is exactly why the admin shell's
own two Gateway routes are `NONE` today. This was independently confirmed in
production at `docs/guides/development-practices.md:239`: measured directly
against the API Gateway origin (never through CloudFront alone — a
distribution-wide rule rewrites API `403`/`404` into portal HTML, #647),
`/ideation/`'s admin shell is a **428-byte** empty `<div id="root">` served to
any caller with no `Authorization` header at all, while every real API route
behind it still `401`s with no token. So the field has described a
client-side gate that was never built, on a mechanism structurally incapable
of building it. `user_frontend.required_group` is **retained** in the
manifest schema (`cli/src/lib/plugin-manifest.ts:251`,
`packages/python-sdk/.../plugin.py:497`) for a possible future gated shell —
gating the shell itself needs a redirect-to-Cognito at the edge, a separate
decision, not this one — but it gates nothing today, and this document, not
ADR-0018, is the corrected record of that.

**SPA deep links.** An unknown path under `/ui/` — a client-side route the
SPA itself resolves, e.g. `/api/v1/plugins/ideation/ui/session/42` — falls
back to the mounted `index.html` (`StaticFiles(html=True)`'s built-in
behaviour, once `_normalize_bare_admin_paths` is extended to also cover the
bare `/<name>/ui` path — its existing docstring, written against the admin
mount, is the specification for this one too: a `Mount` compiles to a
trailing-slash-requiring regex, and a bare request without that extension
silently falls through to the **founder** JWT-gated mount and fails there
instead). The plugin's real JSON API stays at `/<name>/*` on the existing
`ANY /api/v1/plugins/{proxy+}` route and is **never shadowed**: the two `/ui`
routes have more literal path segments
(`/api/v1/plugins/{name}/ui/{proxy+}`) than the blanket catch-all
(`/api/v1/plugins/{proxy+}`), so API Gateway v2's precedence rule (more
specific route wins) resolves them first for exactly the `/ui/**` prefix and
leaves every other path — `/<name>/sessions`, `/<name>/admin`, everything
else — on the JWT route untouched. A 404 from the JSON API is never rewritten
into the SPA's `index.html`, and an unknown SPA route never falls through to
the JWT gate: verify this against the API Gateway origin directly, not only
through the CDN (the #647 trap applies here exactly as it does to
`admin_ingress`).

**Three measured limits.**

1. **API Gateway's 6 MB Lambda-proxy response limit.** Built
   `biffo-plugin-ideation/web` (`pnpm run build`, Vite 6, measured 2026-09-07):
   the largest single asset is its JS bundle at **299,616 bytes** (~293 KiB,
   `assets/index-DHP4dBJi.js`); total `dist/` is **305,287 bytes** (~298 KiB,
   3 files — `index.html` 428 B, that JS bundle, and a 5,243 B CSS file).
   `biffo-plugin-idea-scout/web` (same toolchain) measures within 1% of this:
   largest asset 299,427 bytes, `dist/` total 307,858 bytes. Both are **~2% of
   the 6 MB ceiling** — option B works unchanged at today's asset weight, with
   roughly 19x headroom before a single asset would even approach the limit.
   (Both plugins' bundles are near-identical in size because both were
   scaffolded from the same skeleton and neither yet ships meaningfully
   different UI code — a data point about the skeleton's baseline weight, not
   evidence the limit has been genuinely exercised.)

2. **Host zip budget.** Measured by replicating `deploy-app.yml`'s "Package
   and deploy the shared plugin host" step exactly (same `uv export` /
   `uv pip install --target` layout, the same boto3/botocore/s3transfer +
   `__pycache__` + `tests` trim, the same `zip -rq`) against the host
   runtime, the SDK, and both currently-installed plugins' backend code and
   built `web-admin/` bundles — i.e. today's actual production shape, minus
   `user_frontend`, which is not in the zip yet because nothing builds it.
   That package zips to **10,429,231 bytes (~9.94 MB)**, unpacked
   **32,514,439 bytes (~31.0 MB)**. Adding both plugins' `web/dist` (the
   `user_frontend` bundles measured in limit 1) brings the zip to
   **10,621,391 bytes (~10.13 MB)** — a delta of **+192,160 bytes (~188 KiB)
   zipped**, **+613,145 bytes (~599 KiB) unpacked** (assets compress well
   inside the zip, so the zipped delta is smaller than the raw `dist/`
   weight). Both figures sit far under every ceiling in play: the ~54 MB
   comfort zone the Core API step guards against overrunning the ~70 MB
   inline `update-function-code` request cap, and the 250 MB unzipped
   S3-upload ceiling. (Unlike the Core API step, the plugin-host step prints
   no size and runs no guard at all today — worth flagging for M2 alongside
   the packaging change; not itself a blocker to this decision.)

3. **Per-request cost, API Gateway + Lambda vs. CloudFront.** Stated
   assumption: **1,000 founder sessions/month**, each an uncached full
   SPA-shell load (`index.html` + JS + CSS — the worst case; a warm browser
   cache serves most repeat visits for free under either mechanism) = 3,000
   asset requests, ~94.9 MB/month of gzip-compressed bytes (measured Vite
   gzip sizes for ideation: 0.29 kB + 1.65 kB + 92.99 kB ≈ 94.93 kB per shell
   load). Pricing: API Gateway HTTP API $1.00/million requests, Lambda
   $0.20/million requests + $0.0000166667/GB-s (AWS list pricing, US East,
   confirmed against aws.amazon.com 2026-09-07); CloudFront $0.085/GB +
   $0.0075/10,000 HTTPS requests (US/Europe tier, standard published list
   price — not independently re-confirmed live this session, treat as
   illustrative). Assuming 512 MB Lambda memory and ~20 ms per static-asset
   invocation (`StaticFiles` reads local disk and streams — no Core
   round-trip):

   | | API Gateway + Lambda (option B, live) | CloudFront (hypothetical dedicated origin) |
   |---|---|---|
   | Requests | 3,000 × $0.000001 + 3,000 × $0.0000002 ≈ **$0.0036** | 3,000 × $0.00000075 ≈ **$0.0023** |
   | Compute / transfer | 3,000 × 0.01 GB-s × $0.0000166667 ≈ **$0.0005** | 0.095 GB × $0.085 ≈ **$0.0081** |
   | **Total/month** | **≈ $0.0041** | **≈ $0.0104** |

   The difference is about six-tenths of a cent a month at this volume —
   noise, not a deciding factor. **The one real, permanent cost property of
   option B**: the shared `api/v1/plugins/*` CloudFront behaviour carries
   `Managed-CachingDisabled` deliberately
   (`modules/cloud/aws/cdn/main.tf:367`, "an API response must never be
   cached"), so unlike a dedicated static origin, **every** asset request —
   including a repeat visit whose browser cache missed, e.g. after a redeploy
   changes the hashed filename — invokes the Lambda; no CDN-layer cache
   absorbs repeat load. This is not a new trade-off introduced here —
   `admin_ingress` already carries it today — and at founder-session volume
   it is invisible in the numbers above; it would matter only at a traffic
   scale this document has no evidence Biffo is anywhere near.

**The migration order**, across the four repos this epic touches (see
Cross-repo boundary in the implementation plan,
`docs/implementation/0006-shared-plugin-frontend-mount/README.md`):

1. **biffo-template, M1 (this document).** The decision, written down — the
   contract M2, M3, and every step below build against.
2. **biffo-template, M2 and M3 (parallel).** M2 makes the host actually serve
   `user_frontend`; M3 makes the old per-plugin shape un-installable for any
   *new* plugin. Both merge before step 3 starts.
3. **`biffo-plugin-ideation`, then `biffo-plugin-idea-scout`.** Each repoints
   its `web/vite.config.ts`'s path-prefixed `base` at the new mount path,
   deletes `deploy-frontend.yml`, and deletes `terraform/`'s frontend bucket
   + `cdn_distribution_arn` variable. Ideation before idea-scout only because
   ideation is the more actively developed of the two; nothing else orders
   them relative to each other, and **both** must finish before step 4.
4. **`biffo-platform`.** Once *both* plugins have migrated, remove their
   `siblings.auto.tfvars.json` entries and `plugins.generated.tf` modules,
   and destroy the two now-empty S3 buckets.
5. **biffo-template, M4.** Delete the ADR-0018 deploy path from
   `deploy-app.yml` and the `cdn_distribution_arn` wiring from
   `plugin-terraform-wiring.ts`. Only safe after step 4: M4 deletes the
   deploy path currently keeping `dev.biffo.io/ideation/` and
   `dev.biffo.io/idea-scout/` alive on the old model, so landing it earlier
   takes production down.

Steps 1–3 are purely additive; the old path keeps serving throughout, so
nothing user-visible breaks before step 4.

The shared-session SSO mechanic from ADR-0007 §3 (same Cognito App Client →
shared session on same origin, zero extra code) carries over unchanged: one
client, one origin, no per-plugin path client to reason about, and no
distribution-wide custom-error-response conflict to solve either — that
conflict (option A's `Unexpected token '<'` bug, described in the superseded
version of this section) was a property of routing a plugin's JSON API and a
*shared SPA shell's* deep-link fallback through the *same* CloudFront
behaviour. Option B never puts them in the same behaviour in the first place:
`/ui/**`'s fallback is API-Gateway-route precedence (see SPA deep links
above), not a CloudFront custom-error response, so there is no distribution-wide
rule to scope down and nothing here to build to avoid it.

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
| 0018 (superseded) | Replaces per-plugin authenticated-sibling hosting with shared hosting, backend (§1) and frontend (§2) alike. |

**What survives from the Ideation build:** all of the product — prompts, agent
definitions, chat orchestration, service layer, adapter, data model, SDK, and the
shared chat spine (ADR-0016/0017). Only the per-plugin infrastructure wrapper is
removed. Migrating Ideation onto this ADR (mount its existing router + UI, tear
down its Lambda/gateway/bucket) is the proof, and incidentally fixes its current
production bugs.

## Open decisions — resolved 2026-08-16/2026-09-06 by option B (§2)

These were the two questions this section originally posed as blocking the
frontend seam, kept verbatim below as the record of what option A (not
chosen) would have needed answered. §2 above settles both by *not* building a
single shared shell at all:

1. **Where the app shell lives.** It cannot be the admin portal — the portal is
   strictly the `/admin` console (core-manifest / #306), and the instance's
   product UI belongs elsewhere. ~~Recommendation: a **new template-owned
   founder app shell** — a single SPA served on the shared distribution at
   the founder paths, gated to the founder group, distinct from both
   `/admin` (portal) and `/` (the user's product sibling).~~ **Not built.**
   Option B has no single shell to place: each plugin's `user_frontend`
   bundle is served independently, at its own `/api/v1/plugins/<name>/ui/*`
   path, by the plugin host — there is no shared SPA for a "where" question
   to be about. The portal-is-admin boundary stays intact regardless, because
   nothing here touches `/admin`.
2. **How plugin UI is delivered into the shell.** ~~Build-time inclusion (the
   shell's build vendors installed plugins' UI, one deploy) is simplest and
   matches how the backend vendors routers; runtime module-federation is the
   heavier alternative.~~ **Moot under option B**, for the same reason: there
   is no shell to vendor UI *into*. Each plugin ships its own already-built
   `dist/`, and the host serves it as static files, unmodified, from wherever
   the deploy step copied it — closer to the backend's own "vendor the
   package, don't compile it in" shape than either alternative above
   considered.

The **backend seam (§1/§1a) had no such open questions** and is where the
migration started; §2 above now has none either.

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

This is the ADR-level plan as originally written, before #558 broke the
frontend half into milestones. Step 2 described option A (not chosen); see
§2's own "migration order" for the actual, current sequence across the four
repos this now touches.

1. Build the shared plugin host + the `/api/v1/plugins/*` route and manifest
   `api_ingress` enforcement. **Done**, live on biffo-platform dev.
2. ~~Build the shared app shell + `ui_mount` mounting.~~ Superseded by §2:
   the host serves each plugin's `user_frontend` bundle directly: no shared
   app shell, no `ui_mount` field (the manifest field is `user_frontend`).
3. Thin the plugin contract and `biffo plugin install` (drop terraform,
   two-apply, wire). **Done** for the backend; §2's Milestone 3 does the
   equivalent for the frontend (refuse the ADR-0018 per-plugin shape at
   install time).
4. Migrate Ideation (then Idea Scout) as the first consumers; delete their
   per-plugin infra. **Not yet done** — §2's migration order, step 3.
5. Remove the superseded machinery (ADR-0018 hosting, OAC,
   `plugin_api_origins`, `plugin wire`). **Done** for the backend; §2's
   Milestone 4 does the frontend equivalent (the `deploy-app.yml` frontend
   step, `cdn_distribution_arn` wiring).

---

## Amendment 2026-07-26 — the shared-host isolation model is trust-based, by decision (#579)

**Status:** Accepted
**Issue:** [#579](https://github.com/keiranholloway/biffo-template/issues/579)
(ratified), follow-up [#595](https://github.com/keiranholloway/biffo-template/issues/595)

§1a asserts that the shared plugin host keeps one plugin out of another's tables.
[#563](https://github.com/keiranholloway/biffo-template/issues/563) established
that it does not, structurally: every plugin mounted in the shared host runs in
the same Lambda process and can reach the host's IAM-role credentials via the
standard AWS SDK credential chain, so it can hand-sign a Core request naming any
plugin identity — no amount of SDK-wrapper hardening closes that, because the
credentials, not the `ContextVar`, are the shared resource. §1a's wording was
corrected accordingly (#563); this amendment records the **decision** about what
to do about it.

**Decision (#579): ratify the trust-based model; do not build STS scoping.** The
shared host is a *trust* boundary, not a cryptographic or process one — by design
and permanently. It hosts only plugins the operator trusts to the same degree:
first-party plugins, or third-party plugins that passed install review
(ADR-0013). Three options were weighed:

1. **Per-plugin STS-scoped credentials** assumed just before dispatch — real
   isolation, but an `sts:AssumeRole` round-trip and session-policy design on
   every request, for a threat (a malicious co-mounted plugin) that install
   review already governs. **Rejected** as cost without a matching need.
2. **Lambda-per-plugin** (real per-plugin IAM roles, the pre-ADR-0021 model) —
   gives up the shared-runtime economy ADR-0021 exists to capture. **Rejected**
   as the default; retained only as the `isolated: true` escape hatch.
3. **Ratify shared-host-is-trusted-only, with `isolated: true` as the escape
   hatch for anything else.** **Chosen** — it is where the platform already
   effectively lands, and it costs nothing on the request path.

**Consequences.**
- The operating policy is explicit: **do not mount a plugin in the shared host
  you would not trust with every other co-mounted plugin's data.** For a
  user-facing plugin an operator will not fully trust, use `isolated: true`.
- `isolated: true` is the *only* real isolation mechanism for that case, and it
  **remains unbuilt** — it lives in ADR text and a couple of SDK docstrings, not
  in the manifest schema, discovery, or Terraform. That is acceptable today
  because there are zero third-party user-facing plugins; building it is tracked
  in #595, to be done when the first one needs it.
- The `#563` pinning test
  (`services/_plugin-host/tests/test_mount.py`) stays: it documents the accepted
  property, not a bug awaiting a fix.
