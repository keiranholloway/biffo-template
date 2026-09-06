# Feature: Shared plugin frontend mount — consolidate user-facing plugin hosting onto ADR-0021

**Issue:** [keiranholloway/biffo-template#558](https://github.com/keiranholloway/biffo-template/issues/558)
**Decision:** owner chose **option B** on 2026-08-16 and reconfirmed it on 2026-09-06 — extend
the shared plugin host's already-live static-shell serving to `user_frontend`, rather than
building ADR-0021 §2's unbuilt founder app-shell SPA (option A).
**Prior verification:** biffo-fleet#774 (2026-08-29) returned `SURVIVES-INCOMPLETE`. PR #1621
removed one already-dead code path (`UserFrontend` in `services/api/`); the remainder is
entirely unbuilt. Current state below was re-measured against `origin/dev` @ `d453d94f`.

## Summary

Today a user-facing plugin has **two** hosting models. Its backend is ADR-0021: one shared
`services/_plugin-host/` Lambda behind the Core API Gateway at `/api/v1/plugins/*`. Its
frontend is still ADR-0018: a per-plugin S3 bucket, a hand-registered `sibling_origins`
entry, a per-plugin CloudFront `<name>/*` behaviour, and a per-plugin Terraform module —
provisioned once per plugin, in every instance that installs it.

Option B closes that split by using the mechanism the host **already runs in production**
for `admin_ingress`: serve the built bundle from inside the host's own mount, exempt exactly
the static paths from the token check, and add the matching unauthenticated API Gateway
routes. A plugin's founder UI becomes files in the host zip instead of infrastructure.

One improvement over the admin shape, and it is what makes the migration a deletion rather
than a rewrite: **the host serves the bundle itself**, from the manifest's `user_frontend.dir`.
`admin_ingress` makes each plugin mount its own `StaticFiles` (see
`biffo-plugin-ideation/src/ideation/admin_app.py:218-242`), which is per-plugin code doing a
platform job. For `user_frontend` the plugin ships `web/` and nothing else.

## Success criteria

Observable, in this order:

1. `curl -sS https://dev.biffo.io/api/v1/plugins/ideation/ui/` returns Ideation's
   `index.html` (HTTP 200, `content-type: text/html`) **with no `Authorization` header**,
   while `curl` of `/api/v1/plugins/ideation/sessions` without a token still returns `401`.
2. A founder can complete an Ideation session end to end at that URL — assets resolve, the
   Cognito login works same-origin, the API calls succeed.
3. `aws s3api head-bucket --bucket biffo-platform-dev-plugin-ideation-web` returns
   `404 Not Found`, and `infra/environments/dev/siblings.auto.tfvars.json` in biffo-platform
   contains no `ideation` or `idea-scout` entry.
4. In biffo-template, `git grep -rn 'plugin-\${name}-web' .github/workflows/` returns nothing
   and `docs/ADR/0018-user-facing-plugin-hosting.md` reads `Superseded by ADR-0021` with no
   "in part".
5. Installing a plugin whose `terraform/` declares the ADR-0018 frontend bucket **fails**
   with a named error, so the retired model cannot come back.

Criteria 1, 4 and 5 are in scope for this repo. Criteria 2 and 3 land in
`biffo-plugin-ideation` and `biffo-platform` — see [Cross-repo boundary](#cross-repo-boundary).

## Scope / explicitly deferred

**In scope (biffo-template):** the ADR decision text, the host-side static mount, the
API Gateway routes, the deploy packaging, the CLI guard that makes the old model
un-installable, and the final deletion of the ADR-0018 frontend deploy path.

**Deferred, deliberately:**

- **ADR-0021 §2's founder app-shell SPA (option A).** Not built. Option B does not foreclose
  it: the manifest field is `user_frontend` either way. If founder-facing plugin count or
  asset traffic grows past what M1 prices, A is the right end state and this work is not
  wasted — the manifest contract and the migration are shared.
- **`admin_ingress` is not changed.** It keeps its per-plugin `StaticFiles` mount. Converging
  it onto the host-served shape M2 introduces is an obvious follow-up and is **not** in this
  epic; doing it here would put M2's builder in `biffo-plugin-ideation` and
  `biffo-plugin-idea-scout` as well.
- **`user_frontend.required_group` still gates nothing on the shell.** ADR-0018 §2 says it
  gates the UI; nothing implements it, and option B **cannot** implement it either — a plain
  browser navigation cannot attach a bearer header, which is exactly why the admin shell's
  two Gateway routes are `authorization_type = "NONE"`. This was already established at
  `docs/guides/development-practices.md:239`: the shell is a 428-byte empty
  `<div id="root">`, and every API route behind it `401`s. M1 must **write that down** in
  the ADR rather than let the field keep implying a gate it has never had. Making the shell
  itself gated is a separate decision (it needs a redirect-to-Cognito at the edge) and is
  not in this epic.

## Current state

Measured against `origin/dev` @ `d453d94f` (biffo-template), and the live `origin/dev` of
`biffo-plugin-ideation` / `biffo-plugin-idea-scout`.

### What already exists — do not rebuild it

| Thing | Where | State |
|---|---|---|
| Shared plugin host Lambda | `services/_plugin-host/` | live, mounts `/<name>` and `/<name>/admin` |
| Static-shell exemption from the token check | `mount.py:_is_public_admin_asset` (`""`, `"/"`, `/assets/*`) + `group_gate(is_public_path=…)` | live — **this is the mechanism M2 extends** |
| Bare-path (no trailing slash) Mount normalisation | `mount.py:_normalize_bare_admin_paths` | live, and its docstring records why the no-slash form is the only reachable one |
| Unauthenticated API Gateway routes for the shell | `infra/environments/dev/plugin-host.core.tf:116,128` | live, two routes, `authorization_type = "NONE"` |
| Building a plugin's UI into the host zip | `.github/workflows/deploy-app.yml:938-970` (`web-admin/`), fail-**closed** when declared-but-missing | live — **M2 mirrors this for `web/`** |
| Manifest schema for `user_frontend` | `cli/src/lib/plugin-manifest.ts:251` (`UserFrontendSchema`), `packages/python-sdk/.../plugin.py:497` | live, validated, **keep** |
| `plugin wire`, `lib/plugin-origin.ts`, `cdn` module `plugin_api_origins`, `parse_user_frontend_from_manifest` | — | **already removed.** The issue body's item-4 bullets for these are stale; #1621 did the last one. |

### What is genuinely unbuilt

- `git grep -n ui_mount` → **zero hits outside ADR prose.**
- Nothing in `services/_plugin-host/` or `infra/environments/dev/plugin-host.core.tf` serves
  a `user_frontend` bundle.
- `.github/workflows/deploy-app.yml:993-1040` (repeated verbatim at `:1924` and `:2867`)
  still syncs each plugin's built `web/dist` to `${prefix}-plugin-${name}-web` — the
  ADR-0018 path, three copies, one per environment job.
- `cli/src/lib/plugin-terraform-wiring.ts:113` still emits `cdn_distribution_arn` into every
  generated plugin module block that declares the variable.

### Two facts that narrow the work

- **The template's plugin host is dev-only.** `infra/environments/{staging,prod}/` contain
  only `artifacts.core.tf`; `plugin-host.core.tf` exists in `dev/` alone, and
  `core-manifest.json` distributes only `infra/environments/dev/plugin-host.core.tf`. M2's
  Terraform change is one file, not three.
- **The plugin skeleton is already clean.** `_skeletons/plugin-template/terraform/` declares
  no S3 bucket, no CloudFront, no `cdn_distribution_arn`, and its manifest has no
  `user_frontend`. A *new* plugin is not born on the old model — the per-plugin bucket lives
  in each existing plugin's own `terraform/main.tf` (`aws_s3_bucket.frontend`, bucket name
  `${local.name_prefix}-plugin-${var.plugin_name}-web`). So M3 is a **guard against
  regression**, not a skeleton rewrite.

### Who is still on the old path

**Two plugins, one instance.** `biffo-plugin-ideation` and `biffo-plugin-idea-scout` both
declare `user_frontend: {dir: "web/dist", required_group: "founder"}` and both serve live on
`https://dev.biffo.io/` off their own buckets today. `biffo-platform` registers both in
`infra/environments/dev/siblings.auto.tfvars.json` and `plugins.generated.tf`. **tabsii-platform
has zero** — its six `sibling_origins` entries are genuine ADR-0007 siblings, and
`services/marketing/biffo.plugin.json` has `"user_frontend": null`.

Only `biffo-plugin-ideation` has its own `deploy-frontend.yml`; idea-scout's frontend is
deployed solely by the template's `deploy-app.yml` step.

## Cross-repo boundary

Computed by longest matching prefix in `core-manifest.json` (ties → user-owned), not inferred
from directory names:

| Path | Owner | Matched prefix |
|---|---|---|
| `services/_plugin-host/**` | **template** | `services/_plugin-host/` (beats user-owned `services/`) |
| `infra/environments/dev/plugin-host.core.tf` | **template** | exact-file entry (beats user-owned `infra/`) |
| `.github/workflows/deploy-app.yml` | **template** | `.github/` |
| `cli/**` | **template repo only** | not in the manifest at all — the CLI is not distributed to instances |
| `docs/ADR/**` | user-owned | ADRs are **not** distributed; the ADR lives in biffo-template and is authoritative there |
| `services/ideation/**`, `infra/modules/**`, `infra/environments/dev/siblings.auto.tfvars.json` | **user** | `services/`, `infra/` |

So every milestone below is correctly in biffo-template, and the instance-side and
plugin-side work correctly is not. The two cross-repo items are **not** a `core-manifest.json`
ambiguity — the boundary is unambiguous; they are simply owned elsewhere.

### Cross-repo work this epic depends on (filed as blockers, not as milestones here)

- **`keiranholloway/biffo-plugin-ideation`** — repoint `web/vite.config.ts`'s
  `base: '/ideation/'` at the new mount path, delete `.github/workflows/deploy-frontend.yml`,
  and delete `terraform/`'s `aws_s3_bucket.frontend` + `frontend_bucket_*` outputs +
  `cdn_distribution_arn` variable. Consumes M2's contract.
- **`keiranholloway/biffo-platform`** — remove the `ideation` / `idea-scout` entries from
  `infra/environments/dev/siblings.auto.tfvars.json`, the two `module "plugin_<name>"` blocks
  from `plugins.generated.tf`, and destroy the two buckets.

### Unresolved: `biffo-plugin-idea-scout`

`idea-scout` needs the **same** migration as ideation (its `web/vite.config.ts` carries the
same path-prefixed `base`, and its `terraform/` carries the same bucket), but this planning
session is scoped to biffo-template and is sanctioned to record exactly two cross-repo
blockers. **biffo-platform cannot complete its half until idea-scout has migrated too**, so
the biffo-platform blocker names this explicitly and a third issue must be filed against
`keiranholloway/biffo-plugin-idea-scout` before M4 can close. Flagged rather than dropped.

## Milestones

Sequencing: **M1 → {M2 ∥ M3} → (cross-repo) → M4.** M2 and M3 are read-disjoint and can be
built in parallel. M4 reads files M2 and M3 both touch and must land last.

---

### M1 — Rewrite ADR-0021 §2 as the shared-host static mount; fully supersede ADR-0018

**Reads:** `docs/ADR/`
**Depends on:** nothing
**Budget:** ~80k

This is the contract M2, M3 and both cross-repo issues build against, and it is where the
advocate's precondition — *"price the Lambda-vs-CloudFront asset cost before committing"* —
gets paid. It is a decision document with measurements in it, not prose.

It must settle and write down:

- **The URL.** `/api/v1/plugins/<name>/ui/*`, reached through the existing shared
  `api/v1/plugins/*` CloudFront behaviour — no new per-plugin behaviour, which is the whole
  point. State the old `/<name>/` URL is retired and whether any redirect is kept (recommend
  none; there is no per-plugin behaviour left to host one on).
- **Who serves.** The host, from `BIFFO_PLUGINS_ROOT/<name>/<user_frontend.dir>`, driven by
  the manifest. Not the plugin. Contrast this with `admin_ingress`'s per-plugin `StaticFiles`
  and say why the two differ (and that converging admin is deferred).
- **What `required_group` does and does not gate** — see *Scope / explicitly deferred*. The
  shell is public; the API is gated. Correct ADR-0018 §2's claim.
- **SPA deep links.** Unknown paths under `/ui/` fall back to `index.html`; the plugin's JSON
  API is at `/<name>/*` and is never shadowed.
- **Three hard limits, measured, not assumed:**
  1. **API Gateway's 6 MB Lambda proxy response limit** — build `biffo-plugin-ideation/web`
     and record the largest single asset and the total `dist/` size. If any asset approaches
     6 MB, option B does not work unchanged and the ADR must say so.
  2. **Host zip budget** — `deploy-app.yml` already trims boto3 "so the zip fits the direct
     `update-function-code` limit". Record the current host zip size and the delta from
     adding every `user_frontend` plugin's `dist/`.
  3. **Per-request cost** — API Gateway ($/M requests) + Lambda GB-s per asset request
     versus CloudFront ($/GB), at a stated founder-session volume. State the assumption.
- **The migration order** across the three repos, so the two cross-repo issues and M4 read the
  same sequence.

**Done when:** `git grep -n "not yet built" docs/ADR/0021-shared-plugin-hosting.md` returns
nothing; `docs/ADR/0018-user-facing-plugin-hosting.md`'s Status line reads
`Superseded by ADR-0021` with no "in part"; ADR-0021 §2 names the literal path
`/api/v1/plugins/<name>/ui/*` and carries the three measured numbers above with their units;
ADR-0013 and ADR-0017 cross-refs to ADR-0018 §2 point at ADR-0021 §2.

---

### M2 — The shared plugin host serves a plugin's `user_frontend` bundle

**Reads:** `services/_plugin-host/`, `infra/environments/dev/plugin-host.core.tf`,
`.github/workflows/deploy-app.yml`
**Depends on:** M1
**Budget:** ~250k — the largest milestone. Three layers, but one mechanism, and each layer is
a mirror of an adjacent, already-working one.

1. **`discover.py`** — carry `user_frontend` (`dir`, `required_group`) onto `DiscoveredPlugin`.
   `PluginManifest` already parses it, so this is plumbing, not new validation. Keep it in
   `_SALVAGEABLE_FIELDS` company: a malformed `user_frontend` must drop only the frontend,
   never the plugin.
2. **`mount.py`** — mount `StaticFiles(directory=…, html=True)` at `/<name>/ui`, wrapped so it
   is unauthenticated (it needs no `group_gate` at all — the shell is public by design, see
   M1) and quarantined like every other mount. Extend `_normalize_bare_admin_paths` to cover
   `/<name>/ui`; **its existing docstring is the specification** — a `Mount` compiles to a
   regex requiring the trailing slash, and a bare request silently falls through to the
   *founder* mount and is gated with the wrong group. This was confirmed live once already;
   do not rediscover it.
3. **`infra/environments/dev/plugin-host.core.tf`** — two unauthenticated routes:
   `GET /api/v1/plugins/{name}/ui` (bare — API Gateway v2 rejects a route key ending in an
   empty segment, #631) and `GET /api/v1/plugins/{name}/ui/{proxy+}`. The `{proxy+}` form has
   more literal segments than the blanket `ANY /api/v1/plugins/{proxy+}` JWT route, so it
   wins for exactly `/ui/**` and leaves the plugin's JSON API on the JWT route. This is one
   file — staging and prod have no plugin host.
4. **`deploy-app.yml`** — in the "Package and deploy the shared plugin host" step (all three
   copies, `:884`, `:1815`, `:2758`), build `<plugin_dir>/web` when the manifest declares
   `user_frontend` and copy `dist/` to `$pkg/services/<name>/web/dist`. Mirror the
   `web-admin` block exactly, **including its fail-closed error**: declaring `user_frontend`
   with no `web/` must `::error` and `exit 1`, not skip silently. That silent skip is
   biffo-plugin-idea-scout#22's cause and the workflow's own comment says so.

**Verify against the two known edge traps:** CloudFront rewrites some API-origin errors into
portal HTML (#647), so measure against the API Gateway origin directly as well as through the
CDN; and a 404 under `/ui/` must return the SPA `index.html`, not portal HTML.

**Done when:** `services/_plugin-host/tests/test_mount.py` asserts, against a fixture plugin,
that unauthenticated `GET /<name>/ui`, `/<name>/ui/`, `/<name>/ui/assets/app-abc123.js` and a
deep link `/<name>/ui/session/42` all return the bundle (the deep link returning
`index.html`), while `GET /<name>/sessions` with no token still returns `401` JSON;
`terraform validate` passes in `infra/environments/dev`; a deploy-workflow test/lint asserts
the declared-but-missing `web/` case exits non-zero; and after deploy to biffo-platform dev,
`curl -sS -o /dev/null -w '%{http_code} %{content_type}'
https://dev.biffo.io/api/v1/plugins/ideation/ui/` prints `200 text/html` with no
`Authorization` header sent.

*Honest partial value:* Ideation's bundle still carries `base: '/ideation/'`, so its **assets**
will 404 at the new path until the cross-repo migration repoints them. M2's production
observable is therefore the shell responding, not a working app. That is deliberate and the
next item fixes it.

---

### M3 — Make the ADR-0018 per-plugin frontend shape un-installable

**Reads:** `cli/src/`, `_skeletons/plugin-template/`, `docs/guides/`
**Depends on:** M1
**Budget:** ~80k

The prosecutor's finding was that nothing makes the two-hosting-models cause *impossible*.
This is that guard. It is small on purpose and it is the thing that stops #558 recurring.

- `biffo plugin install` (and `plugin upgrade`) **refuses** a plugin whose `terraform/`
  declares the retired frontend shape — an `aws_s3_bucket` whose name interpolates
  `-plugin-…-web`, an output named `frontend_bucket_*`, or a `cdn_distribution_arn` variable
  — with an error naming ADR-0021 §2 and the `user_frontend` contract. Fail-closed: a plugin
  that ships this today is on a retired model and must be told, not silently wired.
- Document the contract where a plugin author will actually meet it: `_skeletons/plugin-template`'s
  README (a `user_frontend` plugin ships `web/` and nothing else — no `terraform/` frontend,
  no `deploy-frontend.yml`) and the plugin guide under `docs/guides/`.
- **Do not remove** `cdn_distribution_arn` from `standardArguments` yet. It is emitted only
  when the plugin's own module declares the variable, and removing it while biffo-platform's
  ideation/idea-scout modules still require it reproduces #685 — a whole environment failing
  `terraform plan` on "No value for required variable". That removal is M4's.

**Done when:** a CLI unit test asserts `runPluginInstall` exits non-zero, with an error naming
ADR-0021 §2, on a fixture plugin whose `terraform/main.tf` declares
`aws_s3_bucket "frontend"` with a `-plugin-${var.plugin_name}-web` name; a second asserts a
`user_frontend` plugin with no `terraform/` frontend installs cleanly; and
`_skeletons/plugin-template/README.md` states the `user_frontend` contract.

---

### M4 — Delete the ADR-0018 frontend deploy path from the template

**Reads:** `.github/workflows/deploy-app.yml`, `cli/src/lib/plugin-terraform-wiring.ts`
**Depends on:** M2, M3, **and both cross-repo blockers** (plus the idea-scout issue noted
above) — this deletes the deploy path that is still keeping `dev.biffo.io/ideation/` and
`/idea-scout/` alive. Landing it early takes production down.
**Budget:** ~80k

- Remove the "Build and deploy plugin frontends" step and the "Invalidate CloudFront for
  plugin frontends" step from all three environment jobs in `deploy-app.yml`.
- Remove `['cdn_distribution_arn', 'module.cdn.distribution_arn']` from `standardArguments`
  in `plugin-terraform-wiring.ts`, leaving the removal note that explains #685 so the next
  reader does not re-add it.
- Retire the now-stale pointers: the `#558` "until the shared app-shell lands" comments in
  `deploy-app.yml`, the removal-note docstring in
  `services/api/src/api/models/plugin_user_surface.py` that points readers back at #558, and
  the ADR-0021 Status line's forward reference.

**Done when:** `git grep -rn 'plugin-\${name}-web' .github/workflows/` and
`git grep -rn cdn_distribution_arn cli/src --` (excluding the removal note) both return
nothing; `git grep -rn '#558' services/ cli/ .github/ docs/ADR/` returns nothing; and a
biffo-platform dev deploy runs green with no plugin-frontend step.

## Testing plan

- **M1** — no code. The measurements are the test: the ADR is wrong if its numbers are absent
  or unitless.
- **M2** — `services/_plugin-host/tests/test_mount.py` against a synthetic fixture plugin, so
  the suite does not depend on Ideation's real bundle; `terraform validate`; a real
  unauthenticated `curl` against both the CDN and the API Gateway origin after deploy (#647
  makes the CDN alone an unreliable observer of a 4xx).
- **M3** — CLI unit tests, both directions (refuses the old shape, accepts the new one). A
  guard that only has a passing case has not been shown to fire.
- **M4** — the estate's existing deploy-workflow lint plus a green biffo-platform dev deploy;
  and criterion 1 above must still hold **after** M4, which is the actual proof the old path
  was dead when it was removed.

## Rollout

1. M1 merges. Both cross-repo blockers become buildable — they now have a contract.
2. M2 and M3 build in parallel and merge.
3. biffo-platform dev deploys; criterion 1 passes; the old buckets are still serving, so
   nothing has broken for a user.
4. `biffo-plugin-ideation` and `biffo-plugin-idea-scout` migrate onto the new path.
   Criterion 2 passes.
5. `biffo-platform` removes the modules, the `sibling_origins` entries and the buckets.
   Criterion 3 passes.
6. M4 merges. Criteria 4 and 5 pass and ADR-0018 is fully superseded.

**Rollback:** reversible at every step. Nothing is destroyed but two S3 buckets holding a
rebuildable static export, and they are only destroyed at step 5, after step 4 proved the
replacement serves. Steps 1-3 are purely additive — the old path keeps serving throughout.
