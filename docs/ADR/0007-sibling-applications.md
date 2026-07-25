# ADR-0007: Sibling Applications

**Status:** Accepted  
**Date:** 2026-07-03  
**Deciders:** Keiran Holloway (Technical Architect)

> Implemented across PR #120 (CDN `sibling_origins` path-based routing),
> #124 (`GitHubAdapter.createEmptyRepo` + parameterised branch-protection
> checks), #125 (`_skeletons/sibling-template/` — the Next.js + FastAPI
> skeleton), #128 (`biffo sibling create`), and this PR (portal `return_to`
> redirect support + this document). See
> [the sibling-apps guide](../guides/sibling-apps.md) for how to use it.

> **Amended 2026-07-20 (issue #306) — the root application sibling.** See
> [Amendment: the root application sibling](#amendment-2026-07-20--the-root-application-sibling)
> at the end of this document. In short: the mechanism below is unchanged,
> but the path prefix may now be **empty**. A sibling with an empty prefix
> serves `/`, takes the distribution's `default_cache_behavior` rather than a
> pair of `ordered_cache_behavior` patterns, registers under the reserved
> name `app`, and is created by `biffo init` rather than on demand. Where
> this document says a sibling is routed at `baseurl.com/<name>` with
> `basePath` set to that segment, read it as describing every sibling except
> that one.

> **Amended 2026-07-25 (issue #567) — sibling drift is observed, not
> speculative.** See
> [Amendment: sibling drift is observed, not speculative](#amendment-2026-07-25--sibling-drift-is-observed-not-speculative)
> at the end of this document. In short: decision 6's step count and decision
> 4's `auth.py` claim were both stale and are corrected in place below; the
> runtime Cognito-identity-document mechanism (issues #403/#400) is real,
> shipped machinery that this ADR never mentioned until now; and the
> Deferred section's "speculative until a second sibling template version
> exists" framing is rewritten — drift between a sibling and
> `_skeletons/sibling-template/` is already happening, not hypothetical.

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

> **Correction 2026-07-25 (issue #567):** "ported near-verbatim" is no
> longer accurate, and has not been for some time. The sibling skeleton's
> `auth.py` was last touched 2026-07-08 (`#237`, a python-jose→PyJWT swap
> only) and its `AuthenticatedUser` still carries only
> `sub`/`email`/`username`. Core's own `auth.py` has since gained the
> ADR-0012 `IdentityProvider` seam (`4a2da5e`), `mfa_authenticated` derived
> from the verified JWT's `amr` claim (`03e7746`), and `tenant_id`/`roles`
> fields — none of which reached the sibling skeleton. Structurally, the
> premise is now unsatisfiable in its original form regardless: core's
> `require_auth` depends on a DB session (`Depends(identity_session)`), and
> decision 1 above forbids a sibling from ever having one. This is recorded
> here as a known, currently **unaddressed** capability gap — not fixed by
> this correction. Updating the sibling skeleton's `auth.py` to match core's
> is real, separate, larger work, out of scope for this documentation pass.
> See the
> [2026-07-25 amendment](#amendment-2026-07-25--sibling-drift-is-observed-not-speculative)
> for the full context.

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

### 6. `biffo sibling create`: an 8-step idempotent sequence

> **Corrected 2026-07-25 (issue #567):** this was originally written up as a
> 7-step sequence, with repo creation and the skeleton push sharing one
> checkpoint. Commit `23e2ed4` (issue #316) split them after a real
> resumability bug: `create_repo` could succeed, `push_skeleton` could then
> throw, and because both effects shared one checkpoint, a resumed run
> replayed repo creation against a repo that already existed. The list below
> reflects the 8 checkpoints `cli/src/lib/sibling-session.ts` records today;
> every other reference to "step 7" (`register_with_core`) elsewhere in this
> document is corrected to step 8 accordingly. See the
> [2026-07-25 amendment](#amendment-2026-07-25--sibling-drift-is-observed-not-speculative)
> for the full context.

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
3. `create_repo` — `GitHubAdapter.createEmptyRepo`. Its own checkpoint,
   recorded the instant the repo exists.
4. `push_skeleton` — push the skeleton as the new repo's first commit. Its
   own checkpoint, deliberately separate from `create_repo` (see the
   correction above) — a push failure here must not cause a resume to
   re-attempt repo creation against a repo that already exists.
5. `oidc_trust` / 6. `terraform_backend` — this sibling's own AWS bootstrap,
   identical in shape to `biffo init`'s.
7. `github_config` — branches, branch protection (reusing the skeleton's
   own 11-job status-check list — `configureBranchProtection`'s
   `statusChecks` parameter, PR #124), GitHub Environments, and
   per-environment `CORE_*` GitHub Environment variables from step 2.
8. `register_with_core` — clones the core project's repo, appends
   `{name, bucket_regional_domain}` (the sibling's own bucket's regional
   domain, computed deterministically from its account/region/environment —
   no Terraform apply has run yet at this point, so nothing about the
   sibling's real infrastructure exists to inspect) to each environment's
   `infra/environments/<env>/siblings.auto.tfvars.json`, and opens the
   registration PR itself via `GitHubAdapter.createPullRequest`.

### 7. Two-phase CDN registration, by necessity not oversight

The sibling's own S3 bucket policy needs the core project's CloudFront
distribution ARN to grant it OAC read access — but that ARN only exists
after the registration PR (step 8 above) merges and the core project
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
- The registration PR (step 8) makes every sibling's CDN wiring reviewable,
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
  (decision 6, step 8) opens a pull request against the core project and
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
  own, and the registration PR (decision 6, step 8) follows the same
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
  upgrades (ADR-0006). **Rewritten 2026-07-25 (issue #567):** this bullet
  originally called that gap "speculative until a second sibling template
  version actually exists to sync." That framing was wrong, and known to be
  wrong at the time of writing — drift needs no "version cut" event, it
  accumulates continuously, and it is already observed and ongoing, not
  hypothetical. Two concrete, dated instances are the evidence: (1) the
  sibling skeleton's `auth.py` capability gap (decision 4's correction
  above — last touched 2026-07-08 while core's own `auth.py` gained the
  ADR-0012 identity seam, MFA gating, and `tenant_id`/`roles` in the weeks
  after), and (2) the runtime Cognito-identity-document mechanism (issues
  #403/#400 — see the
  [2026-07-25 amendment](#amendment-2026-07-25--sibling-drift-is-observed-not-speculative))
  that shipped with zero mention in this ADR until now. In direct response,
  `biffo sibling create` now stamps the core template's version into every
  newly-scaffolded sibling's `biffo.sibling.json` (`template_version`, issue
  #567) — a first, deliberately minimal step that buys drift *visibility*
  without committing to auto-merge. A full `biffo sibling upgrade`
  mechanism, mirroring `core upgrade`'s three-way-merge/PR approach, remains
  tracked future work, not built here.
- **Live end-to-end SSO proof.** The "`<name> - Hello <username>`" page
  rendering after a real cross-navigation from a deployed core portal has
  not been verified against a live AWS account as part of this ADR's
  implementation — `dev.tabsii.com`/`tabsii-platform` is the only live
  instance today and must not be used for this without explicit separate
  confirmation (a standing constraint on this work, not specific to this
  ADR). Proving this live is a distinct follow-up requiring a disposable
  test instance or deliberate use of a live one.

---

## Amendment 2026-07-20 — the root application sibling

**Status:** Accepted
**Date:** 2026-07-20
**Issue:** [#306](https://github.com/keiranholloway/biffo-template/issues/306)
**Deciders:** Keiran Holloway (Technical Architect)

### Why

This ADR assumed every sibling is an _additional_ thing hung off a product
that already exists at the root — hence `baseurl.com/<name>`, always with a
name. The tiering in #306 corrects that assumption:

| Tier                 | What                               | Where it lives           | Serves             |
| -------------------- | ---------------------------------- | ------------------------ | ------------------ |
| Core                 | data layer, API, **admin console** | the platform repo        | `/admin`, `/login` |
| Plugins              | optional capability                | installed into core      | —                  |
| **User application** | their product                      | **its own sibling repo** | **`/`**            |

`apps/portal` is strictly the admin console. The user's product is a sibling
like any other — it just happens to be the one at the front door. Rather
than invent a second mechanism for it, the sibling mechanism is extended by
one degree of freedom: the path prefix may be empty.

### What changes

1. **An empty path prefix is legal.** A sibling whose prefix is `''` serves
   `/`. `NEXT_PUBLIC_BASE_PATH` is the empty string for it, _not_ `/` —
   Next.js refuses to build with a `basePath` of `/`. Its deploy syncs to the
   bucket root rather than `s3://<bucket>/<name>/`, and invalidates `/*`.

2. **Name and path prefix become distinct concepts.** They were the same
   string for every sibling before this, which made them easy to conflate.
   They are not the same thing:

   - the **path prefix** is the URL segment, and is empty for the root;
   - the **registry name** (`sibling_origins[].name`) is the key everything
     hangs off — the CloudFront origin id `sibling-<name>`, and the key
     `collectSiblings()` uses to discover siblings during `biffo teardown`.

   The root sibling's registry name is the reserved word **`app`**. It is
   never empty. An empty key would make the sibling undiscoverable to
   teardown, which means a leaked repo, a leaked bucket and an ongoing bill —
   the exact failure #306 was filed about.

3. **`app` joins `admin` and `login` as a reserved name.** Unlike those two
   it legitimately _appears_ in `sibling_origins`, so it cannot simply be
   rejected; `modules/cloud/aws/cdn/variables.tf` enforces it by requiring
   sibling names to be unique, so a second sibling cannot claim it.

4. **The root sibling takes `default_cache_behavior`.** CloudFront allows
   exactly one default behaviour, it must name an origin that exists, and
   there is no dynamic-block form of it — so the target is a plan-time
   conditional on the registry: `sibling-app` when an `app` entry is
   registered, the portal bucket as a placeholder when not. The placeholder
   is not the portal serving root (its landing page was deleted in phase 1);
   `/` simply 404s, which is the accepted state between `init` and the
   sibling's first deploy. What the placeholder buys is a distribution that
   stays valid in that window instead of failing to apply.

   `/_next/*` belongs to the root sibling as a consequence. The portal
   vacated it in phase 1 by setting `assetPrefix: '/admin'`; without that,
   two S3 origins would claim one URL prefix and CloudFront could not
   disambiguate them.

5. **`biffo init` creates it, always.** Not a flag. Scaffolding an
   application and getting no application would be the wrong default. `init`
   therefore creates **two** GitHub repositories — the platform, and
   `<project>-app` — and says so before it creates either.

   The repo name is derived, not asked for, because three things must agree
   on it: teardown resolves a sibling's repo as `<coreOrg>/<projectName>`,
   the S3 site bucket is `<projectName>-<env>-site-<account>` (which is how
   teardown recovers the project name back out of the registry), and `init`
   must keep working non-interactively (#274).

6. **Registration precedes creation.** `init` writes the registry entry into
   the core repo _before_ creating the sibling's repo. Every value in that
   entry is derived from config, so nothing needs to exist first. The
   ordering is the safety property: a registration without a repo is
   self-correcting (teardown sees the entry, finds no repo, reclaims the AWS
   side; a resumed `init` creates it), whereas a repo without a registration
   is invisible to teardown and leaks silently.

### What does not change

The mechanism itself. Same skeleton, same shared-origin SSO, same Cognito
app client, same two-phase bucket-policy handshake, same governance. The
root sibling is discovered, destroyed and reasoned about exactly like any
other — it is a sibling with one field set to the empty string.

### Consequences

- `biffo sibling create --root` exists for re-creating a root sibling by
  hand, and pre-flights that the core's CDN can actually follow the `app`
  origin before opening a registration PR. An older core would otherwise
  merge the registration, gain the origin, and route nothing to it.
- `siblings.auto.tfvars.json` now lands in every instance on day one. Its S3
  host names contain the AWS account id by construction, so `.gitleaks.toml`
  scopes its bare-12-digit rule away from that filename. This was already
  latent — `biffo sibling create`'s registration PR has always written the
  file — and is called out rather than left to surface as a red Secret Scan
  on someone's first run.
- The window between `biffo init` and the application's first deploy serves
  a 404 at `/`. Accepted deliberately: the window is short and a 404 is
  honest. No placeholder page is shipped to paper over it.

---

## Amendment 2026-07-25 — sibling drift is observed, not speculative

**Status:** Accepted
**Date:** 2026-07-25
**Issue:** [#567](https://github.com/keiranholloway/biffo-template/issues/567)
**Deciders:** Keiran Holloway (Technical Architect)

### Why

Found during the core/plugin/sibling boundary audit (PR #562): this ADR's
Deferred section described the absence of a sibling upgrade mechanism as
speculative — "speculative until a second sibling template version actually
exists to sync" (corrected in place above). That framing was already wrong
when written. Drift between `_skeletons/sibling-template/` and what a
scaffolded sibling actually carries needs no "version cut" event to exist —
it accumulates continuously, starting the moment a sibling's first commit
lands. Two concrete, dated instances prove it was already happening:

1. **`auth.py` capability drift** (decision 4's correction above). The
   sibling skeleton's `middleware/auth.py` was last touched 2026-07-08
   (`#237`, a python-jose→PyJWT swap only). Since then, core's own
   `auth.py` gained the ADR-0012 `IdentityProvider` seam (`4a2da5e`),
   `mfa_authenticated` derived from the verified JWT's `amr` claim
   (`03e7746`), and a shared-package JWT-verifier refactor (`5a3bace`) —
   none of which reached the sibling. The sibling's `AuthenticatedUser`
   still only carries `sub`/`email`/`username`.
2. **The runtime identity-document mechanism went undocumented here
   entirely** — described below — despite being real, shipped machinery
   with its own CLI command.

This amendment also rolls in a documentation-only correction pass (decision
6's stale step count, decision 4's stale claim, this Deferred-section
rewrite) alongside the drift finding, per this repo's own precedent for that
shape of amendment — see [2026-07-20](#amendment-2026-07-20--the-root-application-sibling)
above.

### The runtime Cognito-identity-document mechanism (shipped since #403/#400, never documented here until now)

Since issue #403 (stage 3, 2026-07-23), a sibling's frontend is **doc-only**:
it never carries a baked `NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID` /
`NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID`. Instead,
`_skeletons/sibling-template/apps/frontend/src/lib/identity.ts` resolves the
core's Cognito coordinates purely **at runtime**, via a memoised, same-origin
`fetch('/.well-known/biffo-identity.json')` — the core publishes this
document from the portal bucket, same origin as every sibling (the same
same-origin property decision 3 above already relies on for shared-session
SSO). There is **no baked-env fallback**: a fetch that fails, or a document
missing either id, resolves to `null`, and the caller treats that as "signed
out" — a clean redirect to the core's own login beats trusting a stale local
pool id, which is precisely the staleness bug (#400) this migration exists to
remove.

The backend deliberately does **not** follow the frontend's lead. It keeps a
static, baked `CORE_COGNITO_USER_POOL_ID` GitHub Environment variable —
wired at deploy time into `TF_VAR_core_cognito_user_pool_id`, which builds the
JWKS URL the sibling's own Lambda verifies tokens against — rather than
resolving anything at request time. This is a considered security decision,
not an oversight (issue #496): the value gating JWT verification "belongs in
version-controlled config, not a document fetched in the auth hot path."
Baking it means a corrupted, unreachable, or substituted identity document
can never flip which Cognito pool a sibling's backend trusts — the
front-end's UX convenience (never point at a dead pool) is deliberately not
extended to the one place where a wrong value would be a security incident
rather than a bad redirect to `/login`.

That static/runtime split creates exactly the kind of two-copies-of-the-truth
drift decision 4's correction above describes at the code level: the
published document (frontend) and the baked GitHub variable (backend) can
each independently go stale against the core's *live* pool, most obviously
across a Cognito pool rotation. `biffo sibling check-identity` (issue #400 —
`cli/src/commands/sibling-check-identity.ts` /
`cli/src/lib/sibling-identity-check.ts`) exists specifically as the safety net
for this: run against a core project, it reads the live pool id from that
core's Terraform outputs, fetches its published identity document, and reads
each registered sibling's baked `CORE_COGNITO_USER_POOL_ID` GitHub Environment
variable per environment — reporting `published-doc-unreachable`,
`published-doc-stale`, `sibling-var-missing`, or `sibling-backend-stale`
findings and exiting non-zero on any of them, so a scheduled/CI run goes red
on drift instead of the failure surfacing later as silent, unexplained 401s.

### Corrections made to this document

- **Decision 6's step count**, corrected in place above: 7 steps → 8.
  Commit `23e2ed4` (issue #316) split the original combined `create_repo`
  checkpoint into separate `create_repo` and `push_skeleton` checkpoints
  after a real resumability bug — a push failure between the two, sharing
  one checkpoint, caused a resumed run to re-attempt repo creation against a
  repo that already existed. Every other "step 7" reference to
  `register_with_core` in this document (the two-phase registration
  section, Consequences, Compliance, Related Decisions) is corrected to
  step 8 accordingly.
- **Decision 4's "ported near-verbatim" claim**, corrected in place above:
  no longer true, and — given decision 1's DB-less constraint on a sibling —
  structurally can't be true again in the form originally described.
  Recorded as a known, currently **unaddressed** capability gap. Updating
  the sibling skeleton's `auth.py` to match core's is real, separate, larger
  work and is explicitly **not** done by this amendment.
- **The Deferred section's "speculative" framing**, rewritten in place
  above: drift is observed and ongoing, not hypothetical.

### What changes structurally

**Very little, deliberately.** Issue #567 considered three options: build a
full `biffo sibling upgrade` now; take a cheaper version-tracking-only step
for visibility; or change nothing structural and just correct the record.
The recommended, and chosen, near-term step is the middle one: `biffo
sibling create` now stamps the core template's version
(`getLatestCoreVersion()` — the same value `biffo init` stamps into
`biffo.core.json`'s `version` field, ADR-0006) into a new `template_version`
field on the scaffolded `biffo.sibling.json`
(`SiblingMarker.template_version` in `cli/src/lib/sibling-teardown.ts`;
written by `writeSiblingTemplate` in `cli/src/commands/sibling-create.ts`).

This is **visibility only**. Nothing reads or compares the field yet, and
`markerMatches` — the identity check `biffo teardown` relies on to confirm a
candidate repo really is the sibling it means to delete — deliberately does
not use it; provenance is not identity. Its purpose is the same foundational
one `biffo.core.json`'s `version` field played before `biffo core
upgrade`/`biffo core status` existed to consume it: give a future tool
something to diff against.

### What does not change

No `biffo sibling upgrade` command exists after this amendment, and none is
built by it. A full mechanism — mirroring `core upgrade`'s three-way-merge/PR
approach, scoped to the vendored pieces most likely to drift (`middleware/
auth.py`, the frontend identity/auth libs, vendored Terraform modules) rather
than the whole skeleton — remains tracked future work (issue #567's option
1), deferred until a second real sibling exists to validate the merge model
against, exactly as that issue recommends. The sibling's own `auth.py` is
likewise **not** updated to match core's by this amendment; the gap is now
documented (decision 4's correction above), not closed.

### Consequences

- A newly-scaffolded sibling's `biffo.sibling.json` gains a
  `template_version` field. Siblings scaffolded before this amendment simply
  have none — that absence is itself a (currently unread) drift signal, not
  an error condition.
- This ADR now names the runtime identity-document mechanism and `biffo
  sibling check-identity` for the first time. The companion guide
  (`docs/guides/sibling-apps.md`) is corrected in the same pass to stop
  pointing readers at the build-time `NEXT_PUBLIC_CORE_COGNITO_*` env vars
  the #403 migration removed from the sibling frontend.
- The real decision this issue raised — whether to build a full `biffo
  sibling upgrade` — remains open. This amendment records the evidence for
  it and takes the cheapest step that doesn't foreclose deciding it later.
