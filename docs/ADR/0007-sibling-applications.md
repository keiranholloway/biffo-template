# ADR-0007: Sibling Applications

**Status:** Accepted  
**Date:** 2026-07-03  
**Deciders:** Keiran Holloway (Technical Architect)

> Implemented across PR #120 (CDN `sibling_origins` path-based routing),
> #124 (`GitHubAdapter.createEmptyRepo` + parameterised branch-protection
> checks), #125 (`_skeletons/sibling-template/` — the Next.js + FastAPI
> skeleton), #128 (`biffo sibling create`), and this PR (portal `return_to`
> redirect support + this document).

---

## Context

`biffo-template` is becoming the identity/data "shell": Cognito auth, tenant
scoping, and — per ADR-0002 — the only thing allowed to touch Postgres
directly. The intent is for future product functionality to live in
separate, independently-deployed microservices ("sibling apps") rather than
growing inside the core monorepo, while still feeling like one product: same
login, same domain, path-routed (`baseurl.com/<name>`), true SOA (a sibling
calls the core's own API for all data, never the database directly).

Before this ADR there was no way to create such a sibling with the
governance (CI, branch protection, security scanning) the core project
itself has, no shared-identity mechanism across separate repos, and no
path-based routing precedent at all — even the core's own portal and API
live on different origins today, stitched together only by CORS.

This ADR is deliberately scoped to the **first** sibling template — an AWS
stack shaped like the core project's own (S3 + Lambda + API Gateway,
Terraform-managed) — and to the mechanics of creating and wiring one up. It
does not cover a sibling-to-sibling data path (siblings only ever talk to
the core, per the SOA principle below) or a second sibling template shape;
both are explicitly deferred (see Consequences).

---

## Decision

### 1. True SOA, enforced from the first commit

A sibling **never accesses a database directly** — the only way it reads or
writes core-owned data is by calling the core project's own API
(`services/api/core_client.py` in the skeleton). This mirrors ADR-0002 but
extends it across a repo boundary rather than just within the monorepo.
`_skeletons/sibling-template/services/api/` has no `asyncpg`/`sqlalchemy`/
`alembic` dependency at all — the absence of a database client is
structural, not a lint rule enforced after the fact.

### 2. Path-based routing on one shared CloudFront distribution

Every sibling gets one new S3 origin and one `ordered_cache_behavior`
(`path_pattern = "<name>/*"`) on the **core project's own** CloudFront
distribution (`modules/cloud/aws/cdn`'s `sibling_origins` variable, PR
#120), rather than provisioning its own distribution. Registering a new
sibling therefore always requires a Terraform change in the core repo —
accepted as the cost of one shared domain and one shared certificate,
instead of the operational overhead of a distribution per sibling.

The sibling's own Next.js static export sets `basePath` to its registered
path segment, so its own asset/link URLs already carry the `/<name>` prefix
— the parent distribution forwards the full request URI straight through to
the sibling's S3 origin with no prefix-stripping function of its own, so the
object keys in that bucket must already be laid out under that prefix (the
sibling's own `deploy.yml` syncs to `s3://<bucket>/<name>/`, not the bucket
root).

### 3. Shared-session SSO via the _same_ Cognito App Client

A sibling reuses the **exact same Cognito User Pool and App Client** as the
core portal — no new Cognito resources of its own. Combined with decision 2
(same origin, only the path differs), this has a load-bearing consequence,
verified directly against the installed library source
(`amazon-cognito-identity-js`'s `CognitoUser.js` / `StorageHelper.js`): the
SDK's own `window.localStorage` keys are of the form
`CognitoIdentityServiceProvider.<ClientId>.LastAuthUser` /
`...<username>.idToken` — keyed **only by Client ID**, not by path. A
sibling page on the same origin, instantiating `CognitoUserPool` with the
same `UserPoolId`/`ClientId`, transparently finds and validates the same
session with **zero new code, zero OAuth redirect flow, zero second app
client**. This is the existing library's default behaviour, not a mechanism
we built.

The one piece of new machinery this decision does require: when a sibling's
frontend finds no session, it redirects to the core portal's login with
`?return_to=/<name>/`, and the portal's login page must honour that param
(this PR) rather than always landing on `/dashboard`. `return_to` is
sanitised to a same-origin relative path only (`apps/portal/src/lib/
return-to.ts`) — accepting an absolute URL here would be an open redirect,
since the query string is attacker-controllable.

### 4. Defense in depth on the sibling's own backend

A sibling's own API Gateway gets its own Cognito JWT authorizer (fed the
**core's** pool/client IDs as plain input variables, not a pool it
provisions itself), and its own Lambda independently re-verifies the same
JWT (`services/api/src/api/middleware/auth.py` in the skeleton, ported
near-verbatim from the core's own `services/api/src/api/middleware/
auth.py`). Neither layer trusts the other to have run correctly — this
matches how the core API itself behaves, and is only correct _because_
decision 3 pins the sibling to the exact same Client ID; if per-sibling app
clients are ever introduced, both this verification path and the SSO
mechanism in decision 3 need re-deriving together.

### 5. Self-contained, vendored, not template-owned

`_skeletons/sibling-template/` lives inside `biffo-template`'s own tree (like
`_skeletons/plugin-template/`) but is not a workspace member (checked:
neither `pnpm-workspace.yaml` nor the root `pyproject.toml`'s
`[tool.uv.workspace]` list it) and is not itself deployed. `biffo sibling
create <name>` creates a plain empty GitHub repo
(`GitHubAdapter.createEmptyRepo`, PR #124 — no `is_template`/generate-from-
template machinery, since there's no second published template repo to
point at) and pushes the skeleton's content in as that repo's first commit.
Its three vendored Terraform modules (`compute`/`storage`/`api-gateway`) are
copied, not remote-sourced — the same self-containment call ADR-0003 already
made for plugins (rejecting a shared remote module source, which would
reintroduce cross-repo lifecycle coupling).

### 6. `biffo sibling create`: a 7-step idempotent sequence

Mirrors `biffo init`'s own `runInit`/session-resumability shape
(`cli/src/commands/sibling-create.ts`, PR #128), backed by a **separate**
`SiblingSession` store (`cli/src/lib/sibling-session.ts`) — a paused sibling
create and a paused `biffo init` for a project of the same name must not
collide on one shared session file. Unlike `biffo init`, there is no
companion "project config" store: a sibling never needs `biffo deploy`/
`biffo destroy` run against it afterward, since it deploys via its own
repo's own `.github/workflows/deploy.yml`, not via the `biffo` CLI.

1. `verify_credentials` — AWS credentials, same as `biffo init`.
2. `resolve_core_identity` — reads the core project's **real** Terraform
   outputs (Cognito pool/client, API URL, portal URL) from its state bucket,
   once per environment the sibling provisions — each environment has its
   own Cognito pool (`infra/environments/<env>/main.tf`), so there is no
   single "the" core identity, only one per environment.
3. `create_repo` — `GitHubAdapter.createEmptyRepo` + push the skeleton as
   the new repo's first commit.
4. `oidc_trust` / 5. `terraform_backend` — this sibling's own AWS bootstrap,
   identical in shape to `biffo init`'s.
5. `github_config` — branches, branch protection (reusing the skeleton's
   own 11-job status-check list — `configureBranchProtection`'s
   `statusChecks` parameter, PR #124), GitHub Environments, and
   per-environment `CORE_*` GitHub Environment variables from step 2.
6. `register_with_core` — clones the core project's repo, appends
   `{name, bucket_regional_domain}` (the sibling's own bucket's regional
   domain, computed deterministically from its account/region/environment —
   no Terraform apply has run yet at this point, so nothing about the
   sibling's real infrastructure exists to inspect) to each environment's
   `infra/environments/<env>/siblings.auto.tfvars.json`, and opens the
   registration PR itself via `GitHubAdapter.createPullRequest`.

### 7. Two-phase CDN registration, by necessity not oversight

The sibling's own S3 bucket policy needs the core project's CloudFront
distribution ARN to grant it OAC read access — but that ARN only exists
after the registration PR (step 7 above) merges and the core project
redeploys. The sibling's own Terraform (`infra/variables.tf`'s
`parent_cloudfront_distribution_arn`, defaulting to `""`) skips creating
that bucket policy until the variable is set, and the skeleton's own README
documents the second, later apply this requires. This ordering is a real
two-phase dependency, not a bug: `biffo sibling create` cannot make it
one-phase, because the ARN it needs is generated by a PR the human hasn't
merged yet.

---

## Options Considered

### Option A — One shared CloudFront distribution, path-routed _(chosen)_

Every sibling adds an origin + `ordered_cache_behavior` to the core
project's own distribution.

**Pros:**

- One domain, one certificate, one DNS zone for the whole product.
- Deep linking, shared cookies-are-not-needed session storage (decision 3)
  all fall out of "same origin" for free.

**Cons:**

- Registering a sibling always requires a Terraform change (and a merged PR)
  in the core repo — a sibling can never fully self-serve its own routing.
- All siblings share one distribution's blast radius (a bad WAF rule or
  cache-behavior change affects everyone).

### Option B — One CloudFront distribution per sibling, DNS-routed subdomains

Each sibling gets its own distribution at `<name>.baseurl.com`.

**Pros:**

- Fully independent blast radius and CDN configuration per sibling.
- No core-repo PR required to add a sibling.

**Cons:**

- Breaks the shared-origin SSO mechanism in decision 3 outright — a
  different origin means `amazon-cognito-identity-js`'s localStorage is no
  longer shared, and the whole "zero new code" argument evaporates. Rebuilding
  cross-origin SSO would mean OAuth/Cognito Hosted UI, a second app client,
  and a real redirect-and-callback flow — precisely the complexity Option A
  avoids.
- A certificate and DNS record per sibling.

### Option C — Per-sibling Cognito User Pool, cross-pool federation

Each sibling provisions its own pool; a federation/trust relationship (or a
shared "identity" pool) keeps sessions in sync.

**Pros:**

- Full sibling autonomy — no shared Client ID coupling (decision 4's caveat
  disappears).

**Cons:**

- Cognito has no native pool-to-pool session federation; this would mean
  building custom token-exchange infrastructure — a project of its own, not
  a "wire up a new microservice" feature.
- Directly contradicts the "feels like one product" goal this whole ADR
  exists to satisfy.

### Option D — Sibling calls the core's Cognito Hosted UI (OAuth redirect)

Keep separate origins (Option B) but use Cognito's own Hosted UI / OAuth
Authorization Code flow for cross-origin login.

**Pros:**

- A supported, standard mechanism for cross-origin SSO with Cognito.
- Would allow Option B's independent-distribution benefits.

**Cons:**

- Requires provisioning a Hosted UI domain, a second app client per sibling
  (or a shared one with multiple callback URLs to manage), and a real
  redirect-and-callback page in every sibling — substantially more
  moving parts than decision 3's "already works, do nothing" outcome.
- Was the recommended default going in; the user chose Option A specifically
  to get the "zero new code" SSO property instead.

---

## Rationale

Option A is the only one where the shared-session SSO in decision 3 is
"free" rather than "a project." Every other option (B, C, D) reintroduces a
real cross-origin or cross-pool identity problem that Cognito does not solve
natively, trading a one-time Terraform-PR cost (registering a sibling) for a
recurring engineering cost (building and maintaining federation/OAuth
plumbing) that would need to be paid once per sibling architecture decision,
not once ever. Given the target user is a solo founder wiring up a handful
of siblings, not an org running dozens of independently-teamed services, the
shared-distribution/shared-pool coupling is the right trade: fewer moving
parts today, at the cost of a small amount of coordination (a PR merge) each
time a new sibling is added.

---

## Consequences

### Positive

- A solo founder gets a governed, CI/CD-equipped, SSO-integrated sibling repo
  from one command, with the same branch protection and security scanning
  the core project has.
- The SOA boundary (decision 1) is structural in the skeleton, not a
  discipline that has to be maintained — there is nothing to remove to add a
  database client, because the dependency was never there.
- The registration PR (step 7) makes every sibling's CDN wiring reviewable,
  auditable git history in the core repo, rather than an out-of-band manual
  edit.

### Negative / Trade-offs

- Registering a sibling always needs a human to merge a PR against the core
  repo — this can never be a fully unattended, one-command operation end to
  end (deliberate, not an oversight — see decision 7).
- All siblings share the core project's CloudFront distribution's blast
  radius (Option B's rejected trade, accepted here).
- If per-sibling Cognito app clients are ever wanted later, decisions 3 and 4
  need to be re-derived together, not independently (noted in decision 4).

### Neutral

- Mirrors ADR-0003's plugin self-containment stance (vendor Terraform
  modules rather than reference them remotely) at the sibling-repo layer, so
  the two feel consistent.
- The `SiblingSession`/`SiblingConfigSchema` split from `biffo init`'s own
  session/config types (rather than extending `BiffoConfigSchema`) mirrors
  the "small, separate, no speculative fields" judgment call already made
  elsewhere in this codebase for config schemas.

---

## Compliance

- **No DB client outside `services/api/` in either repo:** the sibling
  skeleton's own `services/api/` has no database dependency at all, the same
  Ruff-plugin-enforced invariant CLAUDE.md states for the core project,
  extended by construction rather than by a new lint rule.
- **PRs, never pushes, for cross-repo changes:** `register_with_core`
  (decision 6, step 7) opens a pull request against the core project and
  never pushes to a protected branch — the same discipline ADR-0006 applies
  to core upgrades.
- **`return_to` is sanitised, never trusted as an absolute URL:**
  `apps/portal/src/lib/return-to.ts`'s `sanitizeReturnTo` rejects anything
  that isn't a same-origin relative path, closing the open-redirect risk a
  raw, attacker-controlled query param would otherwise create.
- **No live-instance side effects from creation alone:** `biffo sibling
create` performs AWS SDK calls (OIDC role, state bucket) and GitHub API
  calls (repo/branch/PR creation) — it never runs `terraform apply` itself.
  Actual infrastructure provisioning happens only when the sibling's own
  `deploy.yml` runs, and the core project's CDN change only takes effect
  when a human merges the registration PR and the core project redeploys.

---

## Related Decisions

- [ADR-0001](0001-single-tenant-architecture-with-multi-tenant-seam.md) /
  [ADR-0002](0002-api-only-data-integration-pattern.md) — a sibling never
  bypasses the Core API or tenant scoping; decision 1 extends ADR-0002's
  API-only principle across a repo boundary rather than relaxing it.
- [ADR-0003](0003-plugin-system-and-marketplace.md) — decision 5's vendored
  Terraform modules and self-contained-repo stance directly reuses the
  reasoning ADR-0003 already applied to plugin distribution (Option C
  there, rejecting a shared remote module source).
- [ADR-0006](0006-core-upgrade-and-template-sync.md) — `biffo sibling
create`'s session-resumability shape (decision 6) mirrors `biffo init`'s
  own, and the registration PR (decision 6, step 7) follows the same
  "propose a reviewable PR, never push to a protected branch" discipline
  ADR-0006 established for core upgrades.

## Deferred (explicitly, not silently dropped)

- **A second sibling template shape.** Only the AWS S3+Lambda+API-Gateway
  shape described here exists; `biffo sibling create` has no
  `--template <name>` selection mechanism yet because there is only one
  template to select.
- **`biffo core upgrade`-style sync for sibling templates themselves.** A
  sibling scaffolded today has no path to receive later improvements to
  `_skeletons/sibling-template/` the way a core instance can receive core
  upgrades (ADR-0006) — this is speculative until a second sibling template
  version actually exists to sync.
- **Live end-to-end SSO proof.** The "`<name> - Hello <username>`" page
  rendering after a real cross-navigation from a deployed core portal has
  not been verified against a live AWS account as part of this ADR's
  implementation — `dev.tabsii.com`/`tabsii-platform` is the only live
  instance today and must not be used for this without explicit separate
  confirmation (a standing constraint on this work, not specific to this
  ADR). Proving this live is a distinct follow-up requiring a disposable
  test instance or deliberate use of a live one.
