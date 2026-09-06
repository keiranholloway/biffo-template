# Feature: `biffo plugin verify` — real-execution conformance harness

Plan for [#1523](https://github.com/keiranholloway/biffo-template/issues/1523), Phase 1 of
epic [#1521](https://github.com/keiranholloway/biffo-template/issues/1521) (rapid plugin
development).

**Status: proposed.** Nothing here is built. This document is the spec; merging it
authorises filing the milestone issues below and nothing else.

## Summary

One real-execution conformance harness for plugins, owned by the template's packages and
invoked identically from a developer's shell and from CI, so local green predicts CI green.
It stubs neither side of each seam it covers.

#1523 names five seams. **Three are buildable now; two are gated on work that has not
landed.** This plan scopes the three, and says precisely what the other two are waiting on
rather than filing milestones nobody can close.

## Success criteria (observable)

1. In a plugin repo, `sh scripts/biffo.sh plugin verify` exits 0 and prints its
   **denominator** before its verdict — e.g.
   `verify: 2 ingress(es) mounted [user_ingress→marketing.app:app,
   admin_ingress→marketing.admin_app:app]; 6 table(s) applied; 14 declared route(s)
   resolved: <list>`. A green with no printed scope is a failure of this feature
   (#1363's shape).
2. The same command runs **twice in a row against the same database** and is green both
   times; a check that is not re-runnable fails the second pass and fails the job.
3. Reverting PR #1513 (the #1511 fix) turns the harness **red**, on the migration-delta
   assertion, without any other change. The recorded defect becomes a permanent fixture.
4. Pointing a manifest's `user_ingress.app` at an attribute that does not exist makes the
   harness exit non-zero **naming the ref** — rather than the first Lambda cold start
   discovering it.
5. `.github/workflows/` in all three existing plugin repos invokes the same one command,
   and a `*.test.sh`/guard-with-no-caller check fails closed if it ever stops being
   invoked (#1413).
6. Every check the harness *declares* but has not implemented is printed as
   `not-implemented`, so the denominator can never silently shrink to "1 of 1".

## Current state — researched against `dev` at `d453d94f` (2026-09-06)

### What already exists, and must not be rebuilt

| Thing | Where | Bearing on this plan |
|---|---|---|
| A real-Postgres **local** lane | `scripts/pg-test-db.sh`, `pg_test_run`/`pg_test_modules` in `scripts/verify.sh`, `scripts/pgtest-diff-check.sh` in the pre-push hook | The composition's Postgres half is **already built and already distributed** — `scripts/pg-test-db.sh` is in `cli/package.json`'s `files`, so `sh scripts/biffo.sh pg-test-db` works in any repo today. The harness raises Postgres with this, it does not write a new one. |
| The `*_pg.py` discovery convention | `services/api/tests/test_*_pg.py`, `test_permanently_skipped_pg_tests.py` | The estate already has a working "discover, don't register" convention for real-DB tests. The harness copies it rather than inventing a check registry. |
| The migration **delta** fix | `ebb4443a` / PR #1513, closing #1511 | #1511 is **fixed**. The milestone below builds the *fixture that keeps it fixed*, not the fix. |
| Real host discovery + import | `services/_plugin-host/src/plugin_host/discover.py` (`load_app`, line 277: `getattr(import_module(module_name), attr)`) and `mount.py` | The mechanism to resolve `module:attr` for real **exists**. Nothing anywhere exercises it against a plugin on disk. |
| One validated manifest parser | `biffo_plugin_sdk.plugin.PluginManifest`, `extra="forbid"`; `discover.py`'s `_load_manifest_tolerant` (#1517/PR #1561) | Part of #1517 landed. See "what has not landed" below for the part that has not. |
| A zero-caller guard precedent | the `Guard self-test wiring` step in `_skeletons/plugin-template/.github/workflows/ci.yml` (#1710), and `scripts/guard-self-test-wiring.sh` | #1523's "grep-for-callers check" has a working shape to copy. It explicitly fails on an empty discovery ("an empty discovery is not a vacuous pass"). |
| The two CloudFront Functions and their unit tests | `modules/cloud/aws/cdn/rewrite.js`, `click-rewrite.js`, `main.tf`; `cli/src/lib/cdn-rewrite-function.test.ts`, `cdn-click-rewrite-function.test.ts` | #1503 is **merged**. The functions are individually tested. What is missing is a single document both the Terraform behaviours and the assertions read. |

### What does not exist

- **No `biffo plugin verify`.** `cli/src/commands/plugin.ts` registers eight subcommands
  (`create`, `list`, `install`, `uninstall`, `upgrade`, `sync-migrations`, `info`,
  `staleness`). There is no `verify`, and no `cli/src/lib/plugin-verify/`.
- **No real-Postgres lane in CI, anywhere in the template.** `.github/workflows/ci.yml`
  has no service container and no `_pg` reference; the `*_pg.py` modules collect and
  *skip*. The real-DB discipline is local-only, enforced at push time. This is itself an
  instance of the class the epic is about, and M3 below closes it for the plugin surface.
- **No Postgres, no host, no Core in the plugin skeleton's CI.** Its jobs are `lint`,
  `typecheck`, `test`, `validate-manifest`, `terraform`, `security-secrets`,
  `security-deps` — every one against mocks.
- **`biffo-plugin-host` is not a published package.** `pyproject.toml` names it and builds
  a hatchling wheel, but there is no `publish-plugin-host.yml` and
  `https://pypi.org/pypi/biffo-plugin-host/json` returns **404** (checked 2026-09-06);
  only `deploy-app.yml` references it, by vendoring. **A plugin repo therefore cannot
  import the real host at all** — so any plugin-side host check today would have to
  re-implement discovery, which is exactly the mock this feature exists to delete.
- **The migration generator is Core-coupled and unreachable from a plugin repo.**
  `services/api/src/api/migrations/plugin_migrations.py` (875 lines) imports
  `..models.plugin_table`; `PluginMigrationsAdapter` shells into
  `services/api/scripts/generate_plugin_migrations.py` at an instance path. A plugin repo
  has no `services/api`, no Alembic and no migrations directory.
- **The skeleton's example plugin declares no ingress.** `_skeletons/plugin-template/biffo.plugin.json`
  has no `user_ingress` and no `admin_ingress`, so the skeleton carries no fixture for the
  host-mount seam.

### Blocked items — confirmed, not assumed

**#1523 item 3 (real Core) is gated on spike #1522, which has not been run.**
[#1522](https://github.com/keiranholloway/biffo-template/issues/1522) is `OPEN`, has
**zero comments**, and carries `fleet:hold`. Its deliverable is a feasibility report, and
#1521 states the real-Core decision explicitly as *"Gated on the spike confirming Core
boots under uvicorn against harness Postgres with a dev-mode token minter."* No milestone
for item 3 is filed here. Writing one would mean inventing the done-condition the spike
exists to establish.

**#1523 item 4 (config resolution) is gated on Phase 0 / #1517, which has not landed.**
`PluginManifest` (`packages/python-sdk/src/biffo_plugin_sdk/plugin.py:567`) declares
`name, version, description, author, tags, tables, api_routes, required_core_version,
tools, chat_agents, seed, chat_agents_dynamic, event_subscriptions, ui_components,
dependencies, core_capabilities, user_ingress, admin_ingress, user_frontend` — **there is
no `config` field**, and `UserIngress`/`AdminIngress`/`UserFrontend`/`ChatAgentDeclaration`
still carry a literal `required_group: str`. Adjacent work merged (PR #1534/#1535
`plugin_host_environment`, PR #1561 the unified parser, PR #1550 the public base URL), but
the declared-needs mechanism itself does not exist. #1517 is still `OPEN`, labelled
`needs-decision` and `in-progress`. There is nothing for a config-resolution check to
resolve.

**A third gap, found during research and not previously recorded.** #1523 item 5 says the
harness *"asserts every manifest-declared public route"*. `RouteDef`
(`plugin.py:241`) has **no public/unauthenticated flag** — its fields are
`method, path, table, operation, description`, and every declared route is synthesised
CRUD behind the gate. The `/c/<token>` tracked-link path #1503 fixed is hard-wired into
`main.tf` and Core's `/api/v1/public/c/{token}`; it is not manifest-declared and could not
be. So item 5 splits: the **contract document** half is buildable now (M4 below); the
**manifest-declared public route** half needs a manifest schema change and belongs with
Phase 0's manifest work, not here. This is filed as a named gap, not a milestone.

## Design decision: the checks ship in the packages, not in the repos

#1523's title says "skeleton-distributed". Research says do it the other way round, and
this is the one place the plan departs from the issue as written.

`shared-files.json`'s own header states the policy: *"SINCE 2026-08-03 THIS LIST IS
SHRINKING, NOT GROWING (#1109) … Every guard that moves into the CLI leaves this list, and
roughly ten estate guards exist only to police the copies that remain."* Distributing a
large conformance workflow into three plugin repos would add the eleventh policeman and
guarantee three divergent copies — the condition #1523 exists to end.

So:

- The **command and the composition** live in the CLI (`@biffo/cli`), reached through the
  already-distributed `scripts/biffo.sh` bridge.
- The **checks** live in `biffo-plugin-sdk` as a `biffo_plugin_sdk.conformance` package,
  which every plugin already depends on and version-pins.
- A plugin repo's CI gains **one line**: `run: sh scripts/biffo.sh plugin verify`.
- Checks are **discovered, not registered** — the same shape as `pg_test_modules()`
  globbing `test_*_pg.py`. This is also why the milestones below can add checks without
  every one of them editing a single shared registry file.

`_skeletons/plugin-template/` still changes — it gains that one CI line and an ingress on
its example plugin — but it distributes an invocation, not an implementation.

## Cross-repo boundary — computed, not inferred

Longest-prefix over `core-manifest.json`:

| Path | Owner |
|---|---|
| `packages/python-sdk/**` | `templateOwned` (`packages/`) |
| `services/_plugin-host/**` | `templateOwned` (`services/_plugin-host/`) |
| `_skeletons/plugin-template/**` | `templateOwned` (`_skeletons/`) |
| `modules/cloud/aws/cdn/**` | `templateOwned` (`modules/`) |
| `.github/workflows/**` | `templateOwned` (`.github/`) |
| `scripts/**` | `templateOwned` (`scripts/`) |
| `cli/**` | **not in the manifest** — instances do not carry `cli/` at all (see `scripts/biffo.sh`'s header); it is template-only, published as `@biffo/cli` |

Every implementation milestone therefore lands in **`keiranholloway/biffo-template`**.
The adoption milestones land in the three plugin repos, which own their own
`.github/workflows/ci.yml`. There is no sibling/product split to decide here: no milestone
in this plan has a plausible home in a second product repo.

## Milestones

Nine issues: 1 epic + 5 in `biffo-template` + 3 cross-repo adoption issues.

| # | Repo | Milestone | Read-set | Depends on |
|---|---|---|---|---|
| M1 | biffo-template | Publish `biffo-plugin-host` to PyPI | `services/_plugin-host/`, `.github/workflows/publish-plugin-host.yml` | — |
| M2 | biffo-template | `biffo plugin verify` spine + the real host-mount check | `cli/src/commands/plugin*.ts`, `cli/src/lib/plugin-verify/`, `packages/python-sdk/src/biffo_plugin_sdk/conformance/` | M1 |
| M3 | biffo-template | Migration transitions against real Postgres; #1511 as a permanent fixture | `services/api/src/api/migrations/`, `services/api/scripts/`, `services/api/tests/`, `packages/python-sdk/src/biffo_plugin_sdk/conformance/` | M2 |
| M4 | biffo-template | The CDN path contract as one generated document | `modules/cloud/aws/cdn/`, `cli/src/lib/cdn-*` | — |
| M5 | biffo-template | Skeleton adoption: an ingress on the example plugin, and the one CI line | `_skeletons/plugin-template/` | M2 |
| M6 | biffo-plugin-marketing | Adopt the lane, retire the divergent layout | that repo | M5 |
| M7 | biffo-plugin-ideation | Adopt the lane, retire the divergent layout | that repo | M5 |
| M8 | biffo-plugin-idea-scout | Adopt the lane, retire the divergent layout | that repo | M5 |

**Parallelism.** M1 and M4 are read-disjoint from everything and from each other, and can
start immediately and concurrently. M2 → M3 is **sequential by read-set, not just by
logic**: both write into `packages/python-sdk/src/biffo_plugin_sdk/conformance/`, so
`readset-check` will refuse them concurrently — this is stated rather than glossed. M4
co-tenants `cli/src/lib/` with M2, so run it *before* M2 or after it, not alongside.
M3 ∥ M5 is safe. M6/M7/M8 are safe with each other.

---

### M1 — Publish `biffo-plugin-host` to PyPI

**Why first.** Item 2 asks for "the *actual* `services/_plugin-host` discovery/mount code".
A plugin repo cannot install that code today (PyPI 404), so without this every plugin-side
host assertion is a re-implementation — the mock the harness is replacing.

**Scope.** `.github/workflows/publish-plugin-host.yml`, modelled on `publish-sdk.yml`:
tag-triggered, version-matched against `pyproject.toml`, wheel-contents asserted
(`src/plugin_host` and nothing else — `publish-sdk.yml` already makes this assertion, copy
it), clean-venv install check. Give the package its own independent semver with the same
rationale `packages/python-sdk/pyproject.toml` records, and give `services/_plugin-host/`
a version-policy test mirroring the SDK's `test_packaging.py`.

**Done when:** `pip install biffo-plugin-host==<v>` from PyPI succeeds in a clean venv;
`python -c "from plugin_host.discover import discover_plugins, load_app"` succeeds there;
the published wheel contains no monorepo siblings, repo-root config or tests;
`deploy-app.yml`'s existing vendoring of the same directory still works unchanged (proved
by the deploy workflow's own checks, not by assertion).

**Partial value:** honest and stated — nothing consumes it until M2.

**Budget:** ~80k.

---

### M2 — `biffo plugin verify` spine, and the real host-mount check

**Scope, spine.** `biffo plugin verify` in `cli/`, registered on `pluginCommand`:

- Raises Postgres by shelling to the **existing** `scripts/pg-test-db.sh`
  (already in `cli/package.json`'s `files`); does not write a new one.
- Discovers checks from `biffo_plugin_sdk.conformance` — glob-and-run, no registry file,
  the `pg_test_modules()` shape. **Fails closed on an empty discovery**, with the
  skeleton's own wording: an empty discovery is not a vacuous pass.
- Prints the **denominator before the verdict**, per check
  (`N ingress(es) mounted [...]`, `N route(s) resolved: <list>`).
- Runs the whole set **twice** against the same database and fails the job on a
  second-run failure.
- `--list-checks` prints all five #1523 seams with an implemented/`not-implemented`
  state, so a shrinking denominator is visible rather than silent.
- Local and CI invoke the identical code path — the CI step is
  `sh scripts/biffo.sh plugin verify` and contains no logic of its own.

**Scope, first check.** `biffo_plugin_sdk.conformance.host_mount`: loads the repo's real
`biffo.plugin.json` through `PluginManifest`, calls the real
`plugin_host.discover.discover_plugins` and `load_app` (from M1's package) against the
repo's own installed code, and asserts every declared `module:attr` imports and every
declared route resolves on the mounted app.

**Done when:** in `biffo-plugin-marketing`, `sh scripts/biffo.sh plugin verify` prints
`verify: 2 ingress(es) mounted [user_ingress→…, admin_ingress→…]; 14 declared route(s)
resolved: <list>` and exits 0; changing `user_ingress.app` to a non-existent attribute
exits non-zero **naming the ref**; a second consecutive run is green; `--list-checks`
prints `1 implemented, 4 not-implemented`.

**Budget:** ~80k.

---

### M3 — Migration transitions against real Postgres, with #1511 as a permanent fixture

**The decision this milestone must make first, with a stated default.**
`plugin_migrations.py` imports `..models.plugin_table`, so the generator cannot be called
from a plugin repo. **Default: extract `sync_plugin_migrations` and the `plugin_table`
model into `biffo_plugin_sdk`, and have `services/api` import them from there** — one
implementation, reachable from both an instance and a plugin repo. The alternative
(`verify` fetching a pinned Core checkout) is rejected in advance for the same reason
#1109 gives: it creates a second copy of the generator's environment to keep in lockstep.
If the extraction proves larger than one dispatch, split it and say so on the issue rather
than shelling out to an instance path.

**Scope.** `biffo_plugin_sdk.conformance.migrations`, run against the harness Postgres:

1. **Fresh install.** Generate and apply the plugin's migration on an empty database;
   assert every manifest-declared table and index exists, with `tenant_id` present.
2. **Upgrade onto an existing installation.** Add a column to the manifest, regenerate,
   and assert the new revision's `upgrade()` contains **only the delta** and its
   `downgrade()` inverts **only** it — #1511's exact case.
3. **Data survival.** Apply (2) onto the database from (1) with rows in it; assert the
   rows survive and the downgrade does not drop a table it did not create.

**Done when:** the three assertions run under `biffo plugin verify` against a real
Postgres, print `applied N table(s) / N index(es)` as their denominator, and **reverting
PR #1513 turns exactly assertion (2) red with no other change** — demonstrated in the PR,
fail-first, per `biffo-verify`.

**Budget:** 250k — schema work, and it moves an 875-line Core-coupled module.

---

### M4 — The CDN path contract as one generated document

**Why.** #1503's three-repo seam (CloudFront behaviour ↔ API Gateway route ↔ handler) was
resolved by adding a second CloudFront Function. The behaviours in `main.tf` and the
rewrites in `rewrite.js`/`click-rewrite.js` are today three separate authorities that
happen to agree; nothing makes them agree. This is the recorded #1362/#1364 remedy: **make
guard and authority read the same artifact.**

**Scope.** A literal contract file in `modules/cloud/aws/cdn/` — public path pattern →
rewritten origin path → origin → whether a token is required. `main.tf` generates its
CloudFront Function code and its `ordered_cache_behavior` path patterns *from* it
(`templatefile`, not `file`), and the existing `cli/src/lib/cdn-rewrite-function.test.ts`
and `cdn-click-rewrite-function.test.ts` execute the generated handler against the same
document. A guard fails closed if a behaviour exists in `main.tf` with no contract row, or
a contract row with no behaviour — printing both counts.

**Done when:** adding a `path_pattern` to `main.tf` without a contract row fails CI naming
the pattern; the two existing function tests read the contract rather than hard-coded
expectations and still pass; `terraform plan` on `modules/cloud/aws/cdn` is a **no-op**
against the current deployed shape (this milestone changes where the values come from, not
what they are).

**Named gap, deliberately not in scope:** asserting *manifest-declared* public routes
against this contract. `RouteDef` has no public flag (see "Blocked items"). Recorded as a
follow-up on the epic; it belongs with Phase 0's manifest schema work.

**Budget:** ~80k.

---

### M5 — Skeleton adoption

**Scope.** `_skeletons/plugin-template/`: give the example plugin a `user_ingress` (and an
`admin_ingress`) so a freshly scaffolded repo carries a real fixture for the host-mount
seam from birth; add the one CI line `run: sh scripts/biffo.sh plugin verify` to
`ci.yml`; extend the existing `Guard self-test wiring` step so the verify lane itself
cannot end up with zero callers (#1413).

**Done when:** `biffo plugin create` produces a repo whose first CI run includes a green
`plugin verify` job printing a non-zero denominator; deleting the verify line from the
generated `ci.yml` makes the zero-caller check fail.

**Budget:** ~80k.

---

### M6 / M7 / M8 — The three plugin repos adopt the lane

One issue each in `keiranholloway/biffo-plugin-marketing`,
`keiranholloway/biffo-plugin-ideation`, `keiranholloway/biffo-plugin-idea-scout`. Each:
bumps its `biffo-plugin-sdk` pin to the version carrying `conformance`, adds the single
`plugin verify` CI step, and **deletes whatever local check that step now subsumes**, so
the divergent layouts genuinely converge rather than accumulate.

**Done when:** that repo's CI shows a green `plugin verify` job printing its real
denominator (marketing: 2 ingresses / 6 tables; ideation and idea-scout: whatever their
manifests actually declare), and the repo's workflow list no longer carries a bespoke
equivalent.

Filed through `sh ~/.claude/fleet/fleet.sh file-cross-repo-blocker`, each carrying
`Part of keiranholloway/biffo-template#1523`.

**Budget:** ~80k each.

## Testing plan

- **Fail-first is mandatory on M3 and M4.** M3 must show assertion (2) red with PR #1513
  reverted; M4 must show the guard red with a contract row deleted. A harness whose
  failing case has never been observed is the class this epic is about.
- Every check prints its denominator; a check that can produce a zero denominator must
  fail rather than pass (#1363).
- The whole set runs twice per invocation; re-runability is a property of the harness, not
  a convention.
- M1's publish path is verified by a **clean-venv install from PyPI**, not by a green
  build job — the deployed-artifact rule.

## Rollout

M1 ∥ M4 → M2 → M3 ∥ M5 → M6 ∥ M7 ∥ M8. No deploy, no Terraform apply, and no user-visible
change at any point: M4 is explicitly a `terraform plan` no-op.

## Deferred, with the gate named

| #1523 item | Gate | Filed? |
|---|---|---|
| 3 — real Core in the harness | Spike #1522 (OPEN, zero comments, `fleet:hold`) must report first | **No.** Plan it when the spike reports. |
| 4 — config resolution end-to-end | Phase 0 / #1517 must land a `config:` block on `PluginManifest`; today there is none | **No.** Plan it when #1517 lands. |
| 5 — manifest-declared public routes | `RouteDef` needs a public/unauthenticated flag; belongs with Phase 0's manifest work | **No.** Recorded as a named gap on M4. |

#1523 stays open until all five land; this plan closes three of them.
