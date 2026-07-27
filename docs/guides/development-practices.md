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
| — | `gh` was **2.46.0 from Ubuntu universe — 7 months and ~50 minor versions stale**. `gh issue view <n>` failed outright on a deprecated Projects-classic GraphQL field, and `gh pr update-branch` **printed its help text and exited 0** instead of running. Both were worked around as quirks across two sessions; neither prompted anyone to check the version. Nothing in either failure said "your tool is old" | **visibility** | agents working in every Biffo repo | workstation tooling (GitHub's apt repo, not Ubuntu's) | **fixed** — 2.96.0, auto-updating |
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
| [#670](https://github.com/keiranholloway/biffo-template/issues/670) | Core migration 0010 does `batch_alter_table("users")`, assuming a Core-owned `public.users` in the instance's Alembic chain. tabsii's users are DDL-imported as `tabsii.users`, so the migration raises `NoSuchTableError` and takes 4 smoke tests with it | **drift** | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template `migrations/` | **open** — declined in tabsii ([#244](https://github.com/tabsii-com/tabsii-platform/issues/244)) |
| [#668](https://github.com/keiranholloway/biffo-template/issues/668) | ADR-0022 discovery runs *after* `build_core_crud_router()`, and importing a domain is what registers its models — so relocating a domain silently drops every `/api/v1/data/` route its models back. **21 routes vanished in tabsii with the full suite green (1712 passed)**; no test builds the app the way `main.py` does, so none could have failed | **visibility** · boundary | tabsii-platform [#243](https://github.com/tabsii-com/tabsii-platform/pull/243) | biffo-template `main.py` + `routing/domain_router.py` | **open** — instance reordered locally as a stopgap |
| [tabsii#249](https://github.com/tabsii-com/tabsii-platform/issues/249) | Write-back scoped its update by ADR-0001's seam string `"default"`, but an ADR-0005 DDL-imported table keys tenancy on a real `UUID`. The bind error was caught and recorded as *"the database refused the write for the workflow's owner"* — **indistinguishable from RLS correctly refusing a revoked author**, so the one failure the feature exists to expose was being counterfeited | **drift** · visibility | tabsii-platform dev E2E | biffo-template [#686](https://github.com/keiranholloway/biffo-template/pull/686) + tabsii [#251](https://github.com/tabsii-com/tabsii-platform/pull/251) | **fixed** |
| [#690](https://github.com/keiranholloway/biffo-template/pull/690) | The audit row is written in the **same transaction** as the business write, and carries the written row's id in a JSON column. An instance's id is a `UUID`, which asyncpg cannot serialise — so recording a successful write **rolled that write back**. The traceback shows `status: 'succeeded'` on the insert that destroyed it | **fail-open** · visibility | tabsii-platform dev E2E | biffo-template `writeback.py` | **open** |
| — | Three consecutive write-back defects were the same assumption: template code treats ids/tenants as Core's `String(36)`, instances use real `UUID`s. SQLite has no UUID type and asyncpg coerces silently, so **neither the template suite nor a PostgreSQL happy path can see it** | **drift** | tabsii-platform dev E2E | biffo-template | **unfiled** — pattern, not a single bug |
| — | `build_core_crud_router()` returns **zero** routes when called a second time (the first call consumes the registry). A guard test written for #668 compared the assembled app against a freshly-rebuilt router, so its expected set was empty and it passed against the exact bug it guarded | **fail-open** | tabsii-platform [#246](https://github.com/tabsii-com/tabsii-platform/pull/246) | biffo-template (make idempotent or document); instance test hardened to a golden list | **unfiled** |
| [tabsii#252](https://github.com/tabsii-com/tabsii-platform/issues/252) | Two events ship with no `fields` and no `payload_model` while emitting a real payload, so the workflow builder's dropdowns are empty. The guard credited with preventing this (#546) does not iterate `registered_events()` at all — no test asserts field-metadata *coverage*, here or in the template | **fail-open** · drift | tabsii-platform (found closing #221) | biffo-template `services/api/tests` | **open** |
| — | Five template-owned files diverged **undeclared** across a whole core upgrade. The instance's tests checked each declaration was valid but never that the declared set and `core diff`'s modified set *agree*, so undeclared divergence was invisible governance — the guard hard-blocked those files with no recorded reason | **visibility** | tabsii-platform [#250](https://github.com/tabsii-com/tabsii-platform/pull/250) | tabsii-platform (ratchet added); biffo-template could emit the delta from `core diff` | **fixed** in the instance |
| — | `biffo core diff` emits human-prose only. Consumers hand-parse it, and a parse that silently drops a line under-reports divergence — one did exactly that here, reporting 4 undeclared files when the answer was 5, caught only because the section header's own count disagreed | **visibility** | tabsii-platform revalidation | biffo-template `cli` (a `--json` mode) | **unfiled** |
| [#715](https://github.com/keiranholloway/biffo-template/issues/715) | Scaffolding **skips branch protection entirely on a 403** (GitHub's answer for a private org repo below Team plan), logs one warning, and reports success. Nothing re-attempts and nothing audits, so a repo scaffolded during a 403 window stays unprotected after the plan is upgraded — three tabsii repos for three weeks, the **live core platform** among them, with 8 PRs merged into an ungated default branch in one session | **fail-open** · visibility | tabsii-platform [#261](https://github.com/tabsii-com/tabsii-platform/issues/261) | biffo-template `cli` (guard shipped, [#718](https://github.com/keiranholloway/biffo-template/pull/718)); repo settings | **fixed** — all 8 repos protected, `biffo check branch-protection` added |
| — | `gh pr merge --auto` refuses with *"Pull request is in clean status"*, and `gh pr checks` reports *"no checks reported"*, when runs have not yet **registered** — not when they passed. Both readings are indistinguishable from the real thing, and they mislead in opposite directions: one invites merging unverified code, the other looks like the genuine "GitHub created no run" case AGENTS.md §6 says never to paper over | **visibility** | tabsii-platform [#260](https://github.com/tabsii-com/tabsii-platform/pull/260) | practice / tooling wrapper | **unfiled** |
| [tabsii-intake#10](https://github.com/tabsii-com/tabsii-intake/issues/10) | CI had **not run on `dev` for three weeks**. A merge on 2026-07-22 produced a Deploy run and no CI run; triggers were correct, GitHub simply created none. `dev` shipped with no CI evidence and carried unpatched advisories nobody could see. The repo also had no `workflow_dispatch`, so there was no way to re-trigger CI on a protected branch without pushing | **visibility** | tabsii-intake | tabsii-intake (CI adopted from skeleton, adds `workflow_dispatch`) | **fixed** |
| [tabsii-marketplace#9](https://github.com/tabsii-com/tabsii-marketplace/issues/9) | A repo's **production build is broken and its CI is green, consistently** — `pnpm run build` dies on `Both UserPoolId and ClientId are required` (a Cognito pool built at module scope, evaluated during prerender), but marketplace's `js` job runs only lint/typecheck/test/audit. The skeleton's `js` job also **builds without credentials**, precisely to catch this ([#286](https://github.com/keiranholloway/biffo-template/issues/286)) | **fail-open** · visibility | tabsii-marketplace [#8](https://github.com/tabsii-com/tabsii-marketplace/pull/8) | tabsii-marketplace (lazy pool construction, then adopt the skeleton CI) | **open** |
| — | **CI generations drift by *step*, while job *names* stay identical.** marketplace has all four current consolidated job names and looks migrated; its `js` job is missing the Build step added later. Nothing compares a repo's workflow against the skeleton, so "are we on the current CI?" is answered by a name match that can be true while the content is a generation behind | **drift** · visibility | tabsii-marketplace | biffo-template (a workflow-drift check) | **unfiled** |
| — | **Nothing tracks when CI last ran on `dev`.** Two sibling repos were found independently, hours apart, each with no CI run for three weeks — intake (2026-07-06) and marketplace (2026-07-06). In both the branch was green-by-absence: no failing run, because no run. A "last successful CI on the default branch" age is not surfaced anywhere | **visibility** | tabsii-intake, tabsii-marketplace | biffo-template (`biffo check`, or a scheduled sweep) | **unfiled** |
| [#722](https://github.com/keiranholloway/biffo-template/issues/722) | An issue was filed on a **wrong premise** and proposed a fix that would have been dead config: it claimed pip-audit "reds every sibling" on an unfixable `ecdsa` advisory and asked the *skeleton* to carry a CVE suppression. The skeleton already declares `pyjwt[crypto]`, so a new sibling never sees it; only two legacy siblings did. Nothing checks an issue's claims before someone implements them | **drift** · process | biffo-template | tabsii-intake / tabsii-marketplace (drop `python-jose`) | **corrected** — intake done ([#11](https://github.com/tabsii-com/tabsii-intake/pull/11)), marketplace outstanding |
| — | `tabsii-platform` has `allow_auto_merge=false` and `delete_branch_on_merge=false` — the settings fixed on `biffo-template` and `biffo-platform` on 2026-07-27 were never applied to the third repo, so every PR there is merged by hand and every branch reaped by hand | **process** | tabsii-platform | tabsii-platform settings | **fixed** 2026-07-27 — `allow_auto_merge` and `delete_branch_on_merge` both enabled; all three repos now match |
| [tabsii#256](https://github.com/tabsii-com/tabsii-platform/issues/256) | The ownership guard blocks edits to *instance-authored* files under a template-owned prefix (e.g. `identity/tabsii.py`), but `core diff` classifies those as `removed`, not `modified` — so the instance's own divergence ratchet rejects a declaration for them. Governance actively prevents the record it exists to encourage; the only route through is a per-commit trailer | **boundary** | tabsii-platform [#253](https://github.com/tabsii-com/tabsii-platform/pull/253) | tabsii-platform ratchet; `core diff` bucket semantics ([#689](https://github.com/keiranholloway/biffo-template/issues/689), [#696](https://github.com/keiranholloway/biffo-template/issues/696)) | **open** |
| [#697](https://github.com/keiranholloway/biffo-template/issues/697) | Two open issues described one npm outage ([#664](https://github.com/keiranholloway/biffo-template/issues/664), [#671](https://github.com/keiranholloway/biffo-template/issues/671)), filed independently days apart. Nothing prompts a search before filing, and the duplicate was found only when listing open issues for an unrelated reason — after one had already been closed on its own | **process** · visibility | biffo-template issue tracker | practice, not code | **closed** — both closed, residue split to #697 |
| [#666](https://github.com/keiranholloway/biffo-template/pull/666) | Template tests asserted **ambient process state** — an empty write-back registry, and whichever identity provider happened to be installed. Both are properties only a bare template has, so 14 tests were green upstream and red the moment they were distributed | **drift** · fail-open | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template `services/api/tests` | **fixed** ([#666](https://github.com/keiranholloway/biffo-template/pull/666)) |
| — | [#665](https://github.com/keiranholloway/biffo-template/pull/665) was written, reviewed, merged and **wrong** — it pinned the *default* identity provider, which reads `public.users`, a table the instance also lacks. It was never run against the instance it existed to unblock; [#666](https://github.com/keiranholloway/biffo-template/pull/666) corrects it | **process** | biffo-template | biffo-template | **fixed** — verify a distribution fix *against the distribution* |

### What the classes say

> Counted from `docs/practices/evidence.jsonl`, not asserted. Regenerate with
> `node scripts/practices-evidence.mjs --report`. **47 rows.**

| Primary class | Rows |
| --- | --- |
| **visibility** | 16 |
| drift | 12 |
| boundary | 8 |
| fail-open | 6 |
| process | 5 |

**This page previously said "fail-open is the dominant shape — three of the five
filed issues".** That was true of a five-row sample and was never revised as the
sample grew ninefold. Counted across all 47 rows, fail-open is *fourth*. The
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

**What the dataset cannot yet tell us.** Of 47 rows, **1** carries a cost figure
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

Tallying by the repo that must change. **Recounted from `docs/practices/evidence.jsonl`
(`node scripts/practices-evidence.mjs --extract && --report`), 54 rows** — not
incremented by hand, because every prose count on this page has gone stale at
least once. A row naming two repos counts for each.

| Repo | Fixes landing here | Notes |
| --- | --- | --- |
| **biffo-template** | 42 of 54 (78%) | Core API, CLI, CI, CDN module, skeletons, migrations, publish pipeline, repo settings |
| **tabsii-platform** | 3 of 54 | Divergence ratchet and repo settings |
| **biffo-platform** | 2 of 54 | Instantiated infra — API Gateway routes, CDN |
| **tabsii-intake** | 2 of 54 | CI generation and the `python-jose` removal |
| **tabsii-marketplace** | 2 of 54 | `python-jose` removal; the credential-dependent build |
| **biffo-plugin-ideation** | 1 of 54 | A UI rendering a 500 as an empty state |
| **biffo-runners** | 1 of 54 | Runner fleet docs + fail-fast |

**36 of 54 rows are fixed somewhere other than where they surfaced** — two thirds,
and still the most useful number on the page. **78% land in `biffo-template`**,
unchanged across the last three recounts despite the sample growing from 41 to 54.

**What this round added is a shape, not a count.** Three of the new rows are the
same condition in different clothes: a repo that *looks* current and is not.
marketplace has every current CI job **name** and is missing the Build **step**;
two siblings had no CI run for three weeks and neither surfaced as unhealthy,
because a branch with no failing run is indistinguishable from one that passed;
and a `pnpm.overrides` remediation now exists in two repos, copied by hand, with
nothing linking them.

That is a different problem from the one this page has mostly tracked. The earlier
rows are defects in *shared code* that reach instances through the template. These
are defects in **shared conventions with no shared enforcement** — a skeleton is
copied once at creation and then nothing ever compares a repo against it again.
`biffo check branch-protection` is the first thing in this project to close that
loop for one setting; the same argument applies to workflow drift, dependency
policy, and CI recency.

## Where the cycles go

The scoreboard records what *broke*. This records what it *cost*, which is a
different question and often the more actionable one: a defect fixed in ten
minutes and a defect that ate an afternoon get one row each up there.

Measured on the 2026-07-27 session, which shipped one bug fix end to end.

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
| **8 repos audited by hand before a tool existed** | Establishing which branches were protected meant a `gh api` loop per repo per branch, because nothing reported settings drift. That audit *is* the finding: it took writing `biffo check branch-protection` ([#718](https://github.com/keiranholloway/biffo-template/pull/718)) to make it a one-liner — and the guard then immediately caught an incomplete fix the hand audit had missed | **fixed** — guard shipped; not yet scheduled anywhere |
| **One wrong conclusion from re-running the wrong workflow** | Testing "does intake's old CI fail today?" I re-ran the newest successful `dev` run — which was **Deploy**, not CI — and it passed, appearing to disprove the hypothesis. Redone against an actual `ci.yml` run it failed, confirming it. A run id is not self-describing; filter by workflow, not by branch and conclusion | **process** — cost one wrong belief, caught by checking the job names |
| **2 dependency-alignment rounds on one repo** | Mirroring another sibling's known-good versions cleared 8 of 13 advisories; the last 5 were transitives with no direct upgrade path (`postcss`, `sharp`, `brace-expansion`) and needed the same repo's `pnpm.overrides` copied across too. The fix existed and was found twice, by hand, because **nothing shares a remediation between siblings** | **open** — the overrides live in two package.json files with no common source |
| **1 full reinstall + rebuild to answer "did I break this?"** | A build failed after a dependency upgrade. Establishing that it failed *identically* before the upgrade meant stashing the lockfile changes, reinstalling the original tree and rebuilding — several minutes to convert a suspicion into a fact. Worth every second: the alternative was shipping a fix for a defect I had not caused, or abandoning an upgrade that was fine | **structural** — no cheaper way to get a before/after on a lockfile |

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

## What needs more thought

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

**A tool behaving oddly is evidence about the tool, not just an obstacle.** Two
separate `gh` commands misbehaved — one erroring on a deprecated API field, one
silently printing help and exiting 0 — and both were routed around with a
workaround rather than diagnosed. The cause was a package 7 months stale, which
one `gh --version` would have exposed. The workarounds were even *written into a
subagent's brief*, propagating the symptom instead of removing it. Worth asking,
the second time a tool surprises you: **is this tool the version I think it is?**

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

## Skills used

Skills cannot be iterated on impressions. Every invocation, with an honest outcome.

| Skill | Outcome | Detail |
| --- | --- | --- |
| `biffo-workflow` | **worked** | Seven changes across two repos, start → merged → worktree reaped. The honest-push and remote-verify steps mattered once: a rebase onto a mid-flight core upgrade needed `--force-with-lease` and re-verification, and the step's insistence on re-checking the remote caught that the PR body's numbers were now stale. |
| `biffo-workflow` | **partial** | Step 3's commit example does not mention that a `Core-Divergence:`/`Core-Convergence:` trailer must fit commitlint's 100-character footer limit *and* stay on one line for the guard's anchored regex. Two commits were rejected after the hooks had run. Worth one line in the step. |
| `biffo-verify` | **worked** | §3 ("prove the test fails without the fix") caught a guard that passed against the bug it was written for, because its expected set was empty. Nothing else in the process would have found it — the test was green, the code was correct, and the assertion was vacuous. |
| `biffo-verify` | **should have been invoked sooner** | It was loaded at batch 4 of a five-batch relocation. Batch 3 is where 21 routes silently disappeared; the route-diff that caught them was improvised rather than prompted. The trigger wording is debugging-shaped ("investigating a bug", "green but broken"), so a *refactor* with a silent-regression risk does not read as a match. Worth adding refactors and relocations to the trigger list. |
| `biffo-workflow` | **partial** | Step 7 (`gh pr merge --squash`) assumes you can win the up-to-date race. `dev` was taking a merge every 3–5 min against a ~2.5 min CI cycle, so the branch was `BEHIND` on every attempt and **four rebases lost it**. The real fix was a repo setting (auto-merge), not a rebase. The step should offer an auto-merge path. |
| `claude-in-chrome` | **worked** | The only thing that reproduced the reported bug. `curl` returned clean `401` JSON and looked healthy — the HTML only appears on an *authenticated* request, because 401 passes the CDN untouched while 403/404 are rewritten. An unauthenticated check would have concluded "works fine" and #647 would still be unfound. |
| `biffo-verify` | **partial** | §1 caught that the planned #621 step 3 would have collapsed ADR-0014 §7's two-axis authorization boundary — a real save. But it was **not applied to its own author's output**: `core diff`'s `removed (5)` was reported to the user as fact without the dry run that disproves it in seconds. The step exists and was skipped. |
| `biffo-workflow` | **worked** | Nine changes across three repos, start → merged → worktree reaped. Its honest-push and remote-verify steps earned their place twice: once when a rebase onto a mid-flight core upgrade needed re-verification, and once when a **blocked commit still produced `push exit 0`** — the branch existed on the remote carrying none of the work. Only `git log origin/<branch>` showed it. |
| `biffo-workflow` | **partial** | Step 7 assumes you merge by hand. Where the repo allows auto-merge that is wasted watching; where it does not it is unavoidable — `tabsii-platform` had it off and that cost ~2¼ hours this session, since fixed. The step should say: enable auto-merge, use it, and treat a repo without it as a defect to fix rather than a cadence to absorb. |
| `biffo-verify` | **worked** | §3 caught **two** vacuous guards — one whose expected set was empty because `build_core_crud_router()` returns zero on a second call ([#695](https://github.com/keiranholloway/biffo-template/issues/695)), one that asserted a path existed when a hand-written route kept it alive regardless. Both were green, both protected nothing. Reverting the fix and watching the guard fail is the only step that distinguishes those from a real guard. |
| `biffo-verify` | **worked** | §1 and §7 changed two outcomes: #221 was closed on evidence rather than its own summary (finding a guard it credited does not exist), and #190 on the registry showing `greenlet==3.5.3` where PyPI serves `3.5.4` — the exact package that broke it — rather than on "the flag is present". |

| `biffo-sib-build` | **partial** | Step 2 mandates one PR per milestone. Against a `dev` with strict up-to-date protection and other agents merging, every merge forced a full CI re-run on every open PR — M3+M4 and M5+M6 were batched to halve the cycles, and both batches were single coherent contracts anyway. The step should say when batching is *correct* rather than a shortcut. Its "stop and ask" guidance was right and used twice (migration 0010, the `pipeline_stage_id` lookup). |
| `biffo-verify` | **worked** | §4 caught that the deployed Lambda unpacks under `src/api/`, not the `api/` I guessed — the grep I would have trusted returned nothing for the wrong reason. §3 caught that a test written for the JSON-serialisation fix passed with that fix reverted; only reverting *both* it and the stringified id made it fail, so the test defends less than it appeared to. Both are things a green run would have hidden. |
| `biffo-verify` | **worked** | Reading the run's job states instead of `gh pr checks` exposed a job reported as `pending` that had already **failed**. Waiting on the summary would have been waiting indefinitely. |
| `biffo-workflow` | **should have been invoked** | Followed AGENTS.md by hand across ~10 PRs in three repos instead. It cost a real mistake: branch cleanup was chained onto an unverified `gh pr merge`, the merge failed on a required-check race, and deleting the branch **closed the PR**. The skill's honest-push/verify-remote discipline exists precisely for that. Missed because the work read as "build a feature", not "land a change" — the trigger wording is landing-shaped. |
| `biffo-verify` | **worked** | §1 (establish state first) stopped two wrong actions in one session: #712 turned out to be someone else's PR I had mis-cited, and #722's premise was false — the skeleton it asked to patch already had the fix. Both would have produced real work in the wrong direction. |
| `biffo-verify` | **worked** | §3, applied to a library swap rather than a bug fix. The auth verifier had no tests; writing them against the **old** implementation first turned "the swap compiles and passes" into "the two implementations agree". That framing came straight from the step and is the only reason the swap is defensible. |
| `biffo-workflow` | **worked** | Four changes across three repos. Its honest-push rule paid out again: `gh pr merge` reported an error that a piped `$?` swallowed as success, and only `gh pr view --json state` showed #698 had not merged at all. |
| `biffo-workflow` | **partial** | Nothing in the flow covers **another session committing to your branch mid-PR**. It happened twice here (#718 gained a test commit, #9 gained the dependency fixes). Both were welcome, but the skill's model is one agent per unit of work, so the correct move — review their commits before merging rather than assuming your own diff is what lands — is not written down anywhere. |
| `biffo-verify` | **worked** | §3 applied twice more, and the second use was the one that mattered: not "does my test fail without the fix" but "does this failure exist without my change". Stashing a lockfile and rebuilding on the original tree turned an assumed regression into a pre-existing, separately-owned defect ([marketplace#9](https://github.com/tabsii-com/tabsii-marketplace/issues/9)). |
| `biffo-verify` | **worked** | Its refusal to accept a green suite is what prompted running `pnpm run build` at all on a repo whose CI does not build. Four checks passed; the fifth did not exist. Nothing in the workflow would have surfaced that. |
| `biffo-workflow` | **worked** | Two repos, start → merged → worktree reaped, no incidents. Its named-stash rule (`git stash push -m`, pop by name) earned itself here — the before/after build test required stashing in a repo where other sessions have been active. |

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
