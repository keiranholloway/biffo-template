# Development practices — what's working, what isn't, and where the work lands

A running tally, kept the same way `agentic-workers.md` is kept: **evidence, not
opinion**. Every row points at a real issue, PR or command output. If a claim
here cannot be traced to one of those, it does not belong on the page.

Three questions it exists to answer:

1. **What keeps breaking, and in what shape?** — the scoreboard below.
2. **Where does the work actually land?** — which repo pays for a bug, which is
   rarely the repo it was reported against.
3. **Which of our practices earned their keep?** — so we keep doing those, and
   stop doing the ones that produced false confidence.

Add to it whenever a defect costs real time. The value is in the pattern across
rows, so a thin row today beats a thorough one nobody writes.

---

## Scoreboard — failure conditions

`Class` is the shape of the failure, and is the most useful column: the same
shape recurring across unrelated components is a design problem, not bad luck.

| Class | Meaning |
| --- | --- |
| **fail-open** | A gate passes when it *cannot run*, so "green" and "checked" are not the same thing |
| **boundary** | Two components claim the same path/resource; whichever binds first silently wins |
| **drift** | Two implementations of one concept diverge, and a fix lands on only one |
| **visibility** | The truth is not observable — masked errors, absent logs, unretained evidence |
| **process** | Workflow friction that costs time without teaching anything |

| # | Failure condition | Class | Surfaced in | Fix lands in | Status |
| --- | --- | --- | --- | --- | --- |
| — | A drift guard written to catch skeleton regressions **walked up a fixed number of directories** to find `_skeletons/`, overshot to `/home`, and its audit returned `[]` for a path that does not exist. Reintroducing the exact `runs-on: ubuntu-latest` drift it existed to catch did **not** fail it — 11 tests green against nothing | **fail-open** | biffo-template [#744](https://github.com/keiranholloway/biffo-template/pull/744) | biffo-template `cli/` | **fixed** — searches upward, throws when not found, asserts the tree exists before auditing |
| — | Three defects "found" in one session by **pattern-matching without running the thing**, all wrong: four bare `httpx.AsyncClient()` reported as affected when two pass a per-request timeout; a `Depends()` default called a B008 defect when ruff special-cases FastAPI route handlers; a skeleton's differing ruff `select` called drift when the difference is correct in both directions | **process** | biffo-template (this session) | diagnostic practice | **corrected before shipping** — each was disproved by executing the code rather than reading it |
| [#714](https://github.com/keiranholloway/biffo-template/issues/714) | `gh pr merge --auto` against a repo with `allow_auto_merge` **disabled does not queue — it merges immediately**. On a protected branch that is harmless; on an unprotected one it merges with checks still running. Every Biffo repo had it `false` until it was set by hand, so the documented flow silently meant its opposite | **boundary** · visibility | biffo-plugin-ideation#54 | biffo-template `cli/` | **fixed** ([#741](https://github.com/keiranholloway/biffo-template/pull/741)) — set at repo creation |
| — | Auto-merge **does not update a head branch that falls behind** under `strict` protection. Armed, green, one commit behind, it simply waits — three PRs in one session merged only after a manual `gh pr update-branch` plus a full CI re-run | **process** | biffo-platform#84, biffo-template #742/#720 | biffo-template (merge queue, or relax `strict`) | **open** — pre-registered as H1's likely refutation, recorded before the review date |
| [#749](https://github.com/keiranholloway/biffo-template/issues/749) | The workflow builder's **"Test workflow" gate omits the write-back contract entirely** — `start_dry_run` builds its own snapshot from four keys, so `apply_writeback_output_tool` never fires and the model is never given the generated submit tool. It answers in prose, and the builder renders that run-metadata envelope under a heading reading **"Would write"**. A passing test is what *unlocks* enabling the workflow, so the one gate an author sees before going live proves nothing about the only thing that could silently write nothing | **fail-open** · visibility | tabsii-platform (dev, authoring a real write-back) | biffo-template `services/api/` + `apps/portal/` | **open** — filed with the reproduction; `cost 25m` to find, and it made M4 unverifiable by any route except a real stage move |
| — | A frontend PR pointed two call sites at a **new core route the sibling never proxied**. The CRM never calls core directly (ADR-0002/ADR-0007), so every stage move returned `{"detail":"Not Found"}` on dev while both repos' suites stayed green — the component tests mock the api client, so they assert the URL *asked for* and cannot assert that anything answers | **boundary** | tabsii-crm [#113](https://github.com/tabsii-com/tabsii-crm/pull/113) | tabsii-crm [#114](https://github.com/tabsii-com/tabsii-crm/pull/114) | **fixed** — `cost 20m`; the follow-up test pins the forwarded core path too, because proxying a domain route to the generic CRUD address would return 200 and emit the *wrong event*, which nothing would report |
| — | A shared test fixture **added its target to the registry instead of replacing it**, and cleared the whole registry on teardown. Every assertion naming the catalog's contents exactly (`== ["leads"]`) therefore held only while the instance registered exactly one target — the day tabsii registered a second, the module failed there while passing upstream. The teardown was the mirror image, discarding the instance's real registrations for every later test in the process | **fail-open** · drift | tabsii-platform (registering a 2nd write-back target) | biffo-template [#766](https://github.com/keiranholloway/biffo-template/pull/766) | **fixed** — `cost 35m` including one blocked instance PR; the isolating pattern was already written eight lines above, with a comment explaining exactly this failure |
| — | Hand-written raw SQL **relied on PostgreSQL's leniency in four separate ways** — untyped UUID binds (matched only because PG coerces `uuid = 'text'`), an untyped `Decimal`, timestamps assumed to return as `datetime`, and an id left to a column default. None was broken in production; all four are "works because of the database underneath", and all four failed the moment the same statements ran on SQLite | **drift** | tabsii-platform [#273](https://github.com/tabsii-com/tabsii-platform/pull/273) | tabsii-platform | **fixed** — `cost 30m`; found only because the tests were written against a real session rather than a fake that answers queries in order |
| [tabsii-platform#282](https://github.com/tabsii-com/tabsii-platform/issues/282) | **A single verified recipient masked a whole class of failure.** SES on dev is sandboxed, so it rejects any recipient that is not a verified identity — and exactly one existed, a hand-verified address. Every email workflow built over five milestones happened to be addressed to *that* mailbox, so all of them passed. The first workflow addressed to `{email}` — the candidate, which is what a welcome email is for — failed with `MessageRejected`. The sending identity the whole comms story depends on existed only as a console action, in no repo | **fail-open** · visibility | tabsii-platform (dev, a user's own workflow) | tabsii-platform [#280](https://github.com/tabsii-com/tabsii-platform/pull/280) + [#281](https://github.com/tabsii-com/tabsii-platform/pull/281) | **partly fixed** — `cost 20m` to diagnose; domain identity, DKIM and bounce/complaint capture now in Terraform, but leaving the sandbox needs an AWS support request and two steps Terraform cannot perform (publish DNS it does not control, click a confirmation link) |
| [#591](https://github.com/keiranholloway/biffo-template/issues/591) | `pnpm audit`/`pip-audit` fail identically whether they found a vulnerability or couldn't parse the registry response — one flake reds every open PR | fail-open · process | biffo-template CI | biffo-template | **closed** ([#592](https://github.com/keiranholloway/biffo-template/pull/592), [#636](https://github.com/keiranholloway/biffo-template/pull/636)) |
| [#644](https://github.com/keiranholloway/biffo-template/issues/644) | Sibling skeleton's lockfile shipped 4 high-severity advisories; it sits outside the pnpm workspace so no CI gate ever audited it | fail-open · visibility | biffo-template `_skeletons/` | biffo-template | **partly fixed** ([#645](https://github.com/keiranholloway/biffo-template/pull/645)) — 1 residual, no patched upstream release |
| [#621](https://github.com/keiranholloway/biffo-template/issues/621) | `is_active` deactivation gate (#150) enforced on the bearer path, silently absent on the forwarded path — a suspended user's token kept working via plugins | **drift** | biffo-template `services/api` | biffo-template | step 1 **merged** ([#655](https://github.com/keiranholloway/biffo-template/pull/655)), step 2 **merged** ([#659](https://github.com/keiranholloway/biffo-template/pull/659)), step 3 open |
| [#647](https://github.com/keiranholloway/biffo-template/issues/647) | CloudFront rewrites API 403/404 to `200` + portal HTML, so every backend failure reads as a JSON parse error in the client | **fail-open** · visibility | biffo-plugin-ideation (admin UI) | biffo-template `modules/cloud/aws/cdn` + biffo-platform | **open** |
| [#652](https://github.com/keiranholloway/biffo-template/issues/652) | ADR-0021's `/api/v1/plugins/{proxy+}` catch-all shadows ADR-0003's manifest-declared `api_routes`; a plugin's call to Core loops back into the plugin host | **boundary** | biffo-plugin-ideation (admin UI) | biffo-template + biffo-platform | **open** |
| — | Auto-merge disabled and `delete_branch_on_merge` off, against a `dev` taking a merge every 3–5 min with a ~2.5 min CI cycle — four rebases lost to the race on one PR | process | biffo-template settings | biffo-template settings | **fixed** (both enabled 2026-07-27) |
| — | Three Cognito client IDs in one origin's `localStorage`; two belong to destroyed pools. AWS has exactly one pool and one client — pure browser residue, but any code picking the "first" match grabs a dead token | drift | dev.biffo.io portal | portal / plugin `web-admin` | **unfiled** — prune non-matching `CognitoIdentityServiceProvider.*` keys |
| — | CI logs not retained for self-hosted runs, so a green check cannot be inspected to confirm *what it actually did* | visibility | biffo-template CI | biffo-template CI | **unfiled** |
| — | `ci.yml` fires on both `push` and `pull_request`, leaving duplicate in-flight runs that make "are all checks done?" unanswerable to tooling | visibility · process | biffo-template CI | biffo-template CI | **unfiled** |
| [#689](https://github.com/keiranholloway/biffo-template/issues/689) | `core diff` reports instance-authored files as `removed` — a false data-loss signal that `core upgrade` does not act on. Halted a deploy, produced an incorrect issue, and prompted a workaround hunt, all for something that would not happen | **visibility** | biffo-platform upgrade | biffo-template `cli/` | **open** |
| — | Two plugin admin URLs both answered `200 text/html`, so they were read as the same failure. They were opposites: one carried `x-cache: Miss` and `<title>Ideation Engine — Admin</title>` (working), the other `server: AmazonS3` + `x-cache: Error` (a 404 the CDN rewrote). The proposed fix would have reverted #635 and broken admin access for every admin | **visibility** | biffo-template [#713](https://github.com/keiranholloway/biffo-template/issues/713) | biffo-plugin-idea-scout (missing `web-admin/dist`) | **corrected** — cost ~25m and one wrong issue |
| — | An admin panel rendered a **500 as "No catalog entries yet."** The screenshot looked like a working feature with no data; only `read_network_requests` showed the status. A UI that renders a failed fetch as an empty collection makes a broken feature indistinguishable from an idle one | **visibility** | biffo-platform (Ideation admin) | biffo-plugin-ideation (surface fetch failures) | **unfiled** |
| — | `scripts/js-dependency-audit.sh` ran under dash, whose `echo` interprets backslash escapes. Advisory payloads contain them, so `echo "$out" \| jq` mangled the JSON and every run reported INCONCLUSIVE — the gate green while scanning nothing, inside the very fix (#591) that exists to stop it failing open | **fail-open** | biffo-template CI | biffo-template `scripts/` | **fixed** ([#717](https://github.com/keiranholloway/biffo-template/pull/717)) |
| — | A cut `core-v*` tag is not an available artifact: the tag existed at 0.136.0 while npm still served 0.135.0. Upgrading in that window carries a *partial* fix that deploys green and still fails | visibility · process | biffo-template release chain | biffo-template CI | **unfiled** — caught before it bit |
| [#671](https://github.com/keiranholloway/biffo-template/issues/671) | `scripts/biffo.sh` execs `npx @biffo/cli@$(biffo.core.json .version)`, so an unpublished core version reds **every guard on every instance**. npm publish has been failing (E404 on PUT) since 0.131.0 — the upgrade PR's own version bump is what breaks its guards, so it can never go green | **boundary** · visibility | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template (npm token + `publish-cli.yml`) | publishing **fixed** ([#669](https://github.com/keiranholloway/biffo-template/pull/669), npm now at 0.133.3); the coupling itself still **open** ([#667](https://github.com/keiranholloway/biffo-template/issues/667)) |
| [#664](https://github.com/keiranholloway/biffo-template/issues/664) | The npm publish credential was issued with a **7-day expiry** and aged out mid-session — 0.130.0 published at 08:47, 0.131.0 failed at 08:50. Nothing warned before, during or after; the pipeline had no notion of its own credential having a lifetime | **visibility** | biffo-template release | biffo-template `publish-cli.yml` | **fixed** — replaced with OIDC trusted publishing, which has no long-lived credential ([#669](https://github.com/keiranholloway/biffo-template/pull/669)) |
| [#664](https://github.com/keiranholloway/biffo-template/issues/664) | npm answers **404 on an unauthorised PUT**, not 403 (deliberately — so it cannot be used to probe whether a private package exists). An auth failure therefore reads as "no such package", and the obvious next move is the wrong one | **visibility** | biffo-template release | biffo-template (failure reporter) | **fixed** — the 404-means-403 trap is now named in the failure summary ([#669](https://github.com/keiranholloway/biffo-template/pull/669)) |
| — | The publish failure reporter said "mint a fresh automation token… re-dispatch if transient". Both halves were wrong, and it said them **confidently** — three re-dispatches were spent on advice that could not work. Misleading diagnostics cost more than absent ones | **visibility** · process | biffo-template release | biffo-template `cli/src/lib/npm-publish.ts` | **fixed** ([#669](https://github.com/keiranholloway/biffo-template/pull/669)) |
| — | npm ignores trusted publishing entirely below **11.5.1**, and Node 22 bundles 10.x — an OIDC setup on an old npm fails *identically* to an expired token. Caught before shipping only by reading the npm docs, not by any signal from the tool | **visibility** | biffo-template release | biffo-template `publish-cli.yml` | **fixed** — npm upgraded in the publish job ([#669](https://github.com/keiranholloway/biffo-template/pull/669)) |
| — | The outage left a **hole in the published range** (0.130.0 → 0.133.3; 0.131.0–0.133.2 never published). An instance upgrade already computed against 0.133.1 was still uncommittable after publishing was fixed, and had to be discarded and recomputed | process | biffo-platform | biffo-template (consequence of #664 + #667) | **worked around** — recompute against a version that exists |
| [#649](https://github.com/keiranholloway/biffo-template/issues/649) | The plugin skeleton ships `gitleaks/gitleaks-action@v2`, which **cannot pass** on this project's self-hosted runners (its SARIF upload assumes a GitHub-hosted `$HOME` layout) and needs a paid licence for org-owned repos. Every generated plugin repo is born with a permanently red check — the scan itself passes, then the action dies uploading | **drift** | biffo-plugin-idea-scout (first push) | biffo-template `_skeletons/plugin-template` | **open** — fixed downstream in [idea-scout#7](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/7), diff is portable |
| [#651](https://github.com/keiranholloway/biffo-template/issues/651) | The plugin skeleton hardcodes `runs-on: ubuntu-latest`, so a generated repo bills GitHub-hosted minutes and fails immediately on an account over its spending limit. Same shape as the known sibling-skeleton issue, hit again on a new repo type | **drift** | biffo-plugin-idea-scout | biffo-template `_skeletons/plugin-template` | **open** |
| [biffo-runners#2](https://github.com/keiranholloway/biffo-runners/issues/2) | A new repo pointed at the runner fleet gets **no runner and no error** until the `biffo-gha-runners` App is granted access to it. The webhook only sees repos the App can see, so jobs queue indefinitely and nothing distinguishes that from a slow runner | **visibility** | biffo-plugin-idea-scout | biffo-runners (docs + fail-fast) | **open** — cost **1h 44m** on one queued job |
| [#650](https://github.com/keiranholloway/biffo-template/issues/650) | The plugin skeleton's ruff config diverges from both the Ideation Engine's and the instance's — `ANN` on where nobody else has it, and **missing** `flake8-bugbear.extend-immutable-calls`, without which `B008` rejects FastAPI's mandatory `Depends()` idiom. Hit **twice in one day** on one plugin, each time needing a local workaround | **drift** | biffo-plugin-idea-scout | biffo-template `_skeletons/plugin-template` | **open** |
| [#657](https://github.com/keiranholloway/biffo-template/issues/657) | The orchestration engine could fan **out** but had no **join**: a `WorkflowDefinition` is one trigger to one action, so N parallel agent completions fired the follow-on N times. And outputs cannot travel a chain — a completion event carries a *reference*, not the result (ADR-0014 §5, correctly) — with no tool to fetch one | **boundary** | biffo-plugin-idea-scout | biffo-template `services/_plugins/orchestrator` | **fixed** ([#662](https://github.com/keiranholloway/biffo-template/pull/662)) |
| [#656](https://github.com/keiranholloway/biffo-template/issues/656) | `AgentRun.causation_id` was written on every chained run but nothing could query it, so nothing could ask "what else is in this chain?" — the question any fan-in must answer | **visibility** | biffo-plugin-idea-scout | biffo-template `services/api` | **fixed** ([#658](https://github.com/keiranholloway/biffo-template/pull/658)) |
| [#661](https://github.com/keiranholloway/biffo-template/issues/661) | Agent-run creation has no idempotency key, so a fan-in racing on simultaneous sibling completions can create the follow-on twice — two invoices for one result. The engine's `dedupe_key` cannot help: it is keyed per *event*, and sibling completions are genuinely different events | **boundary** | biffo-template orchestrator | biffo-template `services/api` | **open** — guarded by a check-then-act, documented as such |
| — | Owner-scoped plugin tables can only be written inside a founder request — the owner comes from the forwarded token, never the body (correct, ADR-0017 §5). There is therefore **no autonomous write path** for a plugin doing background work, which turns "run this unattended" from a plugin question into a platform one | **boundary** | biffo-plugin-idea-scout | biffo-template `services/api` | **unfiled** — worked around by keeping the DB projection on first read |
| [#685](https://github.com/keiranholloway/biffo-template/issues/685) | `biffo plugin install` regenerates `plugins.generated.tf` from an ADR-0018 §1 template — Lambda-backed, `function_arn` output, no `cdn_distribution_arn`. **No current plugin module has that shape**, so the generated block cannot plan. And it regenerates **in full**, so installing one plugin silently reverted `ideation`'s hand-corrected block too | **drift** · boundary | biffo-platform (installing idea-scout) | biffo-template `cli/` | **open** — hand-corrected, will revert on the next install |
| [#688](https://github.com/keiranholloway/biffo-template/issues/688) | Two vendored plugins both define a *regular* package named `scripts`; regular packages do not merge across `sys.path`, so the first shadows the other and the second plugin's install breaks the first's seed-script imports | **boundary** | biffo-platform (installing idea-scout) | biffo-template `_skeletons/` | **open** — worked around per-plugin (path loading) |
| [#688](https://github.com/keiranholloway/biffo-template/issues/688) | Plugin `tests/` carry no `__init__.py`, so pytest imports every module by bare basename. `test_manifest.py`, `test_app.py`, `test_service.py` are names *any* plugin picks — six collided at collection. `--import-mode=importlib` fixes it and breaks 10 other modules that rely on prepend | **boundary** · drift | biffo-platform (installing idea-scout) | biffo-template `_skeletons/` | **open** — worked around by prefixing every test file |
| — | The plugin **skeleton's** `terraform/` provisions an ADR-0018 §1 Lambda + EventBridge + ingress, obsolete under ADR-0021. Unlike the two above it fails *silently*: it applies successfully and leaves a Lambda nothing ever invokes | **drift** | biffo-plugin-idea-scout | biffo-template `_skeletons/plugin-template` | **fixed downstream** ([idea-scout#15](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/15)); skeleton **open** |
| — | The plugin skeleton's `ci.yml` asserts "a plugin repo has no JS/TS". False for any user-facing plugin (ADR-0017/0021) — so nothing checked the frontend's lint, types, tests or whether it built, and `web/dist` is what `user_frontend` ships | **drift** · fail-open | biffo-plugin-idea-scout | biffo-template `_skeletons/plugin-template` | **fixed downstream** ([idea-scout#14](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/14)); skeleton **open** |
| [#670](https://github.com/keiranholloway/biffo-template/issues/670) | Core migration 0010 does `batch_alter_table("users")`, assuming a Core-owned `public.users` in the instance's Alembic chain. tabsii's users are DDL-imported as `tabsii.users`, so the migration raises `NoSuchTableError` and takes 4 smoke tests with it | **drift** | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template `migrations/` | **fixed** ([#734](https://github.com/keiranholloway/biffo-template/pull/734)) — and it had **recurred**: the 0.140.1→0.146.2 upgrade re-proposed 0010 and generated a chain that died on the same line. Declining it in tabsii ([#244](https://github.com/tabsii-com/tabsii-platform/issues/244)) did not make it go away |
| [#668](https://github.com/keiranholloway/biffo-template/issues/668) | ADR-0022 discovery runs *after* `build_core_crud_router()`, and importing a domain is what registers its models — so relocating a domain silently drops every `/api/v1/data/` route its models back. **21 routes vanished in tabsii with the full suite green (1712 passed)**; no test builds the app the way `main.py` does, so none could have failed | **visibility** · boundary | tabsii-platform [#243](https://github.com/tabsii-com/tabsii-platform/pull/243) | biffo-template `main.py` + `routing/domain_router.py` | **open** — instance reordered locally as a stopgap |
| [tabsii#249](https://github.com/tabsii-com/tabsii-platform/issues/249) | Write-back scoped its update by ADR-0001's seam string `"default"`, but an ADR-0005 DDL-imported table keys tenancy on a real `UUID`. The bind error was caught and recorded as *"the database refused the write for the workflow's owner"* — **indistinguishable from RLS correctly refusing a revoked author**, so the one failure the feature exists to expose was being counterfeited | **drift** · visibility | tabsii-platform dev E2E | biffo-template [#686](https://github.com/keiranholloway/biffo-template/pull/686) + tabsii [#251](https://github.com/tabsii-com/tabsii-platform/pull/251) | **fixed** |
| [#690](https://github.com/keiranholloway/biffo-template/pull/690) | The audit row is written in the **same transaction** as the business write, and carries the written row's id in a JSON column. An instance's id is a `UUID`, which asyncpg cannot serialise — so recording a successful write **rolled that write back**. The traceback shows `status: 'succeeded'` on the insert that destroyed it | **fail-open** · visibility | tabsii-platform dev E2E | biffo-template `writeback.py` | **open** |
| — | Three consecutive write-back defects were the same assumption: template code treats ids/tenants as Core's `String(36)`, instances use real `UUID`s. SQLite has no UUID type and asyncpg coerces silently, so **neither the template suite nor a PostgreSQL happy path can see it** | **drift** | tabsii-platform dev E2E | biffo-template | **unfiled** — pattern, not a single bug |
| — | `build_core_crud_router()` returns **zero** routes when called a second time (the first call consumes the registry). A guard test written for #668 compared the assembled app against a freshly-rebuilt router, so its expected set was empty and it passed against the exact bug it guarded | **fail-open** | tabsii-platform [#246](https://github.com/tabsii-com/tabsii-platform/pull/246) | biffo-template (make idempotent or document); instance test hardened to a golden list | **unfiled** |
| [tabsii#252](https://github.com/tabsii-com/tabsii-platform/issues/252) | Two events ship with no `fields` and no `payload_model` while emitting a real payload, so the workflow builder's dropdowns are empty. The guard credited with preventing this (#546) does not iterate `registered_events()` at all — no test asserts field-metadata *coverage*, here or in the template | **fail-open** · drift | tabsii-platform (found closing #221) | biffo-template `services/api/tests` | **open** |
| — | Five template-owned files diverged **undeclared** across a whole core upgrade. The instance's tests checked each declaration was valid but never that the declared set and `core diff`'s modified set *agree*, so undeclared divergence was invisible governance — the guard hard-blocked those files with no recorded reason | **visibility** | tabsii-platform [#250](https://github.com/tabsii-com/tabsii-platform/pull/250) | tabsii-platform (ratchet added); biffo-template could emit the delta from `core diff` | **fixed** in the instance |
| — | `biffo core diff` emits human-prose only. Consumers hand-parse it, and a parse that silently drops a line under-reports divergence — one did exactly that here, reporting 4 undeclared files when the answer was 5, caught only because the section header's own count disagreed | **visibility** | tabsii-platform revalidation | biffo-template `cli` (a `--json` mode) | **unfiled** |
| — | `tabsii-platform` has `allow_auto_merge=false` and `delete_branch_on_merge=false` — the settings fixed on `biffo-template` and `biffo-platform` on 2026-07-27 were never applied to the third repo, so every PR there is merged by hand and every branch reaped by hand | **process** | tabsii-platform | tabsii-platform settings | **fixed** 2026-07-27 — `allow_auto_merge` and `delete_branch_on_merge` both enabled; all three repos now match |
| [tabsii#256](https://github.com/tabsii-com/tabsii-platform/issues/256) | The ownership guard blocks edits to *instance-authored* files under a template-owned prefix (e.g. `identity/tabsii.py`), but `core diff` classifies those as `removed`, not `modified` — so the instance's own divergence ratchet rejects a declaration for them. Governance actively prevents the record it exists to encourage; the only route through is a per-commit trailer | **boundary** | tabsii-platform [#253](https://github.com/tabsii-com/tabsii-platform/pull/253) | tabsii-platform ratchet; `core diff` bucket semantics ([#689](https://github.com/keiranholloway/biffo-template/issues/689), [#696](https://github.com/keiranholloway/biffo-template/issues/696)) | **open** |
| [#697](https://github.com/keiranholloway/biffo-template/issues/697) | Two open issues described one npm outage ([#664](https://github.com/keiranholloway/biffo-template/issues/664), [#671](https://github.com/keiranholloway/biffo-template/issues/671)), filed independently days apart. Nothing prompts a search before filing, and the duplicate was found only when listing open issues for an unrelated reason — after one had already been closed on its own | **process** · visibility | biffo-template issue tracker | practice, not code | **closed** — both closed, residue split to #697 |
| [#666](https://github.com/keiranholloway/biffo-template/pull/666) | Template tests asserted **ambient process state** — an empty write-back registry, and whichever identity provider happened to be installed. Both are properties only a bare template has, so 14 tests were green upstream and red the moment they were distributed | **drift** · fail-open | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template `services/api/tests` | **fixed** ([#666](https://github.com/keiranholloway/biffo-template/pull/666)) |
| — | [#665](https://github.com/keiranholloway/biffo-template/pull/665) was written, reviewed, merged and **wrong** — it pinned the *default* identity provider, which reads `public.users`, a table the instance also lacks. It was never run against the instance it existed to unblock; [#666](https://github.com/keiranholloway/biffo-template/pull/666) corrects it | **process** | biffo-template | biffo-template | **fixed** — verify a distribution fix *against the distribution* |
| — | A deployed frontend fix verified as **still broken** — the page requested the old URL and failed. The bundle on the Lambda was correct; the *browser* had cached the previous one. A cache-busting reload showed it working. A stale client produces a perfect false negative: the deploy is fine and the evidence says otherwise | **visibility** | biffo-platform (ideation admin) | verification practice | **unfiled** — check *which URL the page requested*, not just that you reloaded |
| — | ADR-0003's manifest-declared `api_routes` had **never once worked in a deployed instance**, and #684's forwarder had never been exercised either — every gateway log entry for the route predated the deploy that shipped it. Closing #652 took changes in **four repos** and was only provable by an authenticated click-through | **boundary** · visibility | biffo-template [#652](https://github.com/keiranholloway/biffo-template/issues/652) | biffo-template + ideation + biffo-platform | **fixed** — verified live 2026-07-27 |
| — | `gh` was **2.46.0 from Ubuntu universe — 7 months and ~50 minor versions stale**. `gh issue view <n>` failed outright on a deprecated Projects-classic GraphQL field, and `gh pr update-branch` **printed its help text and exited 0** instead of running. Both were worked around as quirks across two sessions; neither prompted anyone to check the version. Nothing in either failure said "your tool is old" | **visibility** | agents working in every Biffo repo | workstation tooling (GitHub's apt repo, not Ubuntu's) | **fixed** — 2.96.0, auto-updating |
| [#715](https://github.com/keiranholloway/biffo-template/issues/715) | Scaffolding **skips branch protection entirely on a 403** (GitHub's answer for a private org repo below Team plan), logs one warning, and reports success. Nothing re-attempts and nothing audits, so a repo scaffolded during a 403 window stays unprotected after the plan is upgraded — three tabsii repos for three weeks, the **live core platform** among them, with 8 PRs merged into an ungated default branch in one session | **fail-open** · visibility | tabsii-platform [#261](https://github.com/tabsii-com/tabsii-platform/issues/261) | biffo-template `cli` (guard shipped, [#718](https://github.com/keiranholloway/biffo-template/pull/718)); repo settings | **fixed** — all 8 repos protected, `biffo check branch-protection` added |
| — | `gh pr merge --auto` refuses with *"Pull request is in clean status"*, and `gh pr checks` reports *"no checks reported"*, when runs have not yet **registered** — not when they passed. Both readings are indistinguishable from the real thing, and they mislead in opposite directions: one invites merging unverified code, the other looks like the genuine "GitHub created no run" case AGENTS.md §6 says never to paper over | **visibility** | tabsii-platform [#260](https://github.com/tabsii-com/tabsii-platform/pull/260) | practice / tooling wrapper | **unfiled** |
| [tabsii-intake#10](https://github.com/tabsii-com/tabsii-intake/issues/10) | CI had **not run on `dev` for three weeks**. A merge on 2026-07-22 produced a Deploy run and no CI run; triggers were correct, GitHub simply created none. `dev` shipped with no CI evidence and carried unpatched advisories nobody could see. The repo also had no `workflow_dispatch`, so there was no way to re-trigger CI on a protected branch without pushing | **visibility** | tabsii-intake | tabsii-intake (CI adopted from skeleton, adds `workflow_dispatch`) | **fixed** |
| [tabsii-marketplace#9](https://github.com/tabsii-com/tabsii-marketplace/issues/9) | A repo's **production build is broken and its CI is green, consistently** — `pnpm run build` dies on `Both UserPoolId and ClientId are required` (a Cognito pool built at module scope, evaluated during prerender), but marketplace's `js` job runs only lint/typecheck/test/audit. The skeleton's `js` job also **builds without credentials**, precisely to catch this ([#286](https://github.com/keiranholloway/biffo-template/issues/286)) | **fail-open** · visibility | tabsii-marketplace [#8](https://github.com/tabsii-com/tabsii-marketplace/pull/8) | tabsii-marketplace (lazy pool construction, then adopt the skeleton CI) | **open** |
| — | **CI generations drift by *step*, while job *names* stay identical.** marketplace has all four current consolidated job names and looks migrated; its `js` job is missing the Build step added later. Nothing compares a repo's workflow against the skeleton, so "are we on the current CI?" is answered by a name match that can be true while the content is a generation behind | **drift** · visibility | tabsii-marketplace | biffo-template (a workflow-drift check) | **unfiled** |
| — | **Nothing tracks when CI last ran on `dev`.** Two sibling repos were found independently, hours apart, each with no CI run for three weeks — intake (2026-07-06) and marketplace (2026-07-06). In both the branch was green-by-absence: no failing run, because no run. A "last successful CI on the default branch" age is not surfaced anywhere | **visibility** | tabsii-intake, tabsii-marketplace | biffo-template (`biffo check`, or a scheduled sweep) | **unfiled** |
| [#722](https://github.com/keiranholloway/biffo-template/issues/722) | An issue was filed on a **wrong premise** and proposed a fix that would have been dead config: it claimed pip-audit "reds every sibling" on an unfixable `ecdsa` advisory and asked the *skeleton* to carry a CVE suppression. The skeleton already declares `pyjwt[crypto]`, so a new sibling never sees it; only two legacy siblings did. Nothing checks an issue's claims before someone implements them | **drift** · process | biffo-template | tabsii-intake / tabsii-marketplace (drop `python-jose`) | **corrected** — intake done ([#11](https://github.com/tabsii-com/tabsii-intake/pull/11)), marketplace outstanding |
| [#714](https://github.com/keiranholloway/biffo-template/issues/714) | Plugin repos are born with **no branch protection on `dev` at all** (`404 Branch not protected`), while their own AGENTS.md states "branch protection stays on". A PR was squash-merged with both CI jobs still in progress; nothing could have stopped it | **fail-open** · process | biffo-plugin-ideation [#54](https://github.com/keiranholloway/biffo-plugin-ideation/pull/54) | biffo-template `_skeletons/` + repo settings | **partly fixed** — both repos protected by hand; skeleton still produces unprotected repos |
| — | Merging a plugin repo changes **nothing** on the deployed site: `dev.biffo.io` serves `services/<plugin>/` vendored inside the instance. The plugin's own `deploy-frontend.yml` is `workflow_call`/`dispatch` only and never fires on merge. Nothing warns that the two have diverged | **drift** · visibility | biffo-plugin-ideation [#54](https://github.com/keiranholloway/biffo-plugin-ideation/pull/54) | biffo-platform resync PRs; no drift check exists | **worked around** — 3 resync PRs this session |
| [idea-scout#18](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/18) | A **second instance of [#652](https://github.com/keiranholloway/biffo-template/issues/652)**: the adapter read build types from `/api/v1/plugins/idea-scout/build-types`, which API Gateway routes to the plugin host, not Core. The host's gate reads `Authorization`/`X-Biffo-Founder-Token`; the transport forwards `X-Biffo-User-Token`. Every `start_run` 401'd, so no scout run could ever be created | **boundary** · drift | biffo-plugin-idea-scout (first live click-through) | biffo-plugin-idea-scout — use Core's `/api/v1/internal` mount | **fixed** ([#18](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/18)) |
| [idea-scout#19](https://github.com/keiranholloway/biffo-plugin-idea-scout/issues/19) | A **declared-but-unconfigured tool is dropped with a warning and the run proceeds**. `web_search` is gated on a Brave credential dev does not have, so three research agents each told the model to use a tool it had not been given, returned nothing, and synthesis failed — after four paid model calls (~$0.07) | **fail-open** · visibility | biffo-plugin-idea-scout | biffo-plugin-idea-scout [#21](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/21) (`:online`); preflight proposed in [#729](https://github.com/keiranholloway/biffo-template/issues/729) | **fixed** — research now returns real sourced findings |
| [#729](https://github.com/keiranholloway/biffo-template/issues/729) | `agent_fan_in` could start an agent but **not tell it how to answer** — no `output_tools` config field, so an agent instructed to "call `submit_x` exactly once, do not answer in prose" was offered no such tool and could not comply. Declaring the field is also what makes it *survive*: the portal's save path keeps only declared fields, so a hand-seeded value was dropped on the next edit | **boundary** · drift | biffo-plugin-idea-scout [#19](https://github.com/keiranholloway/biffo-plugin-idea-scout/issues/19) | biffo-template [#731](https://github.com/keiranholloway/biffo-template/pull/731) | **fixed** ([#731](https://github.com/keiranholloway/biffo-template/pull/731)) |
| — | The workflow builder's **non-agent** branch rendered every config field generically, with no structured-type exclusion — so `agent_fan_in`'s `delivery` and `writeback` were already drawn as plain text inputs. Typing in one stores a *string* where Core expects an object; the file's own comment warns about exactly this, for the agent branch only | **drift** | biffo-template `apps/portal` | biffo-template [#731](https://github.com/keiranholloway/biffo-template/pull/731) | **fixed** — exclusion applied to both branches |
| [platform#85](https://github.com/keiranholloway/biffo-platform/issues/85) | SQLAlchemy engine echo is on in dev and logs **bound parameters**, so complete agent transcripts, prompts, run results and `owner_sub` values sit in CloudWatch in clear text — readable by anyone with `logs:FilterLogEvents`, a far wider grant than RDS. Core correctly fail-closes the equivalent internal API route, then the same data is readable from logs | **visibility** | biffo-platform dev (diagnosing idea-scout#19) | biffo-platform config | **open** |
| — | **The practices page silently lost a session's contribution to a concurrent merge.** A branch created before another session's PR merged rewrote `development-practices.md` **wholesale** rather than patching it, and squash-merged an hour later: 215 insertions against 322 deletions. No conflict, because a full-file replacement from a stale base merges cleanly. **18 scoreboard rows and 23 narrative entries from three different sessions were deleted**, including the day's headline finding. The commits are in history; the content is not | **process** · visibility | biffo-template `docs/` | append-only editing + a rebase before writing; the loss is invisible without diffing an old commit | **restored** — rows and entries merged back; the two mechanisms are separately recorded |
| — | **`--extract` treats the markdown as the source of truth and deleted every stored row absent from it.** `mergeExtracted` returned `fresh.map(...)`, so running it from a stale checkout rewrote `evidence.jsonl` without the other session's rows. This is the mechanism that propagates the loss above into the dataset — so the advice to *regenerate counts from the data rather than trust prose* carried the deletion with it. The destructive path had three unit tests around it and none covering it | **fail-open** · drift | biffo-template `scripts/practices-evidence.mjs` | biffo-template — orphaned rows are now kept and reported | **fixed** — plus two tests that fail against the old implementation |
| — | **Relaxing `strict` removes the guard against exactly this.** H3 turned `strict` off on `biffo-template` on 2026-07-28 to end the rebase race. A side effect nobody costed: a branch no longer has to be up to date before merging, so a stale whole-file rewrite is now *more* likely to land silently. The experiment's falsification criteria measure merge friction and say nothing about content loss | **process** | biffo-template branch protection | H3 review 2026-08-11 — add content loss to what the experiment watches | **open** |
| — | **A plugin shipped with another plugin's stylesheet.** `biffo-plugin-idea-scout`'s `index.css` was the Ideation Engine's file copied verbatim at scaffold time: every rule keyed on `.ide-*` while the components emit `.candidate`/`.scorecard`/`.run-form`. **0 of 35 class names matched.** 57 rules loaded and styled nothing but bare `button`/`input`, so the app rendered as one run-on line of browser defaults — `.layout` computed to `display: block`, the sidebar was full-bleed at 1920px, rationales ran ~234 characters per line. Every test passed, the build was clean, the CSS returned 200; the only symptom was visual | **drift** · visibility | biffo-plugin-idea-scout | biffo-plugin-idea-scout [#24](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/24) — real stylesheet + a class-coverage guard | **fixed** |
| — | **There was no shared design system, and the canonical tokens lived in the most downstream repo.** The token set existed only in `biffo-platform-app`'s `globals.css` — a sibling app — while the template's own `apps/portal/globals.css` is three lines of Tailwind declaring nothing. Every other surface re-declared or invented its own, so three brand blues were reachable in one page through same-origin iframes | **drift** | biffo-platform-app / plugin frontends | biffo-template [#753](https://github.com/keiranholloway/biffo-template/pull/753) — `@biffo/design-tokens` published to npm | **fixed** — consumers not yet adopted |
| — | **OIDC trusted publishing cannot bootstrap a new package.** Trust registers *against an existing package*, and the package does not exist until its first publish — so the first release of `@biffo/design-tokens` had no credential path at all. `NPM_TOKEN` returned 404, and OIDC returned the same 404 even with npm upgraded to 12.0.1 (well past the 11.5.1 threshold). npm answers 404 rather than 403 for unauthorised writes, so all three causes looked identical | **process** · visibility | biffo-template publishing | one manual publish, then register the trusted publisher | **partly fixed** — package published; trusted publisher **still unregistered**, so the next tag's publish will 404 |
| — | **`biffo:ddl-import` skips applied files by filename, so amending a seeded row by editing its `.sql` does nothing.** The workflow seed for Idea Scout's synthesis agent needed a *new* file (`005_…`) to add `output_tools`; editing `003_…` would have been a silent no-op everywhere it had already run | **visibility** | biffo-platform `db/imports/` | practice, not code — documented in the new file's header | **worked around** |
| — | **A release workflow's trigger was decorative, and the symptom was silence.** `publish-design-tokens.yml` declared `on: push: tags: ['core-v*']`, which can never fire: `core-tag.yml` pushes those tags with the job's `GITHUB_TOKEN`, and GitHub suppresses events created by it to stop workflows recursing. That gap was already known — the CLI dispatch exists *because of it* — but the dispatch named `publish-cli.yml` and nothing else, so the next release workflow inherited the original bug. **Three tags (0.153.0/.1/.2) cut with zero runs**; npm kept serving the hand-published 0.152.0. The tell was in plain sight and read past: every `Publish CLI` run is `event: workflow_dispatch`, never `push` | **fail-open** · visibility | biffo-template `.github/workflows/` | biffo-template — the dispatch step now loops over the release list, and `release-dispatch.test.ts` derives the expectation from the workflow directory rather than a hardcoded name | **fixed** — verified by the next tag publishing `0.154.1` unattended |

| — | `tabsii-intake`'s `dev`/`staging`/`main` required **11 status-check contexts**; the consolidated CI workflow it adopted produces **4**. Nine contexts could never report again, so a green PR sat permanently `BLOCKED`. Renaming a CI job and repointing branch protection are one change that nothing couples | **boundary** · process | tabsii-intake [#9](https://github.com/tabsii-com/tabsii-intake/pull/9) | tabsii-intake settings + biffo-template (`biffo check branch-protection` cannot see this class) | protection **repointed** on all three branches; the *detection* gap **unfiled** |
| — | Migrating a **live sibling** onto the consolidated CI switched on two dependency gates that repo had never run, surfacing **20 pre-existing advisories** (16 JS, 4 Python) in one go. Same shape as [#644](https://github.com/keiranholloway/biffo-template/issues/644) but on a deployed service rather than a skeleton: not a new defect, a first measurement | **fail-open** · visibility | tabsii-intake [#9](https://github.com/tabsii-com/tabsii-intake/pull/9) | tabsii-intake (lockfiles + overrides) + biffo-template [#722](https://github.com/keiranholloway/biffo-template/issues/722) | intake **fixed** (20 → 0); skeleton suppression **open** ([#722](https://github.com/keiranholloway/biffo-template/issues/722)) |
| — | The `biffo check` seam guard asserts `workflow.toContain('sh scripts/biffo.sh check <name>')`. Because that is a **substring** match, a guard renamed by *extension* in `ci.yml` (`plugin-collisions` → `plugin-collisionsXX`) still passes. Deletion and prefix-renames are caught; suffix-extension is not. Found only by mutating the workflow on purpose — the suite was 10/10 green either way | **fail-open** | biffo-template `cli/` ([#718](https://github.com/keiranholloway/biffo-template/pull/718), [#720](https://github.com/keiranholloway/biffo-template/pull/720)) | biffo-template `cli/src/commands/check.test.ts` | **unfiled** — assert on the exact line, or match `check <name>$` |
| [#735](https://github.com/keiranholloway/biffo-template/issues/735) | `biffo core upgrade` **re-proposes migrations an instance has explicitly declined**. tabsii declined 0010 and re-pointed its chain around it; the decline lives only in a docstring, so provenance matching cannot see it and the next upgrade re-offered the migration — reporting `0 conflicts` for a chain that fails at deploy | **boundary** · process | tabsii-platform [#262](https://github.com/tabsii-com/tabsii-platform/pull/262) | biffo-template `cli/` + `biffo.core.json` | **open** |
| [#736](https://github.com/keiranholloway/biffo-template/pull/736) | The test written to catch template-only assumptions **contained one**: it rewrote migration 0010's `down_revision` by matching the literal `"0009"`, the template's value. `core upgrade` re-points distributed migrations onto the instance's head (`"0011"` in tabsii), so all four cases failed on arrival — green in the template, red in the instance, which is the exact shape the test existed to prevent | **drift** | tabsii-platform [#263](https://github.com/tabsii-com/tabsii-platform/pull/263) | biffo-template `services/api/tests/` | **fixed** ([#736](https://github.com/keiranholloway/biffo-template/pull/736)) |
| — | **Auto-merge does not update a `BEHIND` branch.** `gh pr merge --auto` was armed on a PR whose checks were all green; it sat indefinitely because the repo does not auto-update branches, and auto-merge only waits on *checks*. The scoreboard already records auto-merge as the fix for the rebase race — it is only half of it without branch auto-update | process | biffo-template [#734](https://github.com/keiranholloway/biffo-template/pull/734) | biffo-template repo settings | **unfiled** — enable "Always suggest updating pull request branches", or drive `update-branch` in the wait loop |
| — | The workflow dry-run's 502 **discards `str(exc)`** and returns a fixed string, so a 20s timeout, a bad model slug and a missing credential are indistinguishable to the person who can act on them. The reason was already in the log; the user had to ask an agent to read it | **visibility** | tabsii-platform (orchestration admin) | biffo-template `agent_dryrun_service` | **unfiled** — noted while fixing [#726](https://github.com/keiranholloway/biffo-template/issues/726), deliberately not bundled |
| [tabsii#265](https://github.com/tabsii-com/tabsii-platform/issues/265) | The suite runs entirely on SQLite, and `authorize_workflow_scope` returns `False` at a dialect guard on anything that is not Postgres. So the scoped-workflow authorizer returned **deny for every input in CI**, its body never executed, and its two *"fails closed"* tests passed **trivially** — not by exercising the guard they name. An allow/deny matrix was not merely missing but **impossible to write**: every row would have asserted `False`. The feature was live on dev throughout | **fail-open** | tabsii-platform (found reviewing [tabsii-crm#100](https://github.com/tabsii-com/tabsii-crm/issues/100)) | tabsii-platform [#267](https://github.com/tabsii-com/tabsii-platform/pull/267) | **fixed** — Postgres+PostGIS lane, 28-case matrix; 8 rows assert *allow*, which was unreachable before |
| — | **The schema is two stacks, and nothing says so.** `db/imports/tabsii/036` seeds `public.orchestration_workflow_definitions` — a Core **Alembic** table — so applying the DDL import alone dies at module 036. Under `--single-transaction` that rolls back all 48 modules, and the resulting error is `relation "tabsii.tenants" does not exist`, which points at the *first* module rather than the failing one. `_run_db_init` → `_run_ddl_import` encodes the order; nothing else does | **boundary** · visibility | tabsii-platform [#267](https://github.com/tabsii-com/tabsii-platform/pull/267) | tabsii-platform (lane ordering); biffo-template could state the dependency in ADR-0005 | **fixed** in the lane; the undocumented coupling **unfiled** · cost ~15m + 1 CI cycle |
| [#755](https://github.com/keiranholloway/biffo-template/issues/755) | **An instance cannot add a CI workflow of its own.** `.github/` is template-owned wholesale, so a lane testing an instance-only schema — something `core upgrade` could never carry — can only land under a `Core-Divergence:` trailer. That trailer means *"this instance must differ from a template file"*; here there is no template counterpart to differ from, so the divergence ledger gains an entry that can never converge. `infra/environments/` has the `*.core.tf` convention for the mirror-image case; the inverse has no expression | **boundary** · process | tabsii-platform [#267](https://github.com/tabsii-com/tabsii-platform/pull/267) | biffo-template `core-manifest.json` | **open** — proposed as a `*.instance.yml` userOwned glob |
| — | **The `steps.install.outcome` gate is a template idiom that does not generalise.** `ci.yml` gates its check steps on dependency install because that is its only prerequisite. Copied verbatim into a job with a *second*, later prerequisite (schema provisioning), the tests ran against an empty database after the schema step had already failed — turning one honest failure into **28 misleading errors** that named the wrong module | **fail-open** · drift | tabsii-platform [#267](https://github.com/tabsii-com/tabsii-platform/pull/267) | tabsii-platform (each step now gates on the one before); biffo-template idiom needs the caveat | **fixed** — same class as the gates this page already tracks, but self-inflicted by copying a convention |
| — | **A PR closing keyword that is silently not a closing keyword.** [tabsii-crm#106](https://github.com/tabsii-com/tabsii-crm/pull/106) wrote `closes tabsii-crm#100` — repo-qualified but **owner-less**, which GitHub does not recognise. The PR merged to the default branch, the work shipped, and the issue stayed open for two days looking like unstarted work. Nothing warns, and the malformed ref renders as plain text rather than an obviously broken link | **visibility** · process | tabsii-crm [#100](https://github.com/tabsii-com/tabsii-crm/issues/100) | practice (or a PR-body lint) | **unfiled** — three of ten open tabsii issues turned out to be complete; this was one cause |
| — | **"Adopt the skeleton" is not unconditionally safe.** `tabsii-marketplace` could take the sibling skeleton's `ci.yml` verbatim; `tabsii-geo` could not — it has an `E2E (Playwright)` job the skeleton has no equivalent for. Copying wholesale would have **silently deleted real coverage and not failed a merge**, because that job is not one of the four required status-check contexts. The right move was adding the Build step to geo's existing job instead | **drift** · fail-open | tabsii-geo (2026-07-27) | practice — diff before adopting, never copy | **avoided** — caught before adoption |
| — | **A latent defect is worse than a live one.** Eager `CognitoUserPool` construction at module load broke `tabsii-geo` and `tabsii-marketplace` builds outright, so both got fixed. `tabsii-intake` had **identical code and a passing build**, only because no page imported the module — it would have surfaced in whatever future PR first added such a page, *looking like that PR's fault* | **drift** · visibility | tabsii-intake (2026-07-27) | tabsii-intake + siblings | **fixed** — geo, marketplace, app and intake all construct lazily and carry `auth.test.ts` |
| [#758](https://github.com/keiranholloway/biffo-template/issues/758) | `core upgrade` pushes with a **refspec and no `-u`**, so the local branch it creates never gets an upstream. Squash-merge then makes that branch a non-ancestor of `dev`. The leftover is therefore invisible to **both** standard staleness checks at once — `git branch --merged` cannot see it (not an ancestor), `git branch -vv \| grep ': gone]'` cannot see it (no upstream to report gone) — and `git branch -d` refuses it, leaving only `-D`, which reads as unsafe. **190 local branches** across three repos; `biffo-platform` held upgrade branches back to core 0.41.18 | **visibility** · process | biffo-platform, tabsii-platform | biffo-template `cli/` | **open** — 132 branches + 5 worktrees swept by hand this session; the tool still regenerates them |
| — | A **primary checkout parked on a merged upgrade branch**, 10 commits behind `dev`, was read as an instance's current state. It reported core `0.136.0` and a pre-#670 migration `0010`; `origin/dev` actually carried `0.146.2` with the guard already ported. The wrong figures reached a PR description and a user-facing summary before `git show origin/dev:` disproved them. AGENTS.md §2 predicts this exact failure in prose — nothing enforces it | **visibility** | biffo-platform (checkout, not code) | biffo-template (hygiene check) + diagnostic practice | **open** — folded into [#758](https://github.com/keiranholloway/biffo-template/issues/758); nothing detects a primary parked off the integration branch |
| — | The **purpose-built remedy for the measured merge race is unavailable on this account.** GitHub rejects the `merge_queue` ruleset rule with a bare `422 Invalid rule` on *both* a public personal repo and a private org repo on Team, and the branch-protection UI offers no merge-queue option at all — while other rule types create fine on the same repo. H1 pre-registered exactly two next moves; this eliminates one permanently | **process** | biffo-template (H2) | — (environment constraint, not a defect) | **closed** — recorded in full in `docs/practices/experiments/H2-merge-queue.md` rather than deleted, so the constraint outlives the experiment |
| — | **The daily practices job computed its numbers with a superseded collector, and every surface signal said it was healthy.** `practices-daily.sh` rebases its snapshot branch onto `dev`; the snapshot files it commits *also* exist on `dev`, so the rebase hit a content conflict on **every run**. The script caught that, logged to stderr and **carried on** — so the branch froze 45 commits behind while the collector still ran, the dashboard still rendered, the snapshot still pushed and cron still exited 0. The code actually executing predated [#703](https://github.com/keiranholloway/biffo-template/pull/703), which **changed how merges are classified**, plus #706/#708. The stale tree also lacked `scripts/practices-session.mjs`, so the nudge crashed `MODULE_NOT_FOUND` daily — hidden by its own `\|\| true`. **Metrics that look right and are computed by the wrong code are worse than metrics that are missing** | **fail-open** · visibility | biffo-template `scripts/practices-daily.sh` | biffo-template `scripts/` | **fixed** — `rebase -X theirs` (the branch's snapshot is the live series; `dev`'s copy is a stale import), and a rebase failure is now **fatal** because every step after it runs the wrong code |
### What the classes say

> Counted from `docs/practices/evidence.jsonl`, not asserted. Regenerate with
> `node scripts/practices-evidence.mjs --report`. **94 rows** — the extractor's
> count still **equals the table's count**, now across a merge that had to be
> reconciled by hand. See below.

| Primary class | Rows |
| --- | --- |
| **visibility** | 26 |
| drift | 21 |
| fail-open | 19 |
| boundary | 16 |
| process | 12 |

**The extractor and the table now reconcile, and the cause was findable all
along.** This page twice recorded that `--extract` "silently drops a row it
cannot parse" (53 vs 54) and asked someone to reconcile the two before pasting
any generated figure. Exactly one row triggered it: the `js-dependency-audit.sh`
row quotes a shell pipeline as `echo "$out" \| jq`, and the parser split on
**every** `|` including the markdown-escaped one — producing 7 columns, landing
`class` on the tail of the condition, failing the class parse, and `continue`-ing
without a word. Splitting on unescaped pipes only fixes it: **65 rows extracted,
65 rows in the table.** Every figure below is now pasted from `--report`.

**This page previously said "fail-open is the dominant shape — three of the five
filed issues".** That was true of a five-row sample and was never revised as the
sample grew thirteenfold. Counted across all 65 rows, fail-open is *fourth*. The
error is instructive and is the reason the rows are now a dataset: **a narrative
appended to by hand drifts from the evidence above it, silently, and reads
exactly as confidently while doing so.**

**visibility is the dominant shape** — the truth was not observable. Masked
errors, absent logs, unretained evidence, a preview that contradicts the
operation it previews, a diagnostic that was confidently wrong. Nearly a third
of every failure recorded here was not a component behaving incorrectly but a
system unable to say what it had done.

The fail-open lesson stands and is worth keeping, because it is a *sub-shape* of
visibility rather than a rival to it: **when adding a gate, decide explicitly
what it does when it cannot run, and make "inconclusive" a distinct, visible
outcome from "passed".** A gate that cannot report its own inconclusiveness is
just one more thing that cannot say what it did.

**What the dataset cannot yet tell us.** Of 57 rows, **1** carries a cost figure
and **33** carry a date — all of them in a single month, 2026-07. So rows can be
ranked by *frequency* but not yet by *cost*, and there is no longitudinal trend
to read. Recording wall-clock on every new row is what unlocks the ranking this
page exists to support (§ Adding a row).

**boundary and drift are both ownership failures.** #652 is two ADRs claiming one
URL prefix; #621 is one concept with two implementations. Neither is a coding
mistake — both are two correct designs meeting with nobody owning the seam.

**The skeleton has never been exercised by a second plugin.** Five rows above —
#685, both halves of #688, the dead Terraform module and the "no JS/TS" CI
assumption — were all found by installing a *second* plugin alongside the first.
Every one is a shared namespace or a template that only ever had one occupant:
one `scripts` package, one set of test basenames, one generated Terraform block,
one assumed repo shape. None would have been found by testing the skeleton
harder in isolation, and all of them broke the *incumbent* plugin, not the new
one.

**Distribution is a test environment the template does not have.** Three rows
(#670, #671, #666) were found in one afternoon by carrying core `0.127.0 →
0.132.0` into tabsii, and *none* of them could have been found upstream: the
template always has `public.users`, always has an empty write-back registry,
always resolves its CLI from the local workspace rather than the registry. Its CI
is green and stays green while an instance cannot build.

The generalisation is uncomfortable but simple: **a template-owned test that
asserts "nothing is registered", or a template-owned migration that assumes a
Core-owned table exists, is asserting a property of the template rather than of
the contract.** Both pass forever upstream. The cheapest defence available today
is to run a real upgrade into a real instance before believing a core release is
good — which is the only thing that found any of these.

---

## Where the work actually lands

**Counting rule** (two sessions computed different totals in good faith, so it is
now stated): count **every scoreboard row**, filed or not — an unfiled row is
still work that has to land somewhere. A row naming two repos counts once for
each, so the column sums exceed the row count.

**Generated, not typed** — `node scripts/practices-evidence.mjs --report`,
`byFixRepo`, regenerated at **99 rows** (never typed by hand, see *Adding a row*):

| Repo | Fixes landing here | Notes |
| --- | --- | --- |
| **biffo-template** | 68 of 99 (69%) | Core API, CLI, CI, CDN module, skeletons, migrations, publish pipeline, repo settings, orchestration schema, write-back framework, design tokens, the practices tooling itself |
| **tabsii-platform** | 8 of 99 | Divergence ratchet, repo settings, the RLS lane, raw-SQL portability, SES identity and bounce capture |
| **biffo-platform** | 5 of 99 | Instantiated infra — API Gateway routes, CDN, vendored-plugin resyncs, DDL seeds, log config |
| **tabsii-intake** | 5 of 99 | CI generation, branch-protection contexts, the `python-jose` removal |
| **biffo-plugin-idea-scout** | 4 of 99 | Adapter seam, research search capability, its own stylesheet |
| **tabsii-marketplace** | 2 of 99 | `python-jose` removal; the credential-dependent build |
| **tabsii-crm** | 1 of 99 | The missing sibling proxy for a core route its own frontend called |
| **biffo-plugin-ideation** | 1 of 99 | A UI rendering a 500 as an empty state |
| **biffo-runners** | 1 of 99 | Runner fleet docs + fail-fast |

**The drift downward continued, and a new repo appeared.** `biffo-template` takes
**68 of 99** — 69%, against 70% at 94 rows, 82% at 65 and 86% at both 57 and 50.
`tabsii-crm` enters the table for the first time, and `tabsii-platform` has gone
6 → 8 in a single session.

Both movements have the same cause and it is not sampling: satellite repos are
starting to carry defects that are genuinely *theirs* — a sibling that failed to
proxy a route its own frontend called, raw SQL that only worked because of the
database underneath it, an untracked sending identity. Those could not have been
fixed upstream. The number to watch is whether template's share keeps falling as
instances grow their own surface area, because that is the point at which "fix it
in the template" stops being the default answer.

> **This block was wrong on `dev` until 2026-07-28**, and the way it was wrong is
> the lesson: it simultaneously read "at **65 rows**", a table of "of **89**",
> and prose saying "**53 of 65**" — three different totals in one section, from
> two sessions each hand-editing part of it. Regenerate the whole block from
> `--report` in one go; never update a number in place.

This is no longer "instances surface what the
template must fix"; it is closer to a statement about what Biffo *is*. The
template is the product, and the satellites are where its defects become
visible. Read that way the number is not alarming, but it does mean **satellite
repos are the test environment and should be resourced as one** — nobody is
going to fix a template defect from inside a plugin.

**The headline claim on this page was "the zero has held". It has not, and the
previous count was stale in both directions.** The table said 44 rows when the
scoreboard held 47 before this session added 3; the filed count (27) had not
moved while unfiled rows grew from 17 to 23. Two plugin repos now carry a fix
each, so **`biffo-plugin-ideation` is 1 of 50, not 0 of 44**.

This is the third time a number quoted in prose on this page has gone stale
without anyone noticing — the same drift the page warns about twice, once about
its own headline. The lesson is not "recount more carefully"; it is that a
hand-maintained count next to a hand-maintained table will always drift. These
figures should be generated by `scripts/practices-evidence.mjs --report` and
pasted, never typed.

**What has *not* changed is the shape**: **88% of fixes still land in
`biffo-template`**, and the two plugin rows are both *surface* defects (an error
rendered as empty state, a missing build artifact) rather than the platform
defects that block downstream work. The zero was always a stronger claim than the
evidence needed — "defects are reported wherever someone runs into them and
overwhelmingly fixed upstream" survives intact without it.

The original case remains the clearest illustration: a user hit
`Failed to load catalog: Unexpected token '<'` in the Ideation admin UI, and it
was two platform defects stacked — a routing collision (#652) producing a 404,
and a CDN rule (#647) disguising that 404 as a successful HTML response. The
plugin was correct throughout.

Two consequences worth internalising:

- **Bug reports are attributed to where they are seen, not where they live.** Time
  spent hardening plugins or instances would not have prevented these.
- **A downstream repo can be blocked by a defect it cannot fix.** #652 has no
  workaround inside `biffo-plugin-ideation`; #671/#664 blocked *every* instance's
  guards from a broken npm credential. Platform defects are throughput blockers
  for everything downstream, and should be priced accordingly.

**What changed with this recount:** the rows landing in `tabsii-platform` are
mostly *scaffolding to detect the next defect*, not product fixes. Several rows
come from a single afternoon's E2E of one feature, and they share one **root
cause** (Core's `String(36)` id space meeting an instance's `UUID`s) rather than
being distinct symptoms. That is the first time the page shows a repeated root
cause, and it argues for a different investment than "fix more bugs": the
template needs a way to exercise an instance's column types.

**What the larger sample added:** instance repos are not just where defects
*appear*, they are where the template's untested seams get exercised for the
first time. ADR-0022's discovery order, the ownership guard's coverage, the event
registry's field metadata and migration 0010's `public.users` assumption were all
green in `biffo-template` and all broke on first real instance use. An instance is
the template's integration test, and currently the only one.

### How wide one feature reaches

> **Reconciled 2026-07-28.** This note previously recorded that the counts did
> not agree — table 54, extractor 53, prose 65 — and asked whoever fixed it to
> reconcile the extractor against the table *before* pasting any generated
> figure. Done: the extractor split on every `|`, including markdown-escaped
> `\|`, which silently dropped exactly one row (the `js-dependency-audit.sh` row
> quotes `echo "$out" \| jq`). It now splits on unescaped pipes only, and
> **65 extracted = 65 in the table**.
>
> The per-repo table above is now pasted from `--report`'s `byFixRepo` rather
> than typed, which is what the paragraph above it promised and nothing
> previously delivered.
>
> The general lesson stands and is worth keeping after the specific defect is
> gone: **a generator that under-reports without saying so is worse than a hand
> count**, because it carries the authority of having been computed. The
> extractor discarded that row via a bare `continue` — no warning, no count of
> skipped lines. It now cannot drop a row for *this* reason, but it would still
> be silent about any other, and that is the residual gap.


## Where the cycles go

The scoreboard records what *broke*. This records what it *cost*, which is a
different question and often the more actionable one: a defect fixed in ten
minutes and a defect that ate an afternoon get one row each up there.

Measured on the 2026-07-27 session, which shipped one bug fix end to end.

### The headline: ~10 hours, no working feature

A second 2026-07-27 session spent **roughly nine to ten hours** on Idea Scout and
**did not ship the feature**. That is the single most important number on this
page, and it is worth stating plainly rather than leaving it to be inferred from
a cost table.

What it did ship: two small integration pieces, both verified live — the
dashboard tab embed and the Ideation `?seed=` deep-link. What it did not ship:
**Idea Scout still cannot produce a single ranked candidate**, which is the
entire point of the feature. It fails today exactly as it did this morning, one
step further down the pipeline.

The instinct is to read that as four unrelated bugs and bad luck. It is not. The
defects were **serialised by the feedback loop**:

| # | Defect | Only discoverable once… |
| --- | --- | --- |
| 1 | Build-types read hit the plugin host, not Core → every `start_run` 401'd | …a founder actually clicked **Run now** on a deployed instance |
| 2 | `web_search` declared but unconfigured → dropped with a warning, research returned nothing | …#1 was fixed, merged, resynced, deployed, and re-clicked |
| 3 | `agent_fan_in` cannot declare `output_tools` → synthesis told to call a tool it was never given | …#2 was fixed, merged, resynced, deployed, and re-clicked |
| 4 | Synthesis never receives the founder profile or build type | …#3 is fixed, merged, upgraded, resynced, deployed — **still pending** |

**All four were present in the code this morning.** None could be seen until the
one before it was fixed *and shipped all the way to a running deployment*. Each
discovery therefore cost a full round trip — plugin PR → instance resync PR →
deploy → browser click — of **~30–45 minutes when nothing goes wrong**. Four of
those is most of a day before a line of the *actual* fixing is counted.

So the honest post-mortem is not "we hit four bugs". It is:

> **The loop only reveals one defect per traversal, and the traversal costs the
> better part of an hour.** A pipeline with four latent faults therefore takes
> four traversals to even *enumerate*, regardless of how quickly each is fixed.

Two consequences worth acting on, both cheaper than shortening the loop:

1. **Fail loudly at the first missing capability, not the last.** Three of the
   four are the same shape — *the prompt names a capability the run does not
   offer* — and each failed **open**, mid-chain, after spend. A preflight check
   that asserts every declared tool actually resolves before the first paid model
   call would have surfaced #1, #2 and #3 **in one traversal instead of three**.
   Proposed in [#729](https://github.com/keiranholloway/biffo-template/issues/729).
2. **Make one traversal test the whole pipeline.** Nothing exercises
   fan-out → fan-in → synthesis → projection end to end below a live click. A
   staging harness that runs the real chain against stub agents would have
   collapsed all four into a single failing run on a laptop.

The platform work the day *did* produce (branch protection across the fleet,
`agent_fan_in` output tools, the `:online` switch) is real and mostly upstream —
but it was **unplanned**, discovered by walking into it, and none of it was the
feature. A day of unchosen platform work is exactly what the `toil` bucket in the
effort log exists to make visible, and this session logged it that way.



| Cost | Cause | Status |
| --- | --- | --- |
| **~4 rebase cycles on one PR** | `dev` takes a merge every 3–5 min; CI is ~2.5 min. The branch is `BEHIND` again before its checks finish, so the manual `merge → rejected → rebase → re-verify → push` loop is **structurally unwinnable**, not unlucky | **fixed** — auto-merge enabled on `biffo-template` and `biffo-platform`; GitHub now owns the update-and-merge |
| **~40 min minimum feedback loop** | A template-owned change reaches a running instance through **six hops**: template PR → `core-tag` → npm publish → `core upgrade` → instance PR → deploy. Nothing is verifiable until the last one | **open** — see below |
| **One near-miss deploying half a fix** | Hop 3 can lag hop 2: `core-v0.136.0` was tagged while npm still served `0.135.0`. Upgrading in that window carries a *partial* change that deploys green and still fails | caught by checking npm, not the tag; **unautomated** |
| **One wrongly-halted deploy + a wrongly-filed issue** | `core diff` reported instance-authored files as `removed`; `core upgrade` deletes none of them ([#689](https://github.com/keiranholloway/biffo-template/issues/689)). The preview was escalated as fact without running the dry run that disproves it | **open** (#689); the escalation is a practice failure, recorded under *needs more thought* |
| **One wrong diff, silently** | `core diff` was run against a local template checkout missing the just-merged commit, and reported *no changes at all* for the half it was missing. Caught only because the absence looked implausible | **open** — no tooling notices; a stale-tree diff looks identical to a current one |
| **~2¼ hours babysitting 8 merges** | `tabsii-platform` CI is **6–8 min** wall-clock (not the ~2.5 min the template enjoys) and Deploy Application a further **6–12 min**. With `allow_auto_merge=false` on that repo, every one of 8 PRs was watched to green, merged by hand, then watched again through deploy | **fixed** — auto-merge enabled on `tabsii-platform`; GitHub now owns update-and-merge there too. The CI/deploy duration itself is untouched and still unowned |
| **8 × full dependency install** | Every worktree needs its own `uv sync` + `pnpm install` before the pre-push `pyright` can be trusted (AGENTS.md §1). Eight worktrees this session; no shared venv or store warm-start | **open** — inherent to worktree-per-change, but cacheable |
| **2 wasted hook cycles** | `commitlint` (footer >100 chars) and the ownership guard both reject **after** `lint-staged` has run ruff+prettier over the staged set. A rejected commit costs the whole hook cycle, and neither constraint is discoverable before tripping it | **open** — cheap fix: validate the message first, or document both limits in AGENTS.md §3 |
| **2 false 'no checks' reads** | `gh pr checks --watch` run immediately after `gh pr create` returns *no checks reported* and exits 1, because it races GitHub registering the runs. Indistinguishable from the genuine "GitHub created no run" case AGENTS.md §6 warns about, which is the one you must not paper over | **open** — needs a settle delay, or a way to tell the two apart |

| **biffo-template** | 58 of 81 (72%) | Core API, CLI, CI, CDN module, skeletons, migrations, publish pipeline, repo settings, orchestration schema, design tokens, the practices tooling itself |
| **biffo-template** | 47 of 65 (72%) | Core API, CLI, CI, CDN module, skeletons, migrations, publish pipeline, repo settings, orchestration schema |
| **8 repos audited by hand before a tool existed** | Establishing which branches were protected meant a `gh api` loop per repo per branch, because nothing reported settings drift. That audit *is* the finding: it took writing `biffo check branch-protection` ([#718](https://github.com/keiranholloway/biffo-template/pull/718)) to make it a one-liner — and the guard then immediately caught an incomplete fix the hand audit had missed | **fixed** — guard shipped; not yet scheduled anywhere |
| **One wrong conclusion from re-running the wrong workflow** | Testing "does intake's old CI fail today?" I re-ran the newest successful `dev` run — which was **Deploy**, not CI — and it passed, appearing to disprove the hypothesis. Redone against an actual `ci.yml` run it failed, confirming it. A run id is not self-describing; filter by workflow, not by branch and conclusion | **process** — cost one wrong belief, caught by checking the job names |
| **2 dependency-alignment rounds on one repo** | Mirroring another sibling's known-good versions cleared 8 of 13 advisories; the last 5 were transitives with no direct upgrade path (`postcss`, `sharp`, `brace-expansion`) and needed the same repo's `pnpm.overrides` copied across too. The fix existed and was found twice, by hand, because **nothing shares a remediation between siblings** | **open** — the overrides live in two package.json files with no common source |
| **4 × ~30–45 min round trips to discover 4 latent defects** | A plugin defect is only visible on a deployed instance, and one traversal reveals **one** defect. Fix → plugin PR → instance resync PR → deploy → browser click, then the next fault appears. See *The headline* above | **open** — the preflight check ([#729](https://github.com/keiranholloway/biffo-template/issues/729)) collapses three of the four into one traversal |
| **Every plugin change costs two PRs** | `dev.biffo.io` serves the copy vendored in `biffo-platform/services/<plugin>/`, not the plugin repo. Merging upstream changes nothing live; a second "resync vendored plugin" PR into the instance is always required, and **nothing warns when the two have drifted** | **open** — 3 resync PRs this session; a drift check would at least make the gap visible |
| **2 rebase races with auto-merge already on** | Auto-merge does **not** update a head branch that falls `BEHIND` under strict protection. Both PRs sat green-and-blocked until manually rebased and force-pushed — so auto-merge removed the *retry* loop, not the *race* | **open** — refutes the H1-merge-race experiment's open assumption; next move is a merge queue |
| **~25 min auditing branch protection by hand, again** | Two plugin repos had **no protection at all** on `dev` (`404 Branch not protected`) while their own AGENTS.md claimed otherwise. Found only because a PR merged with checks still running | **fixed** for both repos; skeleton gap filed ([#714](https://github.com/keiranholloway/biffo-template/issues/714)). `biffo check branch-protection` exists but is **still not scheduled anywhere**, so nothing would have caught this either |
| **1 full reinstall + rebuild to answer "did I break this?"** | A build failed after a dependency upgrade. Establishing that it failed *identically* before the upgrade meant stashing the lockfile changes, reinstalling the original tree and rebuilding — several minutes to convert a suspicion into a fact. Worth every second: the alternative was shipping a fix for a defect I had not caused, or abandoning an upgrade that was fine | **structural** — no cheaper way to get a before/after on a lockfile |
| **3 releases that silently never happened** | A workflow whose `on: push: tags:` cannot fire, with nothing reporting a missing run. Cost was not the fix (~20 min) but the fact that only a deliberate check found it — and it was found by luck of being asked, not by any signal | **fixed**, and the guard now derives from the workflow directory so a fourth release workflow cannot repeat it |
| **~5 publish attempts to put one 2 kB package on npm** | A new package cannot use OIDC (no trust to register against) and the fallback token did not work. Token → 404, OIDC at npm 12.0.1 → 404, local publish → `ENEEDAUTH`, web login → `EOTP`, passkey → done. npm answers **404 for unauthorised writes**, so three unrelated causes were indistinguishable | **structural** — a first publish has no credential-free path; once per package |
| **A trusted-publisher registration filled twice and lost twice** | Saving it triggers a WebAuthn ceremony, which by design fires only on a genuine user gesture. Filling the form is automatable; completing it is not. Re-loading showed the config had silently reset | **open** — still unregistered, so the next tag's publish will 404 |
| **A local preview harness instead of a deploy cycle** | Before shipping the Idea Scout stylesheet, the built CSS was rendered against markup copied from the components and screenshotted locally. ~5 min, against a ~35 min plugin-PR → resync-PR → deploy round trip to discover a layout mistake | **avoided cost** — worth repeating for anything visual |
| **3 sessions' documentation deleted by one stale-base merge** | A whole-file rewrite from a branch that predated another session's merge: 215 insertions, 322 deletions, no conflict. Recovering it meant diffing an old commit and re-merging by hand | **restored**, and the code vector fixed; the editing convention that would prevent it does not exist |
| **~4 serial `update-branch` + full-CI cycles on a 5-PR queue** | `biffo-template` requires branches be up to date, so **every merge invalidates every other open PR**. Clearing a 5-deep queue is therefore N sequential ~2.5 min CI cycles, not one. Auto-merge was enabled on this repo the same day precisely to hand this to GitHub — and it was **merged by hand anyway**, re-paying a cost that had already been fixed | **self-inflicted** — the row above records the fix; this records not using it. `gh pr merge --auto` should be the default verb, not `--squash` |
| **~10 min waiting on a loop that could never exit** | A poll used `gh pr checks <N> --json state`; this `gh` has no `--json` on that subcommand, so the `jq` produced empty output that never equalled `0`, and the loop spun to its full timeout **while CI had already gone green**. A wrong flag and slow CI are indistinguishable from inside the loop | **fixed** in-session — poll `gh pr view --json statusCheckRollup`, or the commit's `check-runs`, and assert the result is non-empty before trusting it |
| **3 full release cycles to land one distribution** | Getting the async dry-run into tabsii took `0.146.0` → `0.146.1` → `0.146.2`, because each defect only became visible at the *next* hop: 0.146.0's chain failed only when run against a real PostgreSQL, and 0.146.1's test failed only once it reached an instance whose migration chain differs. Each cycle is a template PR + CI + tag + npm publish + re-run `core upgrade` — **the six-hop loop billed three times for one feature** | **structural**, not carelessness. Both defects were invisible in the template by construction. Shortening this needs the template to be able to run *an instance's* chain, not more care at each hop |
| **~10 min armed on a merge that could not happen** | `--auto` was set on a green PR that was `BEHIND`; auto-merge waits on checks, not on branch freshness, so nothing moved until `update-branch` was driven by hand | **fixed** in-session — the wait loop now updates the branch when it sees `BEHIND`. The durable fix is the repo setting |
| **3 full CI round trips to land one CI workflow, because none of it could be run locally** | Building the Postgres lane needed a real Postgres. This machine has Docker installed but the user is **not in the `docker` group**, `sudo` is **not passwordless**, the local PG 18 cluster is **down** (starting it needs root) and **PostGIS is not installed** — so every hypothesis cost a full push → spot-runner scale-up → run. Three iterations: the two-stack schema discovery, then Secret Scan, then green. Each ~5–9 min, most of it queueing | **structural** — the "verify locally first" step in `biffo-verify` §2/§3 was **unavailable**, not skipped. A rootless dev Postgres (or a documented `docker` group prerequisite) would convert all three into seconds |
| **~4–8 min of pure queue on every single push** | The scale-to-zero spot fleet has no warm runner, and this PR fanned out to **7 checks**. Every push pays cold-start before anything executes, so the feedback loop is dominated by scheduling rather than by the work. Cheap at idle (the point of the fleet) and expensive exactly when iterating | **open** — inherent to scale-to-zero; a single warm runner for the first job would cut the iteration loop roughly in half |
| **1 wasted CI cycle to a documented trap** | AGENTS.md §7 states that `.gitleaks.toml`'s `biffo-aws-account-id` rule is `\b\d{12}\b` and warns *"two agents hit this in one day"*. A UUID's final segment is exactly 12 characters, so fixture ids like `…-000000000001` are indistinguishable from an account id. **Read the rule, wrote the fixtures anyway** — the brand/region/unit ids happened to end in a hex letter and passed, which made the user/role/tenant ids look fine by association | **process**, now three agents. The doc says the right thing; it is not reachable at the moment of writing a fixture. A `.gitleaks.toml` comment, or a fixture-id convention in the skeleton, would sit closer to the point of use |
| **10 × `update-branch` + full CI re-run, in one session** | The same loop as the rows above, now counted properly across three repos: #747 once, #750 twice, #754 once (*the PR carrying H1's verdict that this happens*), #270 five times, #89 once. Each costs a full CI cycle (~2.5 min template, 6–8 min tabsii). **Nine of the ten were in repos with `strict: true`; zero occurred on `biffo-template` after `strict` came off.** That split is the whole reason the fix is a setting and not more diligence | **partly fixed** — `strict: false` on `biffo-template` only, as experiment H3 (review 2026-08-11). The other repos keep it deliberately: `tabsii-crm` is the comparator, and changing everything at once would destroy the only baseline |
| **~45 min proving a planned fix was impossible** | H1 named a merge queue as its preferred next move. Enabling it took a prerequisite PR (#752, teaching CI to report on `merge_group`), a ruleset attempt, four API probes to isolate the failure, and finally a look at the branch-protection UI — to conclude GitHub does not offer merge queues on this account at all | **not waste, but not free.** The 422 message is a bare `Invalid rule 'merge_queue':` with an empty reason, so nothing short of probing distinguishes "bad payload" from "unavailable feature". Recorded in H2 so the next person spends zero minutes on it |
| **1 hand-resolved rebase conflict inside one sprint** | #747 and #748 were sequential fixes to the *same two functions* in `core-migrations.ts`. Merging the first made the second `DIRTY`, needing a manual three-way resolution of both the code and the doc section they had each appended to | **structural, and cheap to avoid** — the two issues were known to touch the same file before either started. Sequencing them as one PR, or explicitly stacking them, would have cost nothing. Splitting by *issue* rather than by *file* is what created it |
### Auto-merge is armed and still loses the race — a seventh data point

`tabsii-platform` has `allow_auto_merge = true` and every PR this session was
queued with `--auto`. **Seven hand-rebases were still required** across five PRs
(#268 ×2, #269 ×2, #271, #273, #278): each merge to `dev` put the open ones
`BEHIND` under `strict` protection, and auto-merge waited rather than updating
the head branch. `cost ~45m` of pure re-cycling, all of it waiting on CI runs
that only existed because something *else* merged.

This is not a new finding — the scoreboard already carries it as open — but it is
the first time it was observed on a repo where auto-merge was correctly
configured throughout, which removes the remaining "it was just misconfigured"
explanation. **Structural, not careless.** The fix is a merge queue or relaxing
`strict`; nothing an agent does per-PR will win it.

### Cross-repo distribution is the other loop, and it is *correct*

Two upstream round trips, back to back: `from_payload` (template → publish →
`biffo core upgrade` → instance), then a fixture fix that had to take the same
path because the instance's suite could not go green without it. **`cost ~50m`
of waiting**, six hops each.

Worth separating from the merge-race cost, because this one is the ownership
boundary working as designed. The alternative — patching the template's own test
inside the instance — was available, would have unblocked in two minutes, and
would have forked a template test in one repo while leaving the defect for every
other instance. The loop is the price of the boundary, not a defect in it. What
would genuinely shorten it is publishing a core version without a full release
cycle for test-only changes.

### The six hops are the root cost

Every other row above is a *symptom* of the same shape: the chain from "merged
in the template" to "running in an instance" is long, and **verification is only
possible at the end of it**. So every mistake — a stale checkout, an unpublished
artifact, a silently-skipped deploy step — is discovered after the full ~40
minute round trip, and each retry costs another one.

That is what "going in circles" actually is here. It is not carelessness at any
single hop; it is that the loop is too long to catch anything early, so the
error rate per hop compounds into the wall-clock cost.

Worth attacking in this order, cheapest first:

1. **Make the preview trustworthy** (#689). A `core diff` that contradicts
   `core upgrade` does not just waste a run — it caused a safe upgrade to be
   abandoned and an incorrect data-loss issue to be filed. Confidence in the
   preview is what makes the other five hops tolerable.
2. **Assert the artifact, not the tag.** A cut `core-v*` is not an available
   artifact. `core upgrade` should refuse to run (or warn loudly) when the
   resolved CLI version is older than the template tag it is upgrading from —
   the check that caught this by hand.
3. **Make deploys prove they deployed.** Capture Lambda `LastModified` before
   deploying and assert it moved afterwards. The plugin-host step *skips
   silently* when a function is unprovisioned, so a green deploy is not evidence
   the code shipped. Doing this by hand is what confirmed the #652 fix actually
   landed.
4. **Retain CI logs.** Not retained for self-hosted runs, so a green check cannot
   be inspected to see what it *did* — which forced local reproduction of the
   audit-gate behaviour.
5. **Shorten the loop itself.** The open question, and the biggest prize: does a
   dev-environment change need all six hops? Everything above makes the chain
   more honest; only this makes it shorter.

### What this is not

It is not an argument for skipping hops. The ownership boundary, the guard, and
the PR-per-instance exist because manual copy-ins let instances drift silently
(#243, #325, #559) — the failure they prevent is worse and harder to see. The
argument is for making each hop **fast to verify and honest about its result**,
not for removing it.

## What went well — practices that earned their keep

**Establishing current state first turned "work the backlog" into "close three,
rescope two, build one".** Ten open issues across the tabsii repos. Checking each
against the code rather than reading its title found that **three were already
done**: the branch-protection audit in tabsii#261 was fixed on every repo it
named, tabsii#209's `biffo.divergence.json` existed and carried its own
revalidation note, and tabsii-crm#100's surface had **shipped two days earlier**.
Two more (tabsii#207, tabsii-crm#65) were most of the way done and materially
misdescribed — #207 read as ~45 files of relocation with 3 left, and #65 claimed
no E2E harness against a repo with a containerised Playwright job in CI. Writing
code first would have re-derived work that already existed, and the two rescoped
issues would still be lying to the next reader.

**Probing the runner beat reasoning about it, and one of the four answers
changed the design.** The Postgres lane needed to know whether service containers
work on the self-hosted AL2023 spot fleet — no workflow in the repo had ever used
`services:`. A throwaway probe job returned: Docker present, daemon reachable as
`ec2-user`, sudo passwordless, and **`postgis` not in the AL2023 dnf repos**. That
last one is the one that mattered: the plausible fallback (`dnf install
postgresql-server`) would have produced a Postgres without PostGIS, which module
000's `CREATE EXTENSION IF NOT EXISTS postgis` rejects on the *first file* — a
second failed round trip, discovered the same slow way as the first.

**§4 on a frontend change: grep the deployed bundle, not the merge.** The CRM
region/unit mounts merged green and deployed green, which proves a pipeline ran,
not that the code shipped. Fetching `dev.tabsii.com/crm` and grepping the emitted
chunk found `Region automations`, `Unit automations`, and all three scope literals
(`level:"brand"`, `level:"region"`, `level:"unit"`) where only `brand` existed
before. Cheap, unauthenticated, and it converts "the deploy was green" into "the
artifact contains the change".

**Asserting the wiring instead of the chrome, and proving it fails.** The
mount-point tests originally asserted the drawer's heading and eyebrow — which a
panel pinned to the *wrong node* would render just as convincingly. Rewritten to
capture the `scope` prop and assert it, then verified by swapping `region` for
`brand` in the component: `expected { level: 'brand', id: 'r1' } to deeply equal
{ level: 'region', id: 'r1' }`. The first version would have passed against the
bug it was written for — the same shape as the two vacuous guards already on this
page, caught before shipping this time rather than after.

**"Prove the test fails without the fix" caught a guard that guarded nothing.**
A new skeleton-drift guard passed 11 tests. Reintroducing the exact
`runs-on: ubuntu-latest` drift it was written to catch **still passed** — its
path resolution overshot to `/home`, and auditing a directory that does not
exist returns no violations. Nothing else in the process would have found it:
the code read correctly, the suite was green, and the guard would have shipped
detecting nothing while stopping anyone else from looking. This is #695's shape,
written the same day a row about #695 was added.

**Establishing current state first turned three issues into one hour, not three.**
#722 asked for a `pip-audit --ignore-vuln` suppression; the skeleton had already
been migrated to `pyjwt` and audits clean, so the right answer was to close it
with evidence and ship nothing. #652 was already fixed and deployed by two merged
PRs. #685's generator already filtered inputs by declaration, so the change was
two additions rather than a rewrite. In each case the first move was reading the
current state rather than the issue's proposed fix.

**Executing beats reading, and the gap is not small.** Three "defects" were
identified by grep and disproved by running the code: two of four bare
`httpx.AsyncClient()` calls pass a per-request timeout; ruff special-cases
FastAPI so a `Depends()` default never trips B008; a skeleton's differing ruff
`select` is correct in both directions. All three would have shipped as fixes to
things that were not broken.


**Read the headers, not the rendering.** Two plugin admin URLs both returned
`200 text/html` and were read as one failure; `x-cache` and `<title>` — present
in the first response fetched — proved they were opposites. The same session
then read `200`-looking success from an admin panel that was actually serving a
**500** rendered as an empty state. Both times the correct answer was one field
away in a response already in hand, and both times it was skipped because the
page *looked* consistent with the theory. **A rendered page is the weakest
evidence available; it is the layer designed to look fine.**


Each of these caught something that would otherwise have shipped.

**Reproduce before fixing, by the reporter's route** (AGENTS.md §4). Starting #591
by checking the current state revealed the JS half already merged and the Python
half already open as #636 — the work was rebasing and landing someone else's PR,
not writing a new one. Cost: two minutes. Saved: a duplicate PR.

**Prove the test fails without the fix.** Used twice. For #655, reverting
`require_forwarded_user` to its old behaviour made exactly one new test fail with
`DID NOT RAISE HTTPException`; restoring the fix made it pass. A test written
against a bug you have already fixed is worth very little until you have watched
it fail.

**Verify the deployed artifact, not the source.** The obvious theory for #652 was
a stale deploy. Downloading and unzipping the plugin-host Lambda showed the
deployed `admin_app.py` matched `dev` exactly, killing that theory in one step
and forcing the search toward routing, where the bug actually was.

**Bypass the layer that is masking the truth.** `/model-catalog` returned
`200 text/html` through CloudFront. Reading the response *headers* —
`server: AmazonS3`, `x-cache: Error from cloudfront` — proved the body came from
the portal bucket after an origin error. That one observation converted a vague
"the API is flaky" into a precise, filable CDN defect.

**Distrust a green check when the checker can fail open.** Both audit scripts exit
0 when they cannot run, so "the check passed" was not evidence. Stubbing `uv` and
exercising all four paths — real advisory, malformed output, retry-then-recover,
clean run — was what actually established #636 was correct.

**Never merge red, and never `--admin` past a required gate.** The CLI offered
`--admin` on every one of four failed merge attempts for #659. Taking it would
have merged an auth change past branch protection to save ten minutes.

**Read the run, not the checks summary.** `gh pr checks` reported Release Guards
as `pending` on tabsii-platform#241 while `gh run view --json jobs` reported that
same job as `failure`. Waiting on the summary would have been waiting for a green
that was never coming. Two different views of one run disagreed, and only one of
them was true — when a check "hasn't finished" for an implausibly long time,
query the run's jobs directly.

**Carry a core release into a real instance before believing it.** Three defects
(#670, #671, #666) were found in a single afternoon by upgrading tabsii from
0.127.0, and none was findable upstream — the template always has `public.users`,
always has an empty write-back registry, and always resolves its CLI locally
rather than from npm. Template CI was green throughout while an instance could
not build at all.

**Diagnose to a single cause before fixing any of it.** Three CI steps failed on
tabsii-platform#241 with three different-looking symptoms — a release-subject
guard, an ownership guard, and a plugin-Terraform guard. Reproducing each one
locally showed all three were the same `ETARGET`: an unpublished CLI version.
Fixing them individually would have been three wrong fixes; the actual fix was
one changed version number.


**Diff the assembled artifact, not the source tree.** Relocating a domain under
ADR-0022 silently removed 21 generic-CRUD routes. The suite passed — 1712 green —
and *could not* have failed: every test imports its models directly, so
registration always precedes the assertion, and nothing built the app the way
`main.py` does and then inspected the result. Comparing `app.openapi()` against
the previous deployment was the only thing that saw it. Route-table diffing is
now the standing check for any relocation.

**Prove the test fails without the fix — including when the test is yours.** The
guard written for that ordering bug compared the app against a freshly-rebuilt
`build_core_crud_router()`, which returns zero routes on a second call. Its
expected set was empty, so it passed against the exact bug it existed to catch.
Reverting the fix and *watching the guard fail* was what exposed it; had the step
been skipped, a guard protecting nothing would have shipped described as
verification.

**Establish current state before closing, not just before coding.** #221 read as
finished. Checking it found two events still missing field metadata and — more
usefully — that the guard the issue credited with preventing that class of bug
does not exist in the tree. Closing on the issue's own summary would have
recorded a hole as solved.

**Close by the reported route.** #190 was closed on the evidence that
`uv export --frozen` yields `greenlet==3.5.3` while PyPI's current release is
`3.5.4` — the exact package and broken version from the original incident —
rather than on the weaker "the `--frozen` flag is present in the workflow".
**Drift guards fire on real changes, and that is them working.** Adding the
`agent_fan_in` action tripped `cli/src/lib/action-registry-sync.test.ts`, which
pins the exact action set so a new action cannot appear in `WORKFLOW_ACTIONS`
without appearing in `ACTION_HANDLERS`. The parity half already passed — the
guard's *other* half forced the addition to be acknowledged deliberately rather
than slipping in. The same session's manifest tests caught reserved columns and
route/permission mismatches before any deploy.

**Test the fakes against the real contract.** `biffo-plugin-idea-scout`'s
`test_ports.py` checks the HTTP adapter *and* the in-memory fake against the port
**and against each other**, because Protocol conformance permits extra optional
parameters — so both can satisfy the port while disagreeing, and the service
would then behave differently in tests than in production. A companion test
asserts the fake's canned agent output still validates against the real schema.
A fake that has drifted makes every test above it prove nothing.

**When responsibility moves, rewrite the tests rather than patching them.**
Moving the fan-in from the plugin to the engine broke 14 tests. The ones that
asserted *the plugin fires synthesis* were rewritten to assert *the plugin waits
for the engine and picks up what it created*, and the fake gained an explicit
`engine_fires_synthesis` helper so a test cannot accidentally do the engine's job
and pass for the wrong reason. Patching them to green would have preserved
coverage of behaviour that no longer exists.

**Verify the artifact, not the workflow.** After moving publishing to OIDC, the
green Publish CLI run was not the evidence — `npm view @biffo/cli version`
returning **0.133.3** was. A workflow can go green having published nothing;
these are different claims (see §6 of `biffo-verify`).

**Dry-run an install before letting it reach an apply.** `biffo plugin install
--dry-run` showed it would copy the plugin's `terraform/` into the instance —
which prompted reading that module, which showed it was the obsolete ADR-0018 §1
Lambda shape. Fixing it first (idea-scout#15) meant the install never created a
Lambda nothing invokes. That failure mode is the dangerous kind: it *applies
successfully*.

**Run the aggregate suite, not just the package's own.** `biffo-plugin-idea-scout`
was green on its own 171 tests throughout. Installing it broke **ideation's**
tests in two different ways, and neither is visible from inside either plugin.
The reproduction that mattered was `pytest services/ideation services/idea-scout`
— both together, which is the only configuration that actually ships.

**`terraform validate` as the acceptance test for generated infra.** The
install-only tree does not validate; the corrected one does. That single command
distinguished "the CLI wrote something plausible" from "the CLI wrote something
that works", and no test suite would have.

---

**Diff the assembled artifact after any relocation.** Moving a domain into the
ADR-0022 carve-out silently removed 21 generic-CRUD routes while 1712 tests
passed. Comparing `app.openapi()` against the previous deployment is the only
thing that saw it, and it caught the same class again two batches later. It is
now the standing check for a relocation, and it costs seconds.

**Establish current state before *closing*, not just before coding.** #221 read
as finished; checking found two events still undescribed and, more usefully, that
the guard the issue credited with preventing that class of bug does not exist.
The same habit applied one step earlier would have found #664 before #671 was
filed as its duplicate — the check that works for code works for the tracker.

**Say which side of a divergence is ahead.** `core diff` reports *that* a file
differs. Every useful decision — reconcile, backport, declare — depends on
*which way*, and that is one `diff` against a template worktree. Skipping it is
how a defect gets pinned as an intentional divergence.

---

**Mutation-test a guard before believing it, even when the change *is* the test.**
[#718](https://github.com/keiranholloway/biffo-template/pull/718) reclassified the
`biffo check` subcommands into "CI guards" and "out-of-band audits", and the suite
went 10/10 green. That proves the test passes, not that it defends anything. Four
deliberate mutations settled it: deleting a guard's `ci.yml` invocation **fails**,
renaming it **fails**, wiring the out-of-band audit in as a merge gate **fails**,
and adding a subcommand classified as neither **fails**. A fifth — renaming by
*suffix extension* — **passed**, which is the `toContain` gap now on the
scoreboard. Without mutating it, that gap and the four working cases are
indistinguishable: all five look like "10 tests green".

**Ask what a gate does when it cannot run, before quoting its green.**
`tabsii-intake`'s CI was declared green on the strength of two dependency audits
that had just gone from 20 findings to 0. Given [#591](https://github.com/keiranholloway/biffo-template/issues/591)
and the dash-`echo` fail-open inside its own fix ([#717](https://github.com/keiranholloway/biffo-template/pull/717)),
that green was worth checking rather than quoting. Both gates fail **closed**:
`pnpm audit` against an unreachable registry exits 1, `pip-audit` behind a dead
proxy exits 1, and — the one that actually mattered — a **typo'd `--ignore-vuln`
ID still reds the job**, so the ecdsa suppression cannot silently widen into
"ignore everything" through a fat finger. The claim survived the check, which is
the point: it was a claim that *could* have failed.

**Run the instance's migration chain against a real database before merging the
upgrade PR.** The 0.140.1→0.146.0 upgrade reported `0 conflicts` and its CI would
have gone green — the chain fails at *deploy*, not at test time. Applying it to a
scratch PostgreSQL 18 first produced `relation "users" does not exist` in about a
minute, before anything merged. Reading the migration would not have found it:
the failure depends on the instance's own history (tabsii dropped `public.users`
at its migration 0006), which no amount of staring at the template reveals.

**Ask what a green check would have been evidence *of*.** The upgrade's CI never
ran the chain against Postgres at all — SQLite in tests, and no migration step
before deploy. So "CI green" and "this upgrade applies" were never the same
claim, and treating them as one is how a red deploy gets merged deliberately.

**Grep the deployed artifact at the path it actually unpacks to.** Checking the
deployed Lambda for the async dry-run, `grep pkg/api/agent_dryrun_service.py`
returned nothing — because the bundle unpacks under `src/api/`. A bare
`grep -c` would have reported `0` and been read as "the deploy did not land",
sending the next hour into redeploying something that had shipped correctly.
Confirm the *path* resolves before trusting an empty result (the same trap as
`Never treat absence of evidence as evidence`).

**Prove a migration ran, not just that the deploy was green.** `Deploy
Application: success` says a workflow finished. `filter-log-events` on the live
core-api log group returned the two lines that actually matter — `Running upgrade
0011 -> 0010` and `0010 -> 0012` — which is the only evidence that the guarded
migration cleared the exact failure it was written for, **on the real database
that lacks `users`**. That is a stronger result than any test: the fix was proven
where the bug lived.

**A live click-through found four defects a green suite could not.** Idea Scout
had merged M1–M7 with 172 passing tests and was, in practice, completely
non-functional: `start_run` 401'd on every call. Nothing in the test suite could
have known — the adapter tests asserted against the module's own path constant,
so they passed whatever it said. **The unit tests and the production code agreed
with each other and both were wrong.** The first real click is what disagreed.

**Proving a test fails without the fix caught a vacuous assertion — twice.** The
build-types fix looked well-tested until the check was run properly: against the
pre-fix source, the *round-trip* test still passed, because Core stores unknown
keys and the value is dropped later, in the portal. Only the catalog test
actually discriminates. Shipping without checking would have left a test suite
that "covered" the fix while proving nothing about it.

**Refusing the convenient workaround.** The `agent_fan_in` fix could have been a
one-line `output_tools` key in the seed SQL — it works at runtime today. It was
rejected because the field was *undeclared*, so the portal's save path (which
keeps only declared fields) would silently drop it on the next edit, re-breaking
synthesis with nothing in the diff to explain why. Trading a visible bug for an
invisible one is a bad trade, and the temptation was strongest precisely because
the day was already long.

**Characterisation tests before a swap, not after.** Replacing `python-jose`
with PyJWT touched an auth verifier with **zero tests**. Eight tests were written
against the *existing* implementation and had to pass there first; the same eight,
unchanged, then had to pass on PyJWT. Written the other way round they would have
proved the new library works and said nothing about whether the two agree — which
is the only question a swap actually raises.

**A guard's first job is to fail its author.** `biffo check branch-protection`
caught, within seconds of existing, that the fix applied an hour earlier had
covered `dev` on three repos and left `staging` and `main` unprotected. A guard
that only ever agrees with the person who wrote it has not been tested.

**Verify an issue's premise before implementing its proposal.** #722 asked for a
CVE suppression in the sibling skeleton. Two greps showed the skeleton already
uses PyJWT and cannot hit that advisory, and that only two legacy siblings could
— so the proposed fix would have been dead config teaching future readers the
advisory was unavoidable. The issue was filed in good faith; nothing had checked
it.

**Read the run before repointing the gate.** Migrating intake's CI changes every
required-status-check name. Rather than predicting the four new names and
repointing branch protection to them, the PR was opened first and the names read
off its own run — which also surfaced that the new jobs *failed*, for reasons
that had nothing to do with the migration.

---

**Run the build, even when everything else is green.** marketplace's audit,
lint, typecheck and 26 tests all passed; `pnpm run build` failed outright. The
repo's own CI never builds, so nothing had contradicted the green. "All checks
passed" meant four checks passed, and the fifth did not exist.

**Prove a failure predates you before owning it.** The build broke right after a
dependency upgrade, which is exactly when it is tempting to assume cause. Stashing
the lockfile changes and rebuilding on the original `next` reproduced the failure
identically — turning "my upgrade broke the build" into "this build has been
broken and unwatched", which is a different issue with a different owner.

**Re-run the whole proof on the second repo, despite identical inputs.**
marketplace's `auth.py` was byte-identical to intake's pre-swap file, so copying
the proven implementation was safe. Re-running the 8 characterisation tests
against *marketplace's* `python-jose` first was still the right call: identical
source does not mean identical settings, dependencies or test environment, and
the cost of confirming was seconds.

---

**Diffing an old commit against `dev` before writing.** The intent was to append this session's rows. Reading the file first showed the count had gone *down* — 65 rows to 57 — which is the only reason the deletion of three sessions' contributions was found. Nothing else would have surfaced it: every commit is present, the page reads fine, and the counts on it had simply become smaller.

**Testing the destructive path, not just the happy one.** `mergeExtracted` had three unit tests, all covering rows the markdown still mentions. The one case nobody wrote — a stored row the markdown *doesn't* mention — was the one deleting the data. Both new tests fail against the old implementation.

**Re-checking a settings change instead of trusting the click.** The npm trusted-publisher form was filled and submitted; re-loading the page showed it had reset to "Select your publisher". Reporting it as done would have left the next release failing with an unexplained 404.

**Rendering the CSS locally before shipping it.** The Idea Scout stylesheet was checked against a static harness built from the real components, so the first deploy confirmed the result rather than discovering it.

**Asking "did it actually publish?" rather than "is it configured?".** Registering the trusted publisher was necessary and looked like the last step; the package would still never have published again. Only checking for an actual run — three tags, zero runs — found that the trigger could not fire. A configuration screenshot is not a release.

**§1 stopped a whole file being written twice.** The task was "add Postgres RLS
coverage for the new tables". Checking current state first found
[#277](https://github.com/tabsii-com/tabsii-platform/pull/277) had landed a
non-superuser RLS harness hours earlier — the exact provisioning, DSN-rewriting
and guard-the-guard machinery about to be built from scratch, including two
hard-won details (`render_as_string(hide_password=False)`, and granting
`user_role_assignments.read` so the boundary is the variable) that would each
have cost a CI cycle to rediscover. `saved ~40m`, and the new file reuses the
harness with attribution rather than competing with it.

**Verifying by the user's route caught what both suites missed.** `lead.stage_changed`
had unit tests, a green CI run and a successful deploy. Moving a lead in the
deployed CRM returned `{"detail":"Not Found"}` — the sibling proxy was missing.
No amount of test-suite green would have surfaced it, because the component tests
mock the client and the platform tests never involve the sibling. AGENTS.md §4's
"a passing unit test is not evidence" is the whole finding, and it cost 20 minutes
rather than a user reporting it.

**Testing against a real session rather than a fake found four latent defects.**
Writing M5's tests against an in-memory database — instead of a fake answering
queries in order — surfaced untyped UUID binds, an untyped `Decimal`, timestamps
assumed to be `datetime`, and an id left to a column default. A fake would have
asserted the endpoint's *shape* and proved nothing about the SQL. The rule that
generalises: when an endpoint's behaviour **is** its query, a fake tests the test.

## What needs more thought

**The recurring mechanism is not carelessness — it is `catch the error, log it,
carry on`.** This page reads like a long list of unrelated mistakes. It is not.
Look at what the failures share rather than what broke:

| Where | The swallow | What it hid |
| --- | --- | --- |
| `practices-daily.sh` | `git rebase … \|\| { echo …; abort; }` | a 45-commit-stale collector computing the daily numbers from superseded definitions |
| same file, next step | `NUDGE="$(node … \|\| true)"` | `MODULE_NOT_FOUND` on every run, for weeks |
| same file, latent | `[ -f "$EFFORT" ] && cp …` under `set -e` | would abort the job *after* the push — reporting failure for work that landed |
| `GitAdapter.push` | no `-u` (an omission, not a catch) | 190 undetectable branches |
| dependency audits ([#591](https://github.com/keiranholloway/biffo-template/issues/591)) | non-zero on "couldn't parse" is identical to non-zero on "found a vulnerability" | a registry hiccup reds every PR; a real finding looks the same |
| CDN ([#647](https://github.com/keiranholloway/biffo-template/issues/647)) | 403/404 rewritten to `200` + portal HTML | every backend failure read as a client-side JSON parse error |

Nine rows here are classed `fail-open` and eighteen `visibility`. They are largely
the same mechanism from two angles: **something continued after it should have
stopped, and nothing downstream could tell.**

Each individual fix is cheap. What is missing is a convention, and it is one
sentence: **when you catch an error and continue, you must be able to say what
the next step will do with wrong input.** If the answer is "produce a plausible
result", it was never a recoverable error — it is a fatal one wearing a log line.
`practices-daily.sh` now exits non-zero at that point and explains why, because
every step after it writes numbers that look correct and are not.

This reframing matters for how the page is read. The error *rate* is not
obviously high against several hundred merges a week. The **detection** rate is
the problem — and that is a design property, not a diligence one, which is why
"be more careful" has never moved it and a `-X theirs` plus an `exit 1` will.

**Reading something in motion, and reporting its state as settled — twice in one
session.** Both were mine, and both reached the user as fact:

1. A primary checkout parked on a merged upgrade branch was read for an
   instance's core version. Reported `0.136.0`; the answer was `0.146.2`.
2. The daily job was inspected **mid-run** and reported as "persisting nothing,
   dashboard 17 hours stale". It finished three minutes later, having pushed the
   snapshot and rendered the page. The real defect was different — and worse —
   than the one announced.

Same shape both times: **a single observation of a moving target, presented as
its outcome.** `biffo-verify` §4 covers deployed artifacts, §1 covers the issue's
state; neither says *check whether what you are looking at has finished, or is
what you assume it is*. Two cheap habits cover both: read instance state from
`origin/<branch>` rather than a working tree, and before reporting on a job,
check whether its process is still running.

**Nothing reconciles an open issue against shipped code, and the one mechanism
that should fails silently.** Three of ten open tabsii issues were complete. One
of them — tabsii-crm#100 — had its PR merged to the default branch two days
earlier with `closes tabsii-crm#100` in the body; that ref is repo-qualified but
**owner-less**, which GitHub does not treat as a closing keyword, so nothing
fired and nothing complained. But the closing keyword is only the proximate
cause: the other two issues had no such PR and would have stayed open regardless.
The backlog drifts from the code in one direction only — toward *overstating*
remaining work — and the cost is paid by whoever plans from it.

**A `Core-Divergence:` trailer is doing two incompatible jobs.** It means "this
instance must differ from a template file", and the divergence ledger exists so
that difference can be audited and eventually converged. It is also the *only*
way to add a file the template has no counterpart for — an instance-specific CI
lane — where there is nothing to converge toward and the entry will sit in the
ledger for ever. Both look identical to anyone auditing it later. `*.instance.yml`
(biffo-template#755) would separate them, but the general question is bigger:
every template-owned prefix with a legitimate instance-authored file inside it has
this problem, and `.github/` is just the one that surfaced.

**The `steps.install.outcome` idiom teaches a wrong lesson by example.**
`ci.yml`'s gate is correct *for `ci.yml`*, where dependency install is the only
prerequisite — and its comment explains the reasoning well enough that copying it
feels like following the convention. In a job with a second prerequisite it fails
open, and the resulting error names the wrong component entirely (28 errors about
a missing table, from a step that should never have run). The convention needs to
be stated as "gate each step on its own prerequisite", not "gate on install".

**The local development environment cannot run the thing being tested, and this
is now load-bearing.** `biffo-verify` §2 and §3 both assume you can reproduce
locally. For anything touching Postgres — which is the entire RLS layer, every
DDL-imported function, and #76's staging/prod work — that is currently false on
this machine: no `docker` group membership, no passwordless `sudo`, a stopped
cluster and no PostGIS. Every hypothesis costs a CI round trip on a scale-to-zero
fleet. This will get worse as more RLS-dependent work lands on the lane just
built, and it is a one-off setup cost against an unbounded stream of round trips.
**Asking "who else writes this file?" caught a feature that would have erased its
own state.** [#735](https://github.com/keiranholloway/biffo-template/issues/735)
adds `declinedMigrations` to `biffo.core.json`. That file is read *during* an
upgrade and rewritten *by the same upgrade* — and `writeInstanceCoreVersion`
serialised `{ version }` and nothing else. The declines would have survived
**exactly zero upgrades**, silently, while the file looked like the feature
worked: the very bug #735 exists to fix, reintroduced one layer down and much
harder to see. Nothing in the issue, the tests, or the review would have surfaced
it; the question that did was "what else touches this file?" asked before writing
the schema.

**A negative control distinguished a guard from a decoration, twice in one
sprint.** For [#696](https://github.com/keiranholloway/biffo-template/issues/696)
a single stray `console.log` before the payload failed all four `--json` tests —
proving the "stdout carries only the document" assertion is load-bearing rather
than incidentally true. For
[#735](https://github.com/keiranholloway/biffo-template/issues/735), neutralising
the decline lookup reproduced the reported plan *exactly*
(`['0010_orgs.py', '0012_agent.py']` where `['0012_agent.py']` was expected). §3
costs about two minutes per fix and is the only thing that separates these from
the vacuous guards this page has now logged four times.

**Pre-registering before the intervention paid off precisely when the
intervention turned out to be impossible.** H2 was written and committed, and
*then* the merge queue was found to be unavailable. Because the prediction
already existed, the outcome is a recorded constraint with evidence
(`H2-merge-queue.md`) instead of a decision quietly re-narrated as "we looked at
a merge queue and decided against it". The discipline's value is usually argued
for the case where results are disappointing; this is the case where the
experiment cannot run at all, and it holds there too.

**Nothing verifies that the checkout you are measuring is the tree you think it
is.** `biffo-verify` §4 says verify the *deployed artifact* rather than the
source, and §1 says establish the state of the *issue* first. Neither covers the
step between them: confirming the working tree in front of you is on the branch
and commit you assume. A primary checkout parked on a merged upgrade branch, ten
commits behind `dev`, was read for an instance's core version and migration
state — and produced figures that were wrong in a direction that looked
plausible (0.136.0 instead of 0.146.2, a migration missing a guard it already
had). Those went into a PR description and a user-facing summary before
`git show origin/dev:<path>` disproved them.

The cheap habit that would have caught it: **read instance state from
`origin/<branch>`, never from the working tree**, unless you have just confirmed
what the working tree is on. It costs one `git show` and removes a whole class of
confidently-wrong measurement. AGENTS.md §2 already warns that a parked primary
"is how an audit gets run against dead code" — that warning is prose with nothing
enforcing it, which is exactly the gap [#758](https://github.com/keiranholloway/biffo-template/issues/758)
proposes closing with a hygiene check.

**A one-line omission can make a whole class of debris undetectable.** The
missing `-u` in `core upgrade`'s push is not a bug in any observable behaviour —
the push works, the PR opens, the merge lands. Its only effect is that the
leftover branch is invisible to *both* standard staleness checks simultaneously,
which is why 190 of them accumulated without anyone noticing a problem to fix.
Worth asking of other tooling: **not "does this work?" but "does this leave
anything behind, and would the normal way of noticing find it?"**

**H3 has one green data point and it means nothing yet.** `strict` came off
`biffo-template` hours ago and one `dev` CI run has passed since. The
counter-metric (`integration.failures` on `dev`) is the entire risk of that
change, and it needs the full window to 2026-08-11 with ≥50 merges. The temptation
to read an early quiet period as confirmation is exactly what the pre-registered
review date exists to resist — recorded here so it is on the page before the
number is.

**Guards that read a path can fail open, and nothing distinguishes that from
passing.** `auditSkeleton` returning `[]` means either "no violations" or "that
directory does not exist". The fix here was to assert the tree exists before
auditing, but the same shape is available to every guard that walks a path —
including ones already shipped. Worth a convention: **a guard that finds nothing
to check must say so, not pass.**

**A skeleton is only exercised when someone scaffolds from it.** #744 closes the
specific case for two rules, but the general problem stands for anything
`_skeletons/` contains that no test reads. The rules that exist are the ones
whose violation was already observed to break something — which means the guard
can only ever be as good as the last incident.

**Three months of fixes have never been propagated backwards.** Every skeleton
fix lands for repos created *after* it. `biffo check branch-protection --fix`
(#740) is the first mechanism that touches an already-created repo, and it
covers one setting. Nothing carries #649/#650/#651 into the two plugin repos
that predate them, and nothing knows which satellites are behind.


**Fail-open is our default, and it should not be.** Three separate gates passed
when they could not run. There is no shared convention for "inconclusive" — each
author invents one. A documented pattern (and a helper) for gates that must
distinguish *couldn't check* from *checked and clean* would prevent the next one.

**Nothing checks two ADRs for collision.** ADR-0003 mounts plugin routes at
`/api/v1/plugins/<plugin>/<path>`; ADR-0021 gives the plugin host
`ANY /api/v1/plugins/{proxy+}`. Both were accepted, and the conflict only surfaced
when a plugin used a feature ADR-0003 promised. Only `ideation` declares
`api_routes`, so **the feature has likely never worked in a deployed instance**.
Worth asking of any ADR: what existing path/prefix/resource does this claim, and
who else claims it?

**We cannot inspect what a green check did.** CI logs are not retained for the
self-hosted runs, so verifying whether an audit step actually audited required
reproducing it locally. Cheap to fix, disproportionate payoff.

**A core version can be tagged but not installable, and nothing notices.**
`core-tag.yml` tags on merge; `publish-cli.yml` publishes on the tag. When the
publish fails, the tag survives and the version looks real. Every instance guard
then execs `npx @biffo/cli@<its pinned version>`, so an instance that upgrades
into the hole cannot pass its own CI — and the upgrade PR's own version bump is
what breaks its own guards, making it unfixable from inside. 0.131.0 and 0.132.0
are currently in exactly that state (#671). The version line should not be
allowed to contain a hole: either the tag should be conditional on a successful
publish, or something should assert that every `core-v*` tag resolves on npm.

**The template cannot reproduce an instance's column types, and that is now a
repeated root cause rather than a one-off.** Three write-back defects in one
afternoon were the same assumption — Core's ids and tenants are `String(36)`,
an instance's are real `UUID`s. SQLite has no UUID type, so the template suite
cannot see it; asyncpg coerces strings silently, so a PostgreSQL *happy path*
cannot either. It only surfaced where a UUID met a JSON column and a bind. A
fixture that runs some of the suite against PostgreSQL with UUID-keyed tables
would have caught all three before they shipped.

**A recorded failure that lies is worse than one that crashes.** Two of those
three were caught by the executor's own error handling and written to the audit
log as *"the database refused the write for the workflow's owner"* — the exact
wording of the legitimate case the feature exists to make visible. On dev it read
as the feature working. Any handler that converts an exception into a
domain-level explanation needs to distinguish *the domain reason* from *anything
else*, or it manufactures false evidence.

**Template-owned tests can assert properties only the template has.** Two write
-back tests asserted an empty registry and an ambient identity provider. Both are
true upstream forever and false in every instance, so they were green in template
CI and red on arrival (#666). The general shape — *is this asserting the contract,
or asserting my own environment?* — has no check behind it, and the only thing
that found it was a real distribution.

**A registry populated by import side effects has no test isolation story.**
Instances register scope resolvers, authorizers, write-back targets and identity
providers at module-import time, last-write-wins. That is a good pattern for
production and a hostile one for tests: a fixture that sets a global can be
silently undone by an unrelated module's import, which is precisely what made
14 tests pass in isolation and fail in a full suite. Patching the name in the
*consuming* module worked, but that is a workaround each test has to know to
apply rather than a property of the registries.

**Unit-green is routinely mistaken for working.** AGENTS.md §4 already says this,
citing #275. It recurred: #659's tests prove `require_principal` in isolation, and
prove nothing about a deployed request, because no route uses it yet. The habit
worth building is stating what was *not* verified, in the PR, every time.

**A preview that contradicts the operation it previews is worse than no preview.**
`core diff` said five instance files would be `removed`; `core upgrade` deletes
none of them. The safe command was right and the *preview* cried wolf — which
trains people either to distrust previews or to skip them, and both are worse
than the status quo. Any tool whose job is "show what will happen" must share a
classifier with the thing that makes it happen (#689).

**A stale local checkout silently produced a wrong diff.** The first `core diff`
run compared against a template tree missing the just-merged host commit and
reported *no host changes at all*. It was caught only because the absence looked
implausible. AGENTS.md §1 already warns about auditing dead code; the gap is that
nothing in the tooling notices — a diff against a stale tree looks exactly like a
diff against a current one. Worth having `core diff`/`core upgrade` state the
template commit they resolved, so the input is visible in the output.

**Escalating an unverified tool output cost more than the bug.** The false
`removed (5)` reading produced: a halted deploy, an incorrectly-titled issue, a
proposed manual copy-in that turned out to be blocked by design, and real alarm
for the user — all before anyone ran the thirty-second dry run. The lesson is not
"be more careful"; it is that **a claim about destructive behaviour should be
tested before it is reported**, at the same bar as a claim that something is
fixed.

**Deactivation coverage is still unproven end to end.** #655 fixes the gap at the
dependency level with tests. Nobody has suspended a real Cognito user in `dev` and
replayed a plugin-forwarded call. Until that happens, #621 should not close.

**Confidently wrong diagnostics are worse than none.** The publish failure
reporter existed precisely so a release failure would explain itself, and it
explained itself *incorrectly* — "mint a fresh automation token, re-dispatch if
transient" when the token was gone and the failure was permanent. Three
re-dispatches followed. A reporter that had said "I do not recognise this" would
have cost less. Worth asking of any diagnostic: **what does it say when it is
wrong, and how would the reader tell?**

**No credential in the pipeline knows it has a lifetime.** The npm token was
issued with a 7-day expiry and nothing — not the workflow, not a dashboard, not
an alert — surfaced that before it expired mid-session. Trusted publishing
removes this one, but any remaining long-lived credential has the same shape.
Worth an audit for other short-expiry tokens, and for the general case: a
pipeline should be able to say when its own credentials die.

**The release pipeline is a single point of failure for repos that never publish.**
An expired npm token stopped instance upgrades from being *committed*, because
the ownership guard resolves the published CLI (#667/#671). That coupling is
invisible from any one repo: nothing in `biffo-platform` says "this repo cannot
merge if npm is behind".

**Cross-repo features have no first-class plan.** Idea Scout spanned six repos
with real ordering constraints between them — Core seam before deploy, engine
before rewire. A milestone list caught the dependencies because someone wrote
them down; nothing enforces or even represents them. The failure mode is not
dramatic, it is a half-landed feature nobody can see the shape of.

**Nothing tests the skeleton with a second occupant.** Five failure conditions
this session came from installing a *second* plugin next to the first, and all
of them broke the incumbent. A scaffolding test that generates two plugins and
runs them together would have caught every one — cheaply, and before either
reached an instance.

**A workaround that only the newcomer pays is not a fix.** Idea Scout now loads
its scripts by path and prefixes every test file. Both work; both are the second
plugin absorbing a cost the skeleton created, and the *third* plugin will pay it
again from scratch. Worth distinguishing, when logging a workaround, between
"contained" and "deferred onto whoever is next".

**"What happens when nobody is watching?" belongs in planning.** The
owner-scoped-write constraint (no autonomous write path) is correct security
design and was documented; it simply was not asked about while a feature
specified as "runs weekly" was being designed. That question would have moved a
platform decision from mid-build to pre-build.

---

**The template's seams are first exercised by an instance, and that is the test.**
ADR-0022's discovery order, the ownership guard's coverage, and the event
registry's field metadata were all green in `biffo-template` and all broke on
first real instance use. There is no integration environment where a template
change is applied to a realistic instance before release; `biffo core upgrade`
into a live repo is currently that environment, which is why instances keep
paying for template defects.

**Declaring divergence has no coverage check.** `biffo.divergence.json` records
*why* a file diverges, and the guard reads it — but nothing compares the declared
set against the actually-divergent set. Five files sat undeclared across a whole
core upgrade, hard-blocking edits with no recorded reason and invisible to every
gate. An instance can build a ratchet for this (tabsii did), but each one has to
invent it; `core diff` already knows the answer and could emit it.

**`biffo core diff` has no machine-readable output.** Everything that consumes it
hand-parses prose. A parse that drops a line under-reports divergence and looks
authoritative doing it — one here reported 4 undeclared files when the answer was
5, caught only because the section header carried its own count. A `--json` mode
would remove the whole class.

**Trailer length is an unwritten constraint.** `Core-Divergence:`/`Core-Convergence:`
must be a single line for the guard's anchored regex, and commitlint caps footer
lines at 100 characters. The two rules are individually documented and jointly
undocumented, so the first attempt at any non-trivial reason is rejected after
the hooks have already run.

---

**Instance CI is 2–3× slower than the template's, and nobody owns that number.**
`biffo-template` CI is ~2.5 min; `tabsii-platform` is 6–8 min, plus 6–12 min to
deploy. Every instance-side change pays that, and the six-hop loop above pays it
twice. Nothing tracks it, so it drifts upward unnoticed.

**A repo-settings fix applied to two of three repos is not applied.** Auto-merge
and branch reaping were enabled on `biffo-template` and `biffo-platform` and
recorded here as *fixed*. `tabsii-platform` was missed, so the row overstates the
remedy and the third repo kept paying the original cost for a full session. Any
settings change needs an explicit inventory of the repos it must reach.

**Nothing prompts a search before filing an issue.** Two issues described one npm
outage. The cost is small in isolation and compounds: a duplicate splits the
evidence, and closing one leaves the other quietly asserting a resolved problem
is still open.

---

**The branch-protection audit cannot see the failure that motivated it.**
[#718](https://github.com/keiranholloway/biffo-template/pull/718) deliberately
asserts protection *properties* — something required, strict, no force-push, no
deletion — and explicitly **not** a canonical list of required contexts. That
decision is well argued and correct: repos legitimately run different jobs, and
asserting a fixed list would force identical CI everywhere or demand a context
that never reports. But it means the audit reports `tabsii-intake` as **OK**
while nine of its eleven required contexts were dead names that no workflow had
produced for weeks — the exact state that blocks every PR forever. "Something is
required" and "the required things can actually report" are different properties,
and only the first is checked. The second is testable without a canonical list:
intersect each branch's required contexts with the job names its own workflows
emit, and flag the difference.

**A workflow rename is a two-repo change that nothing couples.** Renaming a CI
job is a one-line edit that silently invalidates branch protection in a different
system, with no failure until the next PR sits `BLOCKED` on a context that will
never arrive. `tabsii-intake#9` predicted this in its own PR body and still could
not act on it before merging, because the new job names only exist once the new
workflow has run. That ordering is inherent, so the fix is not discipline — it is
either a post-merge step that repoints protection from the run that just
completed, or a check that fails the PR when the two sets diverge.

**A declined migration has nowhere to live.** tabsii's decision not to take
migration 0010 was recorded in a docstring, which is the only place it could go.
`biffo core upgrade` cannot read prose, so it re-proposed the migration and
produced a chain that fails at deploy — while reporting `0 conflicts`. The
instance now re-litigates the same decision on every upgrade, and the reviewer
has to remember a call made weeks earlier about a file the diff makes look new.
Filed as [#735](https://github.com/keiranholloway/biffo-template/issues/735);
the shape of the gap is that **instance-specific decisions have no durable home**
in the manifest that describes the instance.

**The template cannot test the thing that breaks instances, and this round
proved it twice in one afternoon.** Migration 0010 assumed `public.users` because
the template always has it. The *test written to catch that class of bug* then
assumed 0010 revises `0009`, because in the template it does. Both were green in
`biffo-template` and both failed on first contact with an instance. Care did not
prevent the second one — the same person had just fixed the first. What is
missing is a way to run template-owned migrations and tests against a
*representative instance chain* in the template's own CI; until that exists, this
class is found by shipping.

**Nothing tests a plugin's pipeline below a live click.** Fan-out → fan-in →
synthesis → projection has no harness. Every one of the four defects found on
2026-07-27 was reachable only by clicking a deployed instance, and each cost a
full ~40-minute round trip to reach. A harness running the real chain against
stub agents would have collapsed four traversals into one failing local run.
This is the single highest-value gap on the page right now.

**Three defects in one day were the same shape: the prompt names a capability
the run does not offer.** A tool gated on an unset credential is dropped with a
warning; an output tool that cannot be declared is simply absent; a path that
resolves to the wrong service authenticates differently. All three **fail open,
mid-chain, after spend**, and surface as a vague user-facing error. A preflight
assertion that every capability a run depends on actually resolves — before the
first paid model call — would have caught all three at once
([#729](https://github.com/keiranholloway/biffo-template/issues/729)). Nothing
currently owns "does this run's declared world exist?".

**A feature can be declared done seven milestones deep without ever being run.**
M1–M7 merged, deployed and were reported complete; the handover even recorded
"nothing has run against a real deployment" as a known gap — and that gap was not
treated as blocking. The process has no step that says *a feature is not done
until someone has used it*. The handover document was honest and it still did not
stop the milestone being closed.

**`biffo check branch-protection` exists and is scheduled nowhere.** It was built
precisely to catch settings drift, and two plugin repos were sitting completely
unprotected while it existed. A guard nobody runs is indistinguishable from one
that was never written.

**The instance vendors plugin source, and nothing notices when they diverge.**
`dev.biffo.io` serves `services/<plugin>/`, not the plugin repo, so a merged
plugin fix is live nowhere until a second resync PR lands. Three were needed this
session. The failure mode is silent and reads exactly like "the fix didn't work".

**A tool behaving oddly is evidence about the tool, not just an obstacle.** Two
separate `gh` commands misbehaved — one erroring on a deprecated API field, one
silently printing help and exiting 0 — and both were routed around with a
workaround rather than diagnosed. The cause was a package 7 months stale, which
one `gh --version` would have exposed. The workarounds were even *written into a
subagent's brief*, propagating the symptom instead of removing it. Worth asking,
the second time a tool surprises you: **is this tool the version I think it is?**

**`gh` misreports during the check-registration window, in both directions.**
`gh pr merge --auto` says *"Pull request is in clean status"* and `gh pr checks`
says *"no checks reported"* — both before runs register, neither distinguishable
from the real state. One invites merging unverified code; the other mimics the
genuine "GitHub created no run" case that AGENTS.md §6 says never to paper over.
Every agent here will hit both, and the current answer is "sleep and re-check",
which is a habit rather than a fix.

**Nothing audits repo settings drift on a schedule.** `biffo check
branch-protection` now exists, but nothing runs it. The condition it detects took
three weeks to notice by accident; a weekly job over the managed repos would have
found it on day one. Shipping the detector without scheduling it is half a fix.

**An issue can be wrong and still be actioned.** #722 would have been implemented
as written by anyone who trusted it — the reasoning was plausible and the author
was careful. There is no cheap norm here for "state the premise you checked" when
filing, and the cost lands on whoever picks the issue up.

**One repo still carries the dead dependency.** `tabsii-marketplace` declares
`python-jose` and will hit the same unfixable `ecdsa` advisory the moment its
pip-audit runs. It is known, unfiled, and exactly the shape of thing that gets
rediscovered expensively.

---

**A remediation found once has to be found again per repo.** The
`pnpm.overrides` block that clears `postcss`/`sharp`/`brace-expansion` now exists
in two sibling `package.json` files, copied by hand, with nothing linking them.
The third sibling to hit it will rediscover it. Siblings share a skeleton but not
a dependency policy.

**"Is this repo on the current CI?" has no reliable answer.** Job names are the
only thing anyone compares, and they match across generations while steps differ.
marketplace looked migrated and was a generation behind on the one step that
mattered. A workflow-drift check against the skeleton would be cheap and would
have caught it before the build defect became load-bearing.

**Green-by-absence is indistinguishable from green.** Two repos had no CI run for
three weeks and neither surfaced as unhealthy — a branch with no failing run looks
exactly like a branch that passed. Both were found by accident, hours apart, while
looking for something else.

---

**Nothing prevents a whole-file rewrite from a stale base.** This is the largest content loss recorded here and it was invisible: no conflict, no failing check, no reviewer signal. Tools that rewrite a file wholesale — a script, a full-file write — turn "my branch is slightly behind" into "I silently replaced everyone else's work". A row-count floor in CI, or an append-only convention for this file, would catch it. Neither exists.

**Relaxing `strict` traded a known cost for an unmeasured one.** H3 removed the rebase race, which was real and expensive. It also removed the only mechanism forcing a branch up to date before merge — the thing that would have turned the loss above into a conflict. H3 measures merge friction and does not watch content loss, so a recurrence before 2026-08-11 will not appear in its result.

**The advice to "regenerate from the data, not the prose" carried the loss.** This page is explicit that prose counts drift and `evidence.jsonl` is the antidote. But `--extract` rebuilds the dataset *from the prose*, so a markdown that had already lost rows produced a dataset that lost them too — and the regenerated counts then looked authoritative. Fixed in code; the shape (a derived artefact treated as a source of truth) is worth looking for elsewhere.

**A first npm publish has no credential-free path.** Trusted publishing is the right end state and cannot bootstrap itself, so every new package needs one manual, 2FA-bearing publish by a human. That is precisely the step a fleet of agents cannot perform, and it recurs for every future `@biffo/*` package.

**A fix for a known trap was written for one caller, not the class.** The `GITHUB_TOKEN`-suppresses-events gap was understood, documented at length in `core-tag.yml`, and fixed — for the CLI. The next workflow to hit the identical trap got no help from any of that, because the fix was a name rather than a rule. Worth asking of other one-caller fixes on this page: is it a rule, or is it one name?

**Keeping orphaned rows trades a silent deletion for a silent duplicate.** `mergeExtracted` now preserves a stored row the markdown no longer mentions, which stopped three sessions' work disappearing. The cost showed up immediately: *rewording* a scoreboard row leaves the old wording behind as a second dataset entry, so counts inflate until someone prunes it. One appeared within a day (an added `*also*` was enough), and only the new warning surfaced it. The warning is doing its job, but "reword a row" is a normal edit and should not need a manual prune — matching on a stable row id rather than the summary text would fix it properly.

**A feature's safety argument outran its test coverage by five milestones.**
ADR-0027's case for agent write-back is that the write runs on the author's RLS
session, so PostgreSQL re-evaluates their authority. Two targets, four merged
PRs and a live agent-written row later, **nothing had ever exercised those
policies** — the SQLite suite has no RLS, and the one Postgres lane ran as the
schema owner, which carries `BYPASSRLS`. The claim was load-bearing in three
docstrings and was true only by inspection of a SQL file. What is missing is a
rule that a *security* argument names the test that demonstrates it, at the time
it is written.

**The builder gates enabling on a test that cannot exercise the feature.** #749
is filed, but the shape is worth naming separately: a required gate that runs a
*different* code path from the thing it gates is worse than no gate, because it
converts "unverified" into "verified" in the author's mind. The dry run omits
`writeback` and `tools` from its snapshot, so precisely the two configurations
with side effects are the two it cannot test.

**Nothing checks that a sibling proxies the core routes its frontend calls.**
The 404 above was found by hand. Both repos were internally consistent; the
defect existed only in the gap between them, and no gate looks at that gap. A
generated check — every `/api/v1/...` string in the sibling's frontend resolves
to a route in the sibling's own OpenAPI — would have caught it in CI.

## Skills used

Skills cannot be iterated on impressions. Every invocation, with an honest outcome.

| Skill | Outcome | Detail |
| --- | --- | --- |
| `claude-in-chrome` | **worked** | The only thing that could close #652. `curl` returned clean `401` JSON at every stage; the failure was visible only in an authenticated session, and then only in the *network* panel — the rendered page showed "No catalog entries yet" over an HTTP 500. Without it the issue would have been closed on a screenshot. |
| `biffo-verify` | **worked** | §3 caught the vacuous drift guard (above). §1 turned #722 into a close-with-evidence and stopped #652 being reimplemented. |
| `biffo-verify` | **partial** | §8's "Skills used" and repo tally were done at the *end* of a long session, from memory, and the class counts were typed rather than regenerated — producing wrong numbers that the tool then corrected. The section warns about exactly this two paragraphs earlier. The step should say: run `--report` and paste, never type. |
| `biffo-add-service` | **failed** (as found) | Described Steps 7–8 as manual work that `biffo deploy` had automated 3.5 weeks earlier (#337), the Step 1 pre-flight as missing when it exists (#151/#306), and the concurrency guard as unmerged (#145). Following it would have caused ~40 min of already-automated work and could have conflicted with what the tool writes. Corrected, and renamed to match intent. |
| `biffo-workflow` | **worked** | Seven changes across two repos, start → merged → worktree reaped. The honest-push and remote-verify steps mattered once: a rebase onto a mid-flight core upgrade needed `--force-with-lease` and re-verification, and the step's insistence on re-checking the remote caught that the PR body's numbers were now stale. |
| `biffo-workflow` | **partial** | Step 3's commit example does not mention that a `Core-Divergence:`/`Core-Convergence:` trailer must fit commitlint's 100-character footer limit *and* stay on one line for the guard's anchored regex. Two commits were rejected after the hooks had run. Worth one line in the step. |
| `biffo-verify` | **worked** | §3 ("prove the test fails without the fix") caught a guard that passed against the bug it was written for, because its expected set was empty. Nothing else in the process would have found it — the test was green, the code was correct, and the assertion was vacuous. |
| `biffo-verify` | **should have been invoked sooner** | It was loaded at batch 4 of a five-batch relocation. Batch 3 is where 21 routes silently disappeared; the route-diff that caught them was improvised rather than prompted. The trigger wording is debugging-shaped ("investigating a bug", "green but broken"), so a *refactor* with a silent-regression risk does not read as a match. Worth adding refactors and relocations to the trigger list. |
| `biffo-workflow` | **partial** | Step 7 (`gh pr merge --squash`) assumes you can win the up-to-date race. `dev` was taking a merge every 3–5 min against a ~2.5 min CI cycle, so the branch was `BEHIND` on every attempt and **four rebases lost it**. The real fix was a repo setting (auto-merge), not a rebase. The step should offer an auto-merge path. |
| `claude-in-chrome` | **worked** | The only thing that reproduced the reported bug. `curl` returned clean `401` JSON and looked healthy — the HTML only appears on an *authenticated* request, because 401 passes the CDN untouched while 403/404 are rewritten. An unauthenticated check would have concluded "works fine" and #647 would still be unfound. |
| `biffo-verify` | **partial** | §1 caught that the planned #621 step 3 would have collapsed ADR-0014 §7's two-axis authorization boundary — a real save. But it was **not applied to its own author's output**: `core diff`'s `removed (5)` was reported to the user as fact without the dry run that disproves it in seconds. The step exists and was skipped. |
| `claude-in-chrome` | **worked** | The only thing that could close #652. `curl` returned clean `401` JSON at every stage; the failure was visible only in an authenticated session, and then only in the *network* panel — the rendered page showed "No catalog entries yet" over an HTTP 500. Without it the issue would have been closed on a screenshot. |
| `biffo-verify` | **worked** | §3 caught the vacuous drift guard (above). §1 turned #722 into a close-with-evidence and stopped #652 being reimplemented. |
| `biffo-verify` | **partial** | §8's "Skills used" and repo tally were done at the *end* of a long session, from memory, and the class counts were typed rather than regenerated — producing wrong numbers that the tool then corrected. The section warns about exactly this two paragraphs earlier. The step should say: run `--report` and paste, never type. |
| `biffo-add-service` | **failed** (as found) | Described Steps 7–8 as manual work that `biffo deploy` had automated 3.5 weeks earlier (#337), the Step 1 pre-flight as missing when it exists (#151/#306), and the concurrency guard as unmerged (#145). Following it would have caused ~40 min of already-automated work and could have conflicted with what the tool writes. Corrected, and renamed to match intent. |
| `biffo-workflow` | **worked** | Nine changes across three repos, start → merged → worktree reaped. Its honest-push and remote-verify steps earned their place twice: once when a rebase onto a mid-flight core upgrade needed re-verification, and once when a **blocked commit still produced `push exit 0`** — the branch existed on the remote carrying none of the work. Only `git log origin/<branch>` showed it. |
| `biffo-workflow` | **partial** | Step 7 assumes you merge by hand. Where the repo allows auto-merge that is wasted watching; where it does not it is unavoidable — `tabsii-platform` had it off and that cost ~2¼ hours this session, since fixed. The step should say: enable auto-merge, use it, and treat a repo without it as a defect to fix rather than a cadence to absorb. |
| `biffo-verify` | **worked** | §3 caught **two** vacuous guards — one whose expected set was empty because `build_core_crud_router()` returns zero on a second call ([#695](https://github.com/keiranholloway/biffo-template/issues/695)), one that asserted a path existed when a hand-written route kept it alive regardless. Both were green, both protected nothing. Reverting the fix and watching the guard fail is the only step that distinguishes those from a real guard. |
| `biffo-verify` | **worked** | §1 and §7 changed two outcomes: #221 was closed on evidence rather than its own summary (finding a guard it credited does not exist), and #190 on the registry showing `greenlet==3.5.3` where PyPI serves `3.5.4` — the exact package that broke it — rather than on "the flag is present". |

| `biffo-sib-build` | **partial** | Step 2 mandates one PR per milestone. Against a `dev` with strict up-to-date protection and other agents merging, every merge forced a full CI re-run on every open PR — M3+M4 and M5+M6 were batched to halve the cycles, and both batches were single coherent contracts anyway. The step should say when batching is *correct* rather than a shortcut. Its "stop and ask" guidance was right and used twice (migration 0010, the `pipeline_stage_id` lookup). |
| `biffo-verify` | **worked** | §4 caught that the deployed Lambda unpacks under `src/api/`, not the `api/` I guessed — the grep I would have trusted returned nothing for the wrong reason. §3 caught that a test written for the JSON-serialisation fix passed with that fix reverted; only reverting *both* it and the stringified id made it fail, so the test defends less than it appeared to. Both are things a green run would have hidden. |
| `biffo-verify` | **worked** | Reading the run's job states instead of `gh pr checks` exposed a job reported as `pending` that had already **failed**. Waiting on the summary would have been waiting indefinitely. |
| `biffo-workflow` | **should have been invoked** | Followed AGENTS.md by hand across ~10 PRs in three repos instead. It cost a real mistake: branch cleanup was chained onto an unverified `gh pr merge`, the merge failed on a required-check race, and deleting the branch **closed the PR**. The skill's honest-push/verify-remote discipline exists precisely for that. Missed because the work read as "build a feature", not "land a change" — the trigger wording is landing-shaped. |

| `clear_queue` | **partial** | Step 5 is `gh pr merge <N> --squash --delete-branch`, which fails outright on any repo requiring branches be up to date — every PR in a 5-deep queue is `BEHIND` the moment the one before it lands. The skill has no update-branch step, so the loop was improvised (`gh api -X PUT .../update-branch`, wait, re-verify, merge). Worse, the repo already had auto-merge enabled: `--auto` would have made the whole queue self-draining. The step should lead with auto-merge and name `update-branch` as the fallback. |
| `clear_queue` | **partial** | Step 4 suggests `gh pr checks <N> --watch` / re-query. This `gh` has no `--json` on `pr checks`, so a status poll built on it returned empty forever and burned a full timeout while CI was already green. `gh pr view --json statusCheckRollup` is the version-safe read, and any poll needs to assert it got a non-empty result before trusting `0 pending`. |
| `clear_queue` | **worked** | Its "inventory the whole list up front" step was what surfaced that two PRs were being merged by a *concurrent* session mid-run — the queue shrank without me. Without the up-front list I would have re-derived state per PR and mistaken those for my own merges. Its "stop and ask" guidance was also right and used once, on repointing branch protection across three branches of a live repo. |
| `biffo-verify` | **worked** | §3 applied to a test-only change found a `toContain` fail-open in the `biffo check` seam guard, and simultaneously proved the other four mutations *are* caught — which is the part that makes the guard worth keeping rather than rewriting. §6 confirmed both of `tabsii-intake`'s new audit gates fail closed, including that a typo'd `--ignore-vuln` ID still reds the job. Both were claims already made in a summary before being checked. |
| `biffo-workflow` | **should have been invoked** | Five of the seven merges were driven straight from `clear_queue` using worktrees **other sessions had created**, rather than through this skill. It worked out, but the checkout provenance was verified by hand each time (clean, synced, no in-flight edits) — which is exactly the discipline the skill encodes and would have applied without being remembered. Missed because the work read as "merge a queue", not "make a change"; the trigger wording is change-shaped. |

| `biffo-verify` | **worked** | §4 twice over. The deployed-artifact grep initially returned nothing because the bundle unpacks under `src/api/`, not `api/` — caught before it was read as a failed deploy. Then `filter-log-events` on the live log group proved migrations `0011 → 0010 → 0012` actually ran, which is what turned "the deploy was green" into "the guarded migration cleared the failure it was written for, on the database that has the problem". |
| `biffo-verify` | **worked** | §3 caught that a mutation had **silently not applied**: forcing the dry-run suppression off reported *all pass*, which would have meant three tests asserted nothing. The string replace had missed a line `ruff format` rewrapped. Re-run properly, each mutation failed exactly its own test. Without checking that the mutation landed, the guard and a vacuous guard are indistinguishable. |
| `biffo-verify` | **worked** | §1 stopped a duplicate fix: the migration-0010 failure was already filed as [#670](https://github.com/keiranholloway/biffo-template/issues/670), with the correct remedy written out. Two minutes of looking replaced re-deriving a decision someone had already made — and revealed the more interesting fact, that the issue had been *declined downstream* and had silently recurred. |
| `biffo-verify` | **worked** | §7 kept [#726](https://github.com/keiranholloway/biffo-template/issues/726) open after its PR merged. `Closes #726` had auto-closed it; nothing had run against a deployed instance at that point, so the close was a claim the evidence did not support. Reopened with the four things still unproven. |
| `clear_queue` | **partial** | Step 5's `gh pr merge --squash` fails outright where branches must be up to date — every PR in a queue is `BEHIND` the moment the one before it lands. No update-branch step, and no mention of `--auto`, which the repo already had enabled and which makes the queue self-draining. Step 4's `gh pr checks --watch` also assumes a `--json` this `gh` does not have on that subcommand, so a poll built on it burns its full timeout while CI is already green. |
| `biffo-verify` | **invoked too late — after everything had merged** | The user invoked it at the end. The §1–§7 disciplines were mostly applied anyway (probe before designing, prove the test fails, grep the deployed bundle), but **§8 nearly did not happen**, and §8 is the half that only exists if the skill runs. That is the second consecutive session where the write-up was at risk — the previous one deferred it entirely. The trigger list is debugging-shaped ("why is this failing?", "is this actually fixed?"); a session that is *building* something and succeeding never matches, which is exactly when the lessons are cheapest to record and most likely to be lost. |
| `biffo-verify` | **worked** | §1 was the highest-value step of the session by a distance: checking ten open issues against the code found **three already complete** (one shipped two days earlier) and two materially misdescribed. Roughly an hour of building work that did not need doing, plus two issues that would have kept lying to the next reader. |
| `biffo-verify` | **worked** | §3 caught that the region/unit mount tests asserted drawer *chrome* — a panel pinned to the wrong node renders identical chrome. Rewriting them to capture the `scope` prop and then swapping `region` for `brand` produced the exact expected failure. The original version would have passed against the bug it was written for. |
| `biffo-verify` | **worked** | §4 on a frontend change: the merge was green and the deploy was green, neither of which says the code shipped. Grepping the deployed bundle found all three scope literals where only `brand` existed before. |
| `biffo-verify` | **partial** | §2/§3 assume local reproduction is possible. For a Postgres-dependent change on this machine it is **not** (no `docker` group, no passwordless sudo, stopped cluster, no PostGIS), so three hypotheses each cost a full CI round trip on a cold spot fleet. The skill has no guidance for "you cannot run this locally" beyond §7's *say what you did not verify* — which covers honesty but not the iteration cost. Worth a step: check the local environment can run the subject **before** designing the change, and treat a gap as the first task. |
| `biffo-workflow` | **should have been invoked** | Followed AGENTS.md by hand across two repos and two PRs. It mostly held — fresh worktrees off `dev`, deps synced, `git ls-remote` after every push, worktrees reaped — but two things slipped that the skill encodes: the probe commit was pushed with `core.hooksPath=/dev/null` (verified on the remote afterwards, so honest, but the hooks were bypassed rather than satisfied), and the ownership guard was only run **after** the files were written, when running it first would have surfaced the `.github/` block before the workflow was designed around landing there. Missed for the same reason as last time: the work read as "build a lane", not "land a change". |
| `biffo-verify` | **worked** | §8 is the reason a three-session documentation loss was found at all. Following it meant reading the file before appending, which showed the row count had *fallen* from 65 to 57. Every commit was present and the page read fine; nothing else in the process looks at whether the record still contains what it used to. |
| `biffo-workflow` | **worked** | Six PRs across three repos this session, all merged with worktrees reaped. The honest-push step mattered once: a `pkill -f "http.server 8899"` matched its own command line and killed the shell mid-commit, so the commit never happened — `git status` afterwards caught it, where a "committed and pushed" assumption would not have. |
| `claude-in-chrome` | **worked** | Produced the visual assessment that reframed the whole design task: measured `.layout` computing to `display: block`, a 1920px full-bleed sidebar and ~234 characters per line on the deployed app, which is what identified a stylesheet targeting another plugin's classes rather than "the design is clumsy". |
| `claude-in-chrome` | **partial** | Drove npm far enough to fill the trusted-publisher form, then hit a hard stop: WebAuthn fires only on a genuine user gesture, so a form can be completed but not *saved* by automation. Worth stating in the skill — "the browser can do everything except the second factor" is a boundary that will recur on any account with passkeys. Window resizing was also unreliable: `resize_window` reported success while `innerWidth` stayed 1920, so the mobile breakpoint could not be exercised. |
| `biffo-workflow` | **worked** | Nine PRs across three repos (four Sprint 1 fixes, two experiment pre-registrations, one CI prerequisite, two instance upgrades), each start → PR → merged → worktree reaped. Step 1's "install deps in the *new* worktree" mattered immediately: the very first `pnpm --filter` run escaped the worktree because the shell's cwd had been reset by an earlier `cd`, and ran against a sibling repo — caught only because the output named the wrong path. Step 4's remote-verify caught nothing this time, which is the correct outcome, not a reason to drop it. |
| `biffo-workflow` | **partial** | Step 7 now says to enable auto-merge and treat `BEHIND` as a rebase. Across this session that step fired **ten times** and cost a full CI cycle each; it reads as an occasional hiccup rather than the dominant recurring cost it is. It also had no guidance for the case that actually applied — that the durable fix is a *repo setting*, and which setting depends on whether a merge queue is available. Updated in-session with the H1/H2/H3 outcomes and an explicit "do not spend time trying to enable a merge queue". |
| `biffo-verify` | **worked** | §3 twice, on changes that were green either way. A stray `console.log` failed all four of #696's `--json` tests, proving the "stdout carries only the document" assertion is load-bearing; neutralising #735's decline lookup reproduced the reported broken chain exactly. Both took ~2 minutes and are the only step separating these from the four vacuous guards already on this page. |
| `biffo-verify` | **partial — a real gap, not a misuse** | §4 ("verify the deployed artifact, not the source") has no counterpart for *"verify the checkout is the tree you think it is"*. A primary parked on a merged upgrade branch was read for an instance's core version and migration state; the figures were wrong, plausible, and reached a PR description before `git show origin/dev:` disproved them. The skill's own §1 is about the *issue's* state, not the *tree's*. Worth a line: read instance state from `origin/<branch>`, or confirm what the working tree is on first. |
| `biffo-verify` | **worked** | §7 ("say what you did not verify") kept #739's PR honest — it stated that nothing exercised the pairing detection against a real upgrade, because nothing could until one ran. That caveat is what made the later correction cheap rather than embarrassing: when the real upgrade showed the detection correctly staying *silent*, the claim being revised was already labelled unproven. |

| `biffo-sib-build` | **partial** | Step 0 requires the plan committed at `docs/implementation/<feature>/README.md`; ours existed only in the planning scratchpad, so the first unit of work was landing the doc — correct, but the skill reads as though that is always already true. Step 2's per-milestone loop worked well across five milestones. Its single-repo scope (`gh repo view` on the CWD) is unstated and mattered: this plan spanned four repos, and the CRM/intake halves needed their own runs. |
| `biffo-workflow` | **worked** | Twelve PRs across four repos, every worktree reaped. Step 4's honest-push discipline mattered once when a rebase needed `--force-with-lease` and re-verification; Step 7's `allow_auto_merge` pre-check mattered twice — `tabsii-crm` and `tabsii-intake` both have it **false**, so `--auto` would have merged immediately rather than queueing, exactly the trap the step warns about. Both were merged by hand after checks went green. |
| `biffo-verify` | **worked** | §1 alone saved ~40 minutes by finding [#277](https://github.com/tabsii-com/tabsii-platform/pull/277) had already built the non-superuser RLS harness this session was about to rebuild. §7 kept two PR bodies honest about what a green check did and did not prove. |
| `biffo-verify` | **partial** | §3 ("prove the test fails without the fix") could not be applied to the new RLS tests: doing so would mean shipping a commit that disables row-level security, and there is no local PostgreSQL (no Docker daemon) to do it against. The guard-the-guard tests are the structural substitute, but the step has no guidance for "the fix is a database policy" — where reverting it is not a local edit. Worth a sentence. |
| `claude-in-chrome` | **worked** | The only thing that verified any of this. Five milestones were confirmed by the route a user takes — including the 404 that both test suites reported green, and the agent-written score row appearing on the right lead. A skill-free session would have shipped M1 broken. |
| `biffo-workflow` | **should have been invoked for the plan doc** | The implementation plan was written straight into the planning scratchpad and only landed in-repo when `biffo-sib-build` refused to proceed without it. Nothing was lost, but the plan is a repo artefact from the moment it is agreed, and treating it as one unit of work from the start would have been cleaner. |

## Adding a row

Add one when a defect costs more than ~30 minutes, or when you catch yourself
saying "how did that ever work?".

0. **Record what it cost**, in the row, as `cost 1h 20m`. One row in
   forty-one carries a cost today, which is why nothing on this page can be
   ranked by impact — only by frequency. This is the single most valuable field
   and the only one that cannot be recovered later.
1. Add a scoreboard row: the failure *condition* (not the symptom), its class,
   where it surfaced, where the fix lands, and a link.
2. If the fix repo differs from the surfacing repo, say so — that gap is the
   point of the "where the work lands" table.
3. If a practice caught it, add it to *what went well* with the specific
   evidence. If a practice would have caught it, add it to *needs more thought*.
4. If it cost real wall-clock time, add the **cost and its cause** to *Where the
   cycles go* — not just the defect. A ten-minute fix and an afternoon lost look
   identical on the scoreboard, and only one of them is worth restructuring for.
5. Record every **skill** you invoked in *Skills used*, with an honest outcome —
   and for anything not `worked`, the step that misfired. Also record a skill you
   *should* have used and did not, and why you missed it: a skill nobody invokes
   is indistinguishable from one that does not exist, and that is a fixable
   defect in the skill.

Then re-extract, so the analysis stays derived rather than asserted:

```bash
node scripts/practices-evidence.mjs --extract   # table -> docs/practices/evidence.jsonl
node scripts/practices-evidence.mjs --enrich    # recover dates from the linked issues
node scripts/practices-evidence.mjs --report    # regenerate the counts above
```

Keep entries falsifiable. "Testing could be better" helps nobody; "the audit gate
exits 0 when the registry returns non-JSON, so a green check does not mean the
audit ran" is something someone can act on.
