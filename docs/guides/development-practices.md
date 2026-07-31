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
| [#838](https://github.com/keiranholloway/biffo-template/issues/838) | `core.hooksPath` was `.husky/_` — a **relative** path git resolves against *each worktree's* root, pointing at a **gitignored** directory created only by `prepare` on `pnpm install`. AGENTS.md §1 *mandates* a fresh worktree per unit of work, so **the required workflow disarmed its own gates**: git skipped every hook with no warning, no error, no output. **7 of 37 working trees armed** | **fail-open** · visibility | tabsii-platform `.worktrees/discovery-rls` — three tracked hook files, no `.husky/_`, therefore no pyright, no lint-staged, no commitlint on anything committed there | biffo-template | **fixed** ([#845](https://github.com/keiranholloway/biffo-template/pull/845)) — dispatchers in the **shared** `.git/hooks`, which every worktree inherits |
| [#855](https://github.com/keiranholloway/biffo-template/issues/855) | The local gate checked the repo **root only**. In the ten repos with no root `package.json`/`pyproject.toml` — every sibling, every plugin — it printed `n/a - no package.json in this repo` then **`verify passed`**, on repos whose frontend is TypeScript and whose API is Python. `tabsii-crm` ran **one** check on a 700-line change and reported a pass. Worse than the missing hooks it was built to fix: **a repo with no hooks makes no claim; this one claimed to have checked** | **fail-open** · drift | tabsii-crm, biffo-plugin-ideation | biffo-template | **fixed** ([#853](https://github.com/keiranholloway/biffo-template/pull/853), [#855](https://github.com/keiranholloway/biffo-template/pull/855)) — `js_dirs()` + `py_dirs()` |
| — | **A skeleton shipped no `.gitignore` at all, so eleven satellites could not honour a rule their own AGENTS.md ships.** §1 mandates a worktree per unit of work under `.worktrees/` and states they are git-ignored "so worktrees never get committed or double-scanned". `_skeletons/plugin-template` carried **no `.gitignore`**; `sibling-template`'s 71-line one omitted the entry. Eleven of sixteen repos were affected. The symptom is mild and permanent, which is exactly why it survived: three satellites read as dirty forever, which trains you to stop reading `git status` — and a whole worktree can be committed by accident. Found only because a worktree sweep asked why three clean repos reported changes. **Deliberately not a `shared-files.json` candidate**: those `.gitignore`s legitimately differ (4 lines to 69, Python vs Node vs Terraform), so the existing repos got an append each and the skeletons got the fix for repos not yet created | **drift** | eleven satellites | biffo-template (`_skeletons/*`), plus one append per repo | **fixed** ([#945](https://github.com/keiranholloway/biffo-template/pull/945) + 8 satellite PRs) — guard proven to fail independently per skeleton |
| — | **A worktree survey could not see the worktrees it was surveying.** The sweep parsed `git worktree list --porcelain` and keyed on `branch` lines — so every **detached-HEAD** worktree was silently skipped, and a leftover directory whose registration had already been pruned was invisible too. It reported "5 remaining" when there were 7 plus an orphan, and I quoted that number. The same shape as everything else on this page: the instrument could not observe part of what it was measuring, and its output looked complete | **visibility** | the sweep itself | diagnostic practice | **corrected** — re-run without the branch filter; the missed entries included one holding uncommitted work |
| — | **A misconfigured upstream made a healthy cron look nine commits behind.** `practices-daily`'s worktree tracked `origin/dev` rather than `origin/chore/practices-snapshots`, so `git log @{u}..HEAD` compared its snapshot branch against an unrelated one and reported **9 unpushed commits**. Nothing was unpushed — its HEAD was already the remote tip. I quoted the 9 to the operator as a reason to keep the worktree; the reason was right and the number was invented by the measurement. A bare `git push` from there would also have targeted `dev` | **visibility** | biffo-template | biffo-template (worktree git config) | **fixed** — upstream repointed; now reports 0 |
| — | **Four independently-sufficient defects stood between an admin edit and a run, and no gate could see any of them.** Idea Scout's "prompts live in the database" feature was merged, deployed and green across four repos, and did not work. Driving it end to end for the first time found, in the only order they can be found: (1) the Agents tab could not read its own agents — the whole `/api/v1/admin/*` prefix is unrouted at the CDN, which answers with the portal's HTML shell and a 403; (2) `builtin-agents` was declared at an ABSOLUTE path inside an app the host mounts, so its real URL was unreachable nonsense that four passing tests asserted, because `TestClient(app)` calls the app object where absolute paths do resolve; (3) the SPA was mounted at `/` ABOVE the API routes, and Starlette matches in registration order with no fall-through; (4) the founder run form could not submit at all. Each was enough alone. The feature reported green throughout | **visibility** · fail-open · boundary | biffo-plugin-idea-scout, biffo-platform | biffo-plugin-idea-scout (`admin_app.py`, `web/src/lib/api.ts`), biffo-platform (`db/imports/biffo/009`) | **fixed** ([#70](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/70), [#72](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/72), [#73](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/73), [platform#131](https://github.com/keiranholloway/biffo-platform/pull/131)) |
| — | **A precedence rule chosen for backwards compatibility silently disabled the feature it belonged to.** #910 resolves an agent's prompt and model from the registry, with precedence "snapshot value if present, else the registry" — chosen so existing workflows keep working. Idea Scout's fan-in workflow, seeded by DDL module `003`, carried BOTH inline, so the registry was never consulted, an admin's edit changed nothing that ran, and three milestones closed green on top of it. The plugin-side fallback removal and the seed-script fix both landed and neither could help: a script only affects a FRESH seed, and `ddl-import` skips an applied file by name. Measured, not inferred — a marker added through the panel was absent from the run's `definition_snapshot`, and the model was the pre-fix slug while the row held the corrected one. **cost 25m** | **boundary** · visibility | biffo-plugin-idea-scout | biffo-platform (`db/imports/biffo/009`) | **fixed** ([platform#131](https://github.com/keiranholloway/biffo-platform/pull/131)) — re-verified: marker in the snapshot, all four titles carry it, `prompt_version: 3` recorded |
| — | **A client/server shape mismatch reached a founder because the fetch helper ends in a blind cast.** `GET /models/last-used` returns `{"research_model": …}`; `api.ts` typed it as a bare `string \| null`; `request<T>` ends `return (await res.json()) as T`, so the compiler had nothing to compare. An object is truthy, so the picker's state became the envelope, no `<option value>` matched it, the browser rendered the FIRST model as if chosen, and submitting sent the envelope — `422 string_type, "input":{"research_model":null}`, the envelope echoed back. A founder loading the page and pressing **Run now** could not start a scout, and the form looked complete. Cost two failed submits mid-verification before the cause was found. A second, independent path to the same display lie exists whenever there is no last-used model and no `is_default` in the catalog | **visibility** | biffo-plugin-idea-scout | biffo-plugin-idea-scout (`web/src/lib/api.ts`, `RunForm.tsx`) | **fixed** ([#73](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/73)) — unwrapped, plus an explicit empty option so an unselected select cannot display a model |
| — | **A defect was asserted from a catalogue listing while the estate's own billing table disproved it.** `anthropic/claude-opus-4-8` is absent from OpenRouter's published `/v1/models` (367 models), from which I concluded it "is not a model" and would fail a run after three paid research calls — then shipped a plugin fix, a DDL correction and two guard tests on that basis. The agent-runs ledger shows **26 runs on that exact slug, $3.74 charged, 24 completed**, including every successful synthesis to date: OpenRouter normalises it. The dotted form is still preferable, because an unlisted alias is undocumented behaviour, but the stakes were invented. The refuting evidence was two clicks away in a surface I had already opened | **process** | biffo-plugin-idea-scout | biffo-plugin-idea-scout (`definitions.py`, `test_definitions.py`) | **corrected** ([#72](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/72)) — guard kept but relabelled hygiene, both assertion messages now state that the other form works |
| — | **Synthesis-class agents ran at 44–98% of the default 120s wall clock for their whole life, and nothing reported the margin.** Eleven recorded Idea Scout synthesis runs: 52.8s, 1m26s, 1m38s, 1m41s, 1m42s, 1m45s, 1m46s, 1m47s, 1m48s, **1m57s (98%)**, then one that exceeded it and failed. `DEFAULT_TIMEOUT_SECONDS = 120.0` is sane for a chat-shaped worker and wrong for one emitting 5–10 scored candidates as a single structured generation — 5,676 output tokens is the normal size of that, not an outlier. The ledger shows duration; nothing shows duration **against the limit**, so a run at 98% and one at 44% look equally green | **visibility** | biffo-platform | biffo-platform (`db/imports/biffo/009`, `timeout_seconds: 240`) | **fixed for this agent**; the class is [template#937](https://github.com/keiranholloway/biffo-template/issues/937) |
| — | **Three documented seeding hooks in this estate never fire, and a fourth mechanism that works was already in use in the same directory.** `plugin_chat_agents` had no rows on dev while idea-scout's fallback had been removed on the guarantee that a startup hook created them. The hook is `@app.on_event("startup")` in each plugin: the shared host attaches plugins with Starlette `Mount(...)`, and **lifespan does not propagate to a mounted sub-app** — reproduced in 12 lines; the app serves requests normally, only its startup is skipped. Core itself runs `Mangum(app, lifespan="off")` and invokes ddl-import explicitly from the deploy, so the platform had already decided not to trust lifespan for this. `db/imports/biffo/003`, `004` and `005` seed this very plugin that way — which is exactly why the Build Types tab renders five rows and the Agents tab rendered none. `004`'s own header records the identical lesson about a **third** dead hook, `on_install()`: documented in ADR-0003 §9, demonstrated in the skeleton, referenced nowhere in `cli/src/`. The premise that sent us elsewhere was M3's *"there is no deploy step to hang seeding on"*, which is true of the **plugin repo** and irrelevant — the seed lives in the instance, which has run that step three times. **cost 1h 20m** | **process** · fail-open · visibility | biffo-plugin-idea-scout, biffo-plugin-ideation | biffo-platform (`db/imports/biffo/006`, `007`) | **fixed** ([biffo-platform#129](https://github.com/keiranholloway/biffo-platform/pull/129)) — seeded by the mechanism already in the directory; [#924](https://github.com/keiranholloway/biffo-template/issues/924) tracks whether the dead hooks are removed or made to work |
| — | **The parity guard ran only in `biffo-template`** — the single repo with both a root `package.json` and a root `pyproject.toml`, i.e. the one place the root-only assumption held. It validated the gate where the gate was already correct, and could not have caught the blind spot in any of the ten repos that had it | **fail-open** | biffo-template | biffo-template (`gate-coverage.sh`, per repo) | **fixed** — parity is now measured per repo against *that* repo's CI, and exits non-zero |
| [#856](https://github.com/keiranholloway/biffo-template/pull/856) | Sibling and plugin repos have no `core-manifest.json`, so `biffo core upgrade` cannot reach them. The documented channel was *"vendor into the skeleton, plus a one-time manual copy-in"* — which only helps repos created **afterwards**, and nothing ever prompts the copy-in. **Second occurrence of the same absence**: it is how `AGENTS.md` drifted 68 lines behind in tabsii (#559), and how eight repos ended up two gate versions stale | **drift** · process | tabsii-crm | biffo-template (`shared-sync.sh`) | **fixed** — declared file list, `--check` reports drift and exits 1 |
| — | `bandit` was excluded from the gate with the rationale *"the finding gate is the upload step, not the run"*. **False** — `bandit -ll` exits non-zero on findings and it is the **run** step that fails (tabsii-platform PR #313, job 90502765804, exit 1, on a change whose local verify had passed). The exclusion was written **from intent** and never checked against a real run | **fail-open** | tabsii-platform#313 | biffo-template | **fixed** ([#855](https://github.com/keiranholloway/biffo-template/pull/855)) — included, and every other exclusion re-audited against observed CI behaviour |
| — | The gate ran a **fixed check list tuned against `biffo-template`**, so it was repeatedly **stricter than the repo's CI**: terraform over `infra/` where CI checks only `modules/`; bandit over `-r services` where CI scans only template-owned paths (three B310s in *user-owned* `services/idea-scout/` — a push CI would have passed); bandit at all in plugin repos whose CI has no bandit step. **Patched three times before the cause was fixed** | **drift** · process | biffo-platform, biffo-plugin-idea-scout | biffo-template (`ci_has`, derived per repo) | **fixed** ([#861](https://github.com/keiranholloway/biffo-template/pull/861)) — no check can run that CI does not run |
| — | The shared-file drift detector compared the template against each **local working copy**, so twelve entirely-current repos reported `DRIFTED` right after their sync PRs merged — the clones had not been pulled. Resolving through `origin/HEAD` then reported three more as missing everything, because it points at `main` in several clones and `main` is a stale release branch | **visibility** · fail-open | biffo-template | biffo-template | **fixed** ([#862](https://github.com/keiranholloway/biffo-template/pull/862)) — compares `origin/dev`; verified by checking a clone out three commits back |
| — | The sync tool reported `PUSH REFUSED (run the gate there and look)` for **every** push failure. The first real cause was a plain non-fast-forward against a previous run's branch — **and the gate was green in that repo**. The diagnostic sent you to read a passing log | **visibility** | tabsii-crm | biffo-template | **fixed** — push output captured and classified: gate refusal / branch divergence / actual error |
| — | `verify.sh` ran `pytest -q --no-cov`. **`--no-cov` is a `pytest-cov` flag**, and repos without that plugin — `biffo-plugin-ideation`, whose CI runs plain `uv run pytest -q` — reject it with `unrecognized arguments`, so **the gate refused a push CI would have passed**. [H5](../practices/experiments/H5-gate-residuals.md) pre-registered the recurrence of *"gate stricter than CI"* as a condition that **refutes H5**, and it recurred within hours of that page being written | **drift** · process | biffo-plugin-ideation, during estate rollout | biffo-template | **fixed** ([#872](https://github.com/keiranholloway/biffo-template/pull/872)) — the command now matches CI exactly |
| — | **`verify.sh --list` disagreed with `verify.sh`.** `--list` skipped the pytest timing probe, so `tabsii-crm` ran `OK pytest(services/api) 2s` while `--list` reported pytest absent — and `gate-coverage.sh` reads `--list`. Fixing it forced an explicit choice with no cached measurement: guessing *fast* makes `--list` **claim** a check the gate may not run (fail-open); guessing *slow* under-reports one it does (visible, self-correcting) | **visibility** · fail-open | biffo-template | biffo-template | **fixed** ([#873](https://github.com/keiranholloway/biffo-template/pull/873)) — under-reporting kept, as the direction that cannot lie about coverage |
| — | `pytest` was excluded from the gate by a blanket rule with a manual opt-in **nobody ever issued**. Measured: 51.2s / 57.4s / 85.6s in the template and instances, but **1.7–2.7s in every sibling**. The exclusion was correct for the three repos it was written against and wrong for the four it was applied to — so **the fastest suites in the estate were the ones not being run** | **drift** | tabsii-crm + 3 siblings | biffo-template | **fixed** ([#871](https://github.com/keiranholloway/biffo-template/pull/871)) — included wherever it measures under budget |
| — | **Two findings nearly reported from tool output that was itself wrong.** A conventional-commit audit measured 12% violations in `tabsii-platform` using a regex that rejected `feat(db,api):` — commas are legal in a scope, so the tool was wrong and the repo was fine. Separately `biffo.sh check release-subject` printed `No base ref` and looked like a fail-open until its exit code was read: it exits **2**, loudly | **process** · visibility | biffo-template (measurement) | diagnostic practice | **corrected before shipping** — each disproved by checking the instrument before believing its output |
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
| — | **Now FOUR Cognito client IDs in one origin's `localStorage`, three of them dead.** Was three-and-two when first logged; re-measured 2026-07-28 by calling the admin API with each token in turn — exactly one (`1ccelk…`, its **idToken**, not its accessToken) returns 200, the other seven 401. AWS has one pool and one client; the rest is browser residue that **accumulates**, so any code picking the "first" match grabs a dead token with rising probability. The count in this row was stale within days of being written, which is the second-order lesson: a number in prose needs a re-measurement date attached or it silently becomes wrong | drift · visibility | dev.biffo.io portal | portal / plugin `web-admin` | **unfiled** — prune non-matching `CognitoIdentityServiceProvider.*` keys |
| — | CI logs not retained for self-hosted runs, so a green check cannot be inspected to confirm *what it actually did* | visibility | biffo-template CI | biffo-template CI | **unfiled** |
| — | `ci.yml` fires on both `push` and `pull_request`, leaving duplicate in-flight runs that make "are all checks done?" unanswerable to tooling | visibility · process | biffo-template CI | biffo-template CI | **unfiled** |
| [#689](https://github.com/keiranholloway/biffo-template/issues/689) | `core diff` reports instance-authored files as `removed` — a false data-loss signal that `core upgrade` does not act on. Halted a deploy, produced an incorrect issue, and prompted a workaround hunt, all for something that would not happen | **visibility** | biffo-platform upgrade | biffo-template `cli/` | **open** |
| — | Two plugin admin URLs both answered `200 text/html`, so they were read as the same failure. They were opposites: one carried `x-cache: Miss` and `<title>Ideation Engine — Admin</title>` (working), the other `server: AmazonS3` + `x-cache: Error` (a 404 the CDN rewrote). The proposed fix would have reverted #635 and broken admin access for every admin | **visibility** | biffo-template [#713](https://github.com/keiranholloway/biffo-template/issues/713) | biffo-plugin-idea-scout (missing `web-admin/dist`) | **corrected** — cost ~25m and one wrong issue |
| — | An admin panel rendered a **500 as "No catalog entries yet."** The screenshot looked like a working feature with no data; only `read_network_requests` showed the status. A UI that renders a failed fetch as an empty collection makes a broken feature indistinguishable from an idle one | **visibility** | biffo-platform (Ideation admin) | biffo-plugin-ideation (surface fetch failures) | **unfiled** |
| — | **git skips ALL hooks silently when `core.hooksPath` points at a directory that does not exist.** husky sets it to the generated, gitignored `.husky/_`, which no fresh worktree has — so every worktree made by the documented workflow ran with pre-push `pyright`, `lint-staged` **and** the core-ownership guard dead, no warning. One PR cost **1h43m and five CI runs** for three type errors a local `pyright` catches in seconds | **fail-open** · visibility | tabsii-platform (worktrees) | biffo-template `.githooks/` | **fixed** ([#843](https://github.com/keiranholloway/biffo-template/pull/843)) — hooks tracked, present without an install |
| [#844](https://github.com/keiranholloway/biffo-template/pull/844) | `RunOutcome.trigger_payload` unwrapped `trigger_event["payload"]` and fell back to `{}`. Nothing writes that envelope — `dispatch_event` stores the event **flat** and the engine reads it flat — so it returned `{}` for **every real run since the seam shipped**. The module docstring's worked example taught the broken call, eleven lines below a sentence describing `trigger_event` as "the whole triggering payload" | **drift** · visibility | tabsii-platform (observer wrote nothing) | biffo-template `services/api` | **fixed** — flat by default, envelope still unwrapped if genuinely present |
| [tabsii-platform#302](https://github.com/tabsii-com/tabsii-platform/issues/302) | A configuration set with a bounce event destination was **never attached to the identity mail is actually sent as**. Bounces reached account-level `AWS/SES` metrics (which need no configuration set) while the SNS destination saw nothing — the consumer Lambda had **no CloudWatch log group at all**, having never once been invoked. Shipped, green, inert | **boundary** · visibility | tabsii-platform (dev SES) | tabsii-platform `infra/` | **fixed** (#304) |
| — | **SES publishes two different envelopes.** A configuration-set event destination names the type `eventType` and spells the rendering failure `RenderingFailure`; a classic identity notification topic uses `notificationType` and `Rendering Failure`. The handler read one, so its **first ever real invocation** resolved to `None` and dropped the bounce it existed to handle. Same assumed-payload-shape class as the `trigger_payload` row, in the same feature, four hours apart | **drift** · visibility | tabsii-platform (SES consumer) | tabsii-platform `infra/` | **fixed** (#305) |
| [tabsii-crm#118](https://github.com/tabsii-com/tabsii-crm/issues/118) | **RECURRENCE of the row directly above this block**, in a different repo. A lead's Activity timeline inferred `"Nothing sent or logged yet."` from an empty array — and the array is empty in **three** situations: in flight, genuinely empty, and **failed**, because `.catch(() => undefined)` swallowed the error into the same `[]`. So a 403 or 500 told the reader a candidate had never been contacted. The earlier instance was logged **unfiled** and never generalised, so it came back | **visibility** · drift | tabsii-crm (lead drawer) | tabsii-crm `apps/frontend` | **fixed** ([#119](https://github.com/tabsii-com/tabsii-crm/pull/119)) |
| — | **Merging the upgrade that ships tracked `.githooks/` does not arm them.** `core.hooksPath` is per-clone config set by `prepare`, so an existing clone keeps pointing at the old generated dir until someone runs `pnpm install` once. The merge reads as *done* while the guard stays inert — the same shape as the defect it fixes. Verified: a fresh worktree off the merged `dev` still reported `hooksPath=.husky/_` with `.husky/_` absent | **fail-open** · process | tabsii-platform (post-upgrade check) | biffo-template (upgrade notes / `prepare`) | **unfiled** |
| [#374](https://github.com/keiranholloway/biffo-template/issues/374) | The issue **described the worktree-hooks gap in its own body** — *"hooks do not run in a fresh clone… easy to hit when working in a throwaway clone or a worktree"* — called it *"arguably the larger issue"*, proposed two fixes, shipped only the pre-push hook, and closed. The named-but-unfixed half cost **1h43m five days later**. A closed issue is not evidence its stated findings were addressed | **process** | biffo-template#374 | biffo-template (issue hygiene) | **fixed** late ([#843](https://github.com/keiranholloway/biffo-template/pull/843)) |
| [tabsii-crm#128](https://github.com/tabsii-com/tabsii-crm/pull/128) | **A cadence step could not be created at all.** `crm_cadence_steps.brand_id` is `NOT NULL` (denormalised for RLS) and the sibling never supplied it. **Every test built the `CadenceStep` *object*** — and a Python constructor makes you pass `brand_id`, so all of them did. Nothing exercised the HTTP path, the only place the omission exists. Unit suites green on both sides; the feature could not create a step | **drift** · visibility | tabsii-crm (step builder) | tabsii-crm `services/api` | **fixed** — brand derived from the cadence, never the body |
| [tabsii-crm#129](https://github.com/tabsii-com/tabsii-crm/pull/129) | **Every compiled cadence email step failed at dispatch.** The `email` action declares `from` required with no default; the step builder hardcoded `to`/`subject`/`body` without it. Invisible everywhere before a real send — the compile reports success, the definition looks right in the database, and the failure exists only inside the orchestrator **past EventBridge** | **visibility** · drift | tabsii-crm (step builder) | tabsii-crm `apps/frontend` | **fixed** — From field, Add-step disabled without it |
| [tabsii-crm#131](https://github.com/tabsii-com/tabsii-crm/pull/131) | **A merged PR asserted a verification nobody performed.** tabsii-platform#323 built `POST /leads/{id}/status` and its description said *"the CRM is pointed here"*. It was not — the drawer still used the generic `PUT`, so the fix existed in Core, **nothing in the product used it**, and #320 was closed while the failure it described still happened. Caught only by checking which endpoint the *deployed* UI actually calls | **process** · drift | tabsii-platform#323 (PR description) | tabsii-crm `apps/frontend` | **fixed** |
| [tabsii-platform#327](https://github.com/tabsii-com/tabsii-platform/pull/327) | **RLS hardening blocked the write it was designed to permit.** Module `052` gave `lead_cadence_enrolments` a SELECT policy and no others, so a caller could not desynchronise it from its runs. RLS applies to the **endpoint's** session too: the transition matched zero rows, converting a lead 500'd with `StaleDataError`, and the cadence stayed armed. The logic was tested thoroughly **on SQLite, which has no policies** — every one of those tests ran against a session that could write anything | **fail-open** · drift | tabsii-platform (dev, real conversion) | tabsii-platform `db/imports` (053) | **fixed** — policy restored on its own permission code; `__crud_permissions__` was the real guard all along |
| — | **A deploy watcher matched "the newest run named Deploy" without pinning the commit SHA**, and reported success for the *previous* commit's deploy — the new one had not been created yet, by one second. Nearly produced a fabricated defect report ("the fix does not work on dev") from a green signal about the wrong artifact. Earlier watchers in the same session **did** pin the SHA; the inconsistency was the bug | **visibility** · process | session tooling | watcher scripts / habit | **fixed** — SHA-pinned every check afterwards |
| [tabsii-platform#317](https://github.com/tabsii-com/tabsii-platform/pull/317) | **An approved plan specified a mechanism that cannot work.** Cadence steps were to trigger on `lead.captured` with a synthetic `cadence_id` in `trigger_filter` — but `trigger_filter` is an exact match over the *event payload*, and `lead.captured` carries no `cadence_id`. Every compiled step would have been **silently inert**; dropping the filter instead makes two active cadences both fire for one lead. Caught by reading `_matches_trigger_filter` **before** building | **drift** | docs/implementation/0008 M3 (as approved) | tabsii-platform (new `lead.enrolled` event) | **fixed** — plan amended in the same PR |
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
| [#668](https://github.com/keiranholloway/biffo-template/issues/668) | ADR-0022 discovery runs *after* `build_core_crud_router()`, and importing a domain is what registers its models — so relocating a domain silently drops every `/api/v1/data/` route its models back. **21 routes vanished in tabsii with the full suite green (1712 passed)**; no test builds the app the way `main.py` does, so none could have failed | **visibility** · boundary | tabsii-platform [#243](https://github.com/tabsii-com/tabsii-platform/pull/243) | biffo-template `main.py` + `routing/domain_router.py` | **fixed** — template reordered, plus `services/api/tests/test_main_router_ordering.py`, which reads the include order out of `main.py`'s own AST and assembles the route surface with a domain whose model is defined *by the import*. Watched fail on the unfixed tree first; also asserts no domain claims a (path, method) generic CRUD claims |
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
| — | **Relaxing `strict` removes the guard against exactly this.** H3 turned `strict` off on `biffo-template` on 2026-07-28 to end the rebase race. A side effect nobody costed: a branch no longer has to be up to date before merging, so a stale whole-file rewrite is now *more* likely to land silently. The experiment's falsification criteria measure merge friction and say nothing about content loss | **process** | biffo-template branch protection | H3 review 2026-08-04 — add content loss to what the experiment watches | **fixed** ([#977](https://github.com/keiranholloway/biffo-template/pull/977)) — `contention.staleMergeShare` now counts merges whose base moved between the last green run and the merge, so H3 has a counter-metric before its review rather than after |
| — | **A plugin shipped with another plugin's stylesheet.** `biffo-plugin-idea-scout`'s `index.css` was the Ideation Engine's file copied verbatim at scaffold time: every rule keyed on `.ide-*` while the components emit `.candidate`/`.scorecard`/`.run-form`. **0 of 35 class names matched.** 57 rules loaded and styled nothing but bare `button`/`input`, so the app rendered as one run-on line of browser defaults — `.layout` computed to `display: block`, the sidebar was full-bleed at 1920px, rationales ran ~234 characters per line. Every test passed, the build was clean, the CSS returned 200; the only symptom was visual | **drift** · visibility | biffo-plugin-idea-scout | biffo-plugin-idea-scout [#24](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/24) — real stylesheet + a class-coverage guard | **fixed** |
| — | **There was no shared design system, and the canonical tokens lived in the most downstream repo.** The token set existed only in `biffo-platform-app`'s `globals.css` — a sibling app — while the template's own `apps/portal/globals.css` is three lines of Tailwind declaring nothing. Every other surface re-declared or invented its own, so three brand blues were reachable in one page through same-origin iframes | **drift** | biffo-platform-app / plugin frontends | biffo-template [#753](https://github.com/keiranholloway/biffo-template/pull/753) — `@biffo/design-tokens` published to npm | **fixed** — consumers not yet adopted |
| — | **OIDC trusted publishing cannot bootstrap a new package.** Trust registers *against an existing package*, and the package does not exist until its first publish — so the first release of `@biffo/design-tokens` had no credential path at all. `NPM_TOKEN` returned 404, and OIDC returned the same 404 even with npm upgraded to 12.0.1 (well past the 11.5.1 threshold). npm answers 404 rather than 403 for unauthorised writes, so all three causes looked identical | **process** · visibility | biffo-template publishing | one manual publish, then register the trusted publisher | **partly fixed** — package published; trusted publisher **still unregistered**, so the next tag's publish will 404 |
| — | **`biffo:ddl-import` skips applied files by filename, so amending a seeded row by editing its `.sql` does nothing.** The workflow seed for Idea Scout's synthesis agent needed a *new* file (`005_…`) to add `output_tools`; editing `003_…` would have been a silent no-op everywhere it had already run | **visibility** | biffo-platform `db/imports/` | practice, not code — documented in the new file's header | **worked around** |
| — | **A repo created by `plugin create --standalone --org` is born unable to merge anything.** A brand-new repo has no `RUNNER_LABEL`, so the skeleton's `runs-on` default of `ubuntu-latest` falls back to hosted runners the account cannot pay for — every job fails **before it starts** — while the same command has just configured branch protection requiring those exact six jobs. Protection demanding checks that can never report blocks every PR for ever. Every unit test passed; all remote calls were behind fakes | **boundary** · fail-open | biffo-template [#809](https://github.com/keiranholloway/biffo-template/pull/809) (found by live run, not by CI) | biffo-template `cli/` | **fixed** ([#810](https://github.com/keiranholloway/biffo-template/pull/810)) — mirror the label, and set it *before* the push that triggers the first run, cost ~35m |
| — | **A release workflow's trigger was decorative, and the symptom was silence.** `publish-design-tokens.yml` declared `on: push: tags: ['core-v*']`, which can never fire: `core-tag.yml` pushes those tags with the job's `GITHUB_TOKEN`, and GitHub suppresses events created by it to stop workflows recursing. That gap was already known — the CLI dispatch exists *because of it* — but the dispatch named `publish-cli.yml` and nothing else, so the next release workflow inherited the original bug. **Three tags (0.153.0/.1/.2) cut with zero runs**; npm kept serving the hand-published 0.152.0. The tell was in plain sight and read past: every `Publish CLI` run is `event: workflow_dispatch`, never `push` | **fail-open** · visibility | biffo-template `.github/workflows/` | biffo-template — the dispatch step now loops over the release list, and `release-dispatch.test.ts` derives the expectation from the workflow directory rather than a hardcoded name | **fixed** — verified by the next tag publishing `0.154.1` unattended |
| — | **`biffo doctor` shipped calling the mandated working state an error.** AGENTS.md §2 requires the *primary* checkout on `dev`; §1 requires all work in a *linked worktree* on its own branch. The command could not tell them apart, so it exited `1` on every worktree in the estate — a diagnostic that cries wolf where all the work happens is one nobody runs twice. Its 34 tests were correct about what they modelled; nothing modelled "which kind of checkout am I in" | **visibility** | biffo-template [#812](https://github.com/keiranholloway/biffo-template/pull/812) | biffo-template `cli/` | **fixed** ([#813](https://github.com/keiranholloway/biffo-template/pull/813)) — asks git whether it is the primary; found ~4h after shipping, by running it rather than by a test, cost ~25m |
| — | **A workflow that warns-and-skips still reports `success`, so green says nothing about whether it did the work.** `publish-registry.yml` deliberately exits 0 when `REGISTRY_PUBLISH_TOKEN` is absent, so a missing credential never reds an otherwise good merge. The cost of that choice: the run conclusion cannot distinguish *published* from *skipped*, and the only evidence is the step list or the annotation. Deliberate trade-off, but it is the page's own headline class and was introduced knowingly | **fail-open** | biffo-template (this session) | biffo-template `_skeletons/`, plugin repos | **accepted** — verification must read the steps, never the conclusion |
| — | **A credential nobody could mint blocked automated work.** The push path needs a cross-repo PAT; an agent cannot create one, so the immediate-publish half of the registry sat unavailable while everything around it shipped. The durable answer was not the token: `plugin create --standalone` now registers a new plugin in the registry's `sources.json` using the operator's existing auth at create time, which needs no stored secret and covers the larger gap (a new plugin never appearing at all) | **process** | biffo-plugins-registry [#4](https://github.com/keiranholloway/biffo-plugins-registry/issues/4) | biffo-template `cli/` | **mitigated** ([#814](https://github.com/keiranholloway/biffo-template/pull/814)) — credential-free day-one registration; hourly pull ([registry#5](https://github.com/keiranholloway/biffo-plugins-registry/pull/5)) bounds the rest |
| — | **Two ways of getting Python in one repo, and the one I added does not work on the runner fleet.** `publish-registry.yml` used `actions/setup-python`, which fetches a prebuilt interpreter from `actions/python-versions` — no build matches the self-hosted fleet's OS, so every run died on "The version '3.13' with architecture 'x64' was not found". The same repos' `ci.yml` gets 3.13 on those runners via `astral-sh/setup-uv`, which installs it. Invisible for weeks because the job exited before reaching that step | **drift** | biffo-plugin-ideation, biffo-plugin-idea-scout (live run) | biffo-template `_skeletons/`, both plugin repos | **fixed** ([ideation#64](https://github.com/keiranholloway/biffo-plugin-ideation/pull/64), [idea-scout#40](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/40), [#816](https://github.com/keiranholloway/biffo-template/pull/816)), cost ~20m |
| — | **A workflow reported `success` with all 11 steps green while its write path had never executed once.** Every `publish-registry` run exited at "Registry entry already current — nothing to publish", so read access was exercised and write access never was. Step-level green was not evidence either — only deliberately breaking the registry entry, so there was something to write, proved the token could push. The correcting bot commit is the first write in the mechanism's history | **fail-open** | biffo-plugins-registry [#4](https://github.com/keiranholloway/biffo-plugins-registry/issues/4) | verification practice | **proven** — perturb-then-correct; a no-op path cannot be verified by observing it succeed |
| — | **`raw.githubusercontent.com` served a stale value while the API showed the commit had landed**, so the verification of the above reported "WRITE NOT PROVEN" when the write had in fact succeeded seconds earlier. Trusting the CDN would have concluded the operator's freshly-minted token was read-only, and sent them back to regenerate a credential that was fine | **visibility** | biffo-plugins-registry (this session) | verification practice | **avoided** — check `gh api .../contents` or the commit list, never the raw CDN, when the question is "did this just change?" |
| — | **A cleanup was declared impossible after asking only one of the two available questions.** 35 leftover branches had no PR of any state, so they were reported — in the issue, in writing — as "indistinguishable from unlanded work; no safe rule touches them". GitHub had been asked *was there a PR?*; git was never asked *does this branch contain anything?*. It does answer: `git merge-base --is-ancestor` proved **32 of 34** fully contained in `dev`, and `git branch -d` — the refusing, non-forcing delete — accepted every one. Only 2 held unique commits | **process** | biffo-template [#798](https://github.com/keiranholloway/biffo-template/issues/798) | verification practice | **corrected same day** — 68 branches → 24, 18 worktrees → 6, doctor errors 3 → 0, cost ~30m |
| — | **Nothing reaps a worktree once its PR merges, so they accumulate exactly as branches do.** 18 worktrees across three repos; 12 sat on already-merged PRs, all clean. AGENTS.md §1 tells the operator to remove them and nothing checks. `core upgrade --reap` ([#795](https://github.com/keiranholloway/biffo-template/pull/795)) covers only `biffo/core-upgrade-*` branches and no worktrees at all | **process** | all three repos | biffo-template `cli/` | **detected** ([#812](https://github.com/keiranholloway/biffo-template/pull/812) `doctor` reports both); reaping is still manual — and manual is not enough: within ~20 minutes of the sweep finishing, other sessions had merged, leaving fresh stale branches, two worktrees on merged PRs, and both instance primaries behind again |

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
| — | **`id -nG` answers a different question than "is this user in the group", and the difference was read as an environment limitation.** A shell process inherits its group set at session start, so a group added afterwards is absent from `id -nG` **for the life of that process** while `getent group docker` and `id -nG <user>` both show it. Concluded "the user is not in the docker group", built a session-long narrative on "Postgres cannot be run locally", paid **4 CI round trips** on one test file for bugs a local run catches in seconds, and recommended to the user that they be added to a group they had been in all along. `sg docker -c '<cmd>'` re-reads the user database and works with no re-login and no sudo. Verified after: the same suite runs locally in **3.4s** | **visibility** | this machine (diagnostic practice) | practice — check the user database, not the process | **fixed** — `sg docker` recipe recorded; cost ~4 round trips + one wrong recommendation |
| — | **A closing keyword fires from inside a sentence that denies it.** A squash-merge body containing `## This does NOT close #76` **closed tabsii-platform#76**, at the same second it merged. The parser is lexical — it matches the token `close #76` and does not read the negation. Caught only by habitually re-listing open issues after the merge; an issue wrongly closed with a green PR attached reads as legitimately done. The **inverse** is already on this page (an owner-less `closes repo#N` that silently never fires), so the same parser fails in both directions and warns in neither | **visibility** · process | tabsii-platform [#277](https://github.com/tabsii-com/tabsii-platform/pull/277) | practice — never write a closing keyword in prose, even to deny it | **fixed** — reopened; rule recorded |
| — | **A guard that asserted the parameters instead of the statement, and passed with the clause it guarded deleted.** `whoami`'s test checked `session.params == {"uid": USER_ID}` to prove the query is scoped by the caller. The parameter is bound whether or not the SQL uses it, so deleting the entire `WHERE ura.user_id = :uid` left all 9 tests green. That clause is the **only** scoping on a `get_admin_db` (BYPASSRLS) session — its removal returns every assignment in the deployment, with no policy to catch it. Found by §3 mutation testing, not by review | **fail-open** | tabsii-platform [#272](https://github.com/tabsii-com/tabsii-platform/pull/272) | tabsii-platform tests | **fixed** — asserts the statement text; measured 3 of 4 mutations now caught, the fourth (`ORDER BY`) deliberately left to the Postgres file |
| — | **A required-check list that omits the check you just built makes it decoration.** `RLS (real Postgres)` ran on every PR but was not a required context, so `gh pr merge --auto` was armed on a PR with the lane **red** and every required check green. Auto-merge gates on *required* checks only; it would have landed Postgres tests that all failed. Same shape as the `allow_auto_merge=false` row above — **a check you did not make required is not a check** | **fail-open** | tabsii-platform [#272](https://github.com/tabsii-com/tabsii-platform/pull/272) | tabsii-platform branch protection | **fixed** — added to the required set on `dev`, `staging` and `main` together, so the three do not drift |
| — | **`git commit --amend -F msg.txt` updates the message and silently keeps the old tree if nothing was staged.** CI then re-ran a byte-identical broken file, and the repeated failure read as "the fix did not work" rather than "the fix was never committed". AGENTS.md §4 says to confirm the remote has your commit — that was done, and it passed: the **SHA matched**. A matching SHA proves the push landed, not what is in it. `git show origin/<branch>:<path>` is the check that actually settles it | **visibility** · process | tabsii-platform [#272](https://github.com/tabsii-com/tabsii-platform/pull/272) | AGENTS.md §4 wording + practice | **unfiled** — one wasted CI round trip; the rule should say *verify the content, not the SHA* |
| — | **Two RLS policies compose, and the inner table gates the outer one.** `users_read` decides visibility by reading `tabsii.user_role_assignments`, which has its own RLS requiring `user_role_assignments.read`. A caller without that permission therefore sees **nobody, including themselves** — the outer policy looks broken while the real cause is a missing grant one table down. A test fixture whose role held no permissions produced empty reads that looked like a tenancy bug | **boundary** | tabsii-platform [#277](https://github.com/tabsii-com/tabsii-platform/pull/277) | tabsii-platform tests + the property itself is by design | **fixed** in the fixture; the composition is now documented where the next person will hit it |
| — | **`str(make_url(...))` renders the password as a literal `***`.** SQLAlchemy masks it in the string form, so a DSN assembled that way looks correct in every log line and cannot authenticate. Cost one CI round trip on `InvalidPasswordError`. `render_as_string(hide_password=False)` is the spelling that carries it. Benign only by luck here — the tests failed loudly on connect, but a masked DSN that happened to connect as the owner would have passed them all while proving nothing | **visibility** | tabsii-platform [#277](https://github.com/tabsii-com/tabsii-platform/pull/277) | tabsii-platform tests | **fixed** |
| — | **The stale-base clobber recurred on the same file it was recorded in, the same week.** [#774](https://github.com/keiranholloway/biffo-template/pull/774) appended **3 lines** of prose to this page and deleted **93** — the entire *Skills used* table (48 rows of skill evidence, from every session that had run one) and *Adding a row*, the section that tells the next person how to contribute. Its commit message describes only an extractor change and never mentions the deletion; CI was green; no conflict was raised. The scoreboard already carried *"3 sessions' documentation deleted by one stale-base merge — 215 insertions, 322 deletions, no conflict"*, and the recurrence removed the very table that records whether practices are working | **process** · visibility | biffo-template `docs/guides/development-practices.md` | biffo-template — the editing convention still does not exist | **restored** here from `dab7c79^`; the *cause* is **open** — nothing detects a docs PR whose deletions dwarf its insertions |
| — | **A debug convenience keyed on an environment *name* copied the most sensitive columns into a store with a completely different access boundary.** `create_async_engine(..., echo=settings.environment == "dev")` — and SQLAlchemy's echo does not log statements, it logs statements **with their bound parameters**. Every deployed dev environment therefore wrote clear-text agent transcripts (`agent_runs.messages`), result payloads, the founder-profile snapshot inside each `input_payload`, and `owner_sub` beside the rows it owns into CloudWatch: **135 parameter-payload lines in one 48-hour sample**, the same in a second instance's account, retention **365 days**. The severity is not verbosity, it is that `logs:FilterLogEvents` is granted far more widely than RDS access and no log group's *name* says it holds user content — so it silently undid a seam Core fails **closed** on, `/api/v1/internal/*` correctly refusing a non-allowlisted principal while the same rows sat readable in the log group. `dev` is a shared deployment, not a laptop; a setting that infers "safe to dump data" from an environment string cannot tell the difference | **boundary** · visibility | biffo-platform [#85](https://github.com/keiranholloway/biffo-platform/issues/85), also live in tabsii-platform | biffo-template `services/api` ([#784](https://github.com/keiranholloway/biffo-template/pull/784)) | **fixed** upstream — explicit `sql_echo`, off everywhere, plus `hide_parameters=True`. Reaches instances only via `biffo core upgrade`; the **already-written logs in both accounts are untouched** and purging them is still **open** |
| — | **The reported caller was 1 of 4, and the one nobody reported was the dangerous one.** The `echo` leak above was reported against the request-path engine. Three further `create_async_engine` calls had no `hide_parameters` — and `db_app_role.py` runs `CREATE ROLE … PASSWORD`, so a failing statement there puts the app role's generated password in a `StatementError` traceback. That route was never controlled by `echo` at all: SQLAlchemy embeds bound values in `StatementError` messages whether echo is on or off, so "turn the flag off" would have closed the reported hole and left a worse one open in a file nobody was looking at. This is the same shape as the `is_active` drift row (#621) and the "known trap fixed for one workflow by name" row — **a fix scoped to the reporter's symptom rather than the defect's class** | **drift** | biffo-template `services/api` (4 engines) | biffo-template ([#784](https://github.com/keiranholloway/biffo-template/pull/784)) | **fixed** — the guard walks the AST for *every* `create_async_engine`/`create_engine` under `src/` and `migrations/`, so a new engine without the flag fails the test rather than relying on a hand-kept list |

| — | **Reading correct data through a self-attached label, and inverting its meaning — twice in one day.** `aws sesv2 get-account` was queried with `ProductionAccessEnabled` aliased to a jq key named `sandbox`; it returned `false`, which was read as *"sandbox: false → out of the sandbox"* when it means production access is **disabled**. The account is sandboxed and can email only verified identities. That advice then shaped a plan for tabsii-crm#52. Earlier the same day, `id -nG` was read as the user's group memberships (it is the calling **process's** inherited set) and produced "not in the docker group" for a user who was. **Neither was a wrong command — both were the right data under a name the reader had chosen, and the name won over the field** | **visibility** | diagnostic practice (tabsii-platform, this machine) | practice — never alias a field to a word that could mean its negation | **corrected** in tabsii-platform#286's body and here; the *class* is unfiled and has now recurred once. Settled independently and far more convincingly by [tabsii-platform#282](https://github.com/tabsii-com/tabsii-platform/issues/282): a real workflow addressed to `{email}` failed with `SES send failed: MessageRejected`. **A failing send is unambiguous in a way a settings field under a name you chose is not** |
| — | **A harness that exists and a harness that covers are different claims.** tabsii-crm#65 read as "no E2E harness" for three weeks while a full Playwright setup sat in CI — real static export, real browser, containerised job. Its only spec drove a **test-only route** that renders `null` outside E2E and mounts one component with inline fixtures, so against the issue's own goal ("the real app shell, navigation, API wiring, and user journey together") it covered **none of the four**. `e2e/fixtures.ts` said so in its header. The issue's first two acceptance boxes were tickable and its purpose was not met | **fail-open** · visibility | tabsii-crm [#65](https://github.com/tabsii-com/tabsii-crm/issues/65) | tabsii-crm [#116](https://github.com/tabsii-com/tabsii-crm/pull/116) | **fixed** — signed-in fixture + 5 flows through the real shell; the acceptance criteria now match the purpose |
| — | **The data an email needed was in hand and simply not published.** tabsii-crm#52 ("the invitation email must name the granted role and scope") was framed as an email-delivery problem needing SES work. Half of it was an **event-payload** problem needing none: `invite()` looks the role up for its tenant and holds the scope column it is about to insert, and `user.invited` carried `role_id` (a UUID) and no scope at all — so a custom SES send, a Cognito `CustomMessage` Lambda and the orchestration engine this instance already runs all had nothing to render. **An issue's stated blocker can hide an unblocked half** | **visibility** | tabsii-crm [#52](https://github.com/tabsii-com/tabsii-crm/issues/52) | tabsii-platform [#286](https://github.com/tabsii-com/tabsii-platform/pull/286) | **fixed** — `role_name`/`scope_kind`/`scope_label` declared and emitted; the email itself still waits on DNS + production access |
| — | **`allow_auto_merge` is `false` on `tabsii-crm` while every other active repo has it `true`.** `gh pr merge --auto` does not degrade — it is **rejected outright** (`Auto merge is not allowed for this repository`), so a wait-loop built on it reports failure and the PR sits unmerged until someone notices. This page already carries a row saying the setting was aligned across repos on 2026-07-27; that claim is now stale in one repo, and nothing reconciles "settings we believe are set" against "settings that are set" | **drift** · process | tabsii-crm [#116](https://github.com/tabsii-com/tabsii-crm/pull/116) | tabsii-crm settings — **deliberately not changed**: `biffo-workflow` records tabsii-crm as the `strict` comparator for H3 and it is unclear whether auto-merge is part of that | **open** — flagged on the issue, decision left with the owner |
| — | **An issue can be complete and open, with nothing detecting it — including its own author.** tabsii-crm#100's two remaining milestones both shipped (#112, tabsii-platform#267). A comment was left saying M1 was "pending the remaining PR checks", the PR merged, and nobody returned. Found only by habitually re-listing open issues after an unrelated merge. This is the same drift the whole backlog pass existed to correct, committed *during* that pass | **process** · visibility | tabsii-crm [#100](https://github.com/tabsii-com/tabsii-crm/issues/100) | practice — re-check issues whose PRs merged, not just issues you edited | **fixed** — closed with evidence re-verified rather than recalled (the deployed bundle hash had changed since the earlier check) |
| — | **`aws logs ... --query 'length(events)'` returns a count PER PAGE, and the CLI auto-paginates.** Taking the first number gives one page's count and reads exactly like a total. It produced two wrong answers of very different severity in one session: an exposure reported as **135 lines** that was actually **7,772** (a 57× undercount, quoted to the user before it was checked), and then a purge script reporting **"0 kept"** for a log group that had 16 streams needing to be kept — read literally, that was about to justify an **irreversible delete** of live data. The same shape as the `id -nG` row: a command that answers a *slightly different question* than the one asked, and answers it plausibly. `--query '<list>' --output json` then counting client-side across concatenated pages is the spelling that is actually a total | **visibility** | biffo-platform CloudWatch (measurement, not code) | practice — never let `length()` cross a paginated CLI | **fixed** in practice; the count was re-derived client-side and the dry run re-run before deleting. **Nothing enforces this** — no gate exists for "a number you measured with the wrong tool" |
| — | **A *configured* retention of 365 days was quoted as the exposure window; the oldest actual event was 7 days old.** The claim "365 days of clear-text transcripts in two accounts" came from `retentionInDays`, which is a ceiling, not a description of what is stored. Measured: biffo-platform's oldest core-api event was 2026-07-21 — the setting overstated the real window by ~52×. The same paragraph also called the exposure "complete agent transcripts"; measuring line lengths showed max 1,345 chars, median ~140, **zero** lines over 10 KB — high-volume *identifier* exposure (7,225 of 7,772 lines carried a UUID), not transcript dumping. Both errors inflate severity, which is the direction that still costs trust | **visibility** | biffo-platform (incident characterisation) | practice — measure the data, never quote the config | **fixed** — corrected to the user in the same session, before any remediation decision was made on the wrong number |
| — | **A finding delegated to a sub-agent had its *code claims* verified and its *measurements* repeated verbatim.** The agent's assertions about the source were all checked and all true. Its numbers — "135 parameter-payload lines", "365-day retention", "complete agent transcripts" — were carried into a PR body, a scoreboard row and a user-facing summary without being re-measured, and all three were wrong. Verifying a delegated result has two halves and only one of them is instinctive; the same session separately found the agent's *scope* too narrow (1 of 4 engines), so both non-obvious halves failed on the same hand-off | **process** · visibility | biffo-platform#85 hand-off | practice + `biffo-verify` §8 wording | **unfiled** — §1–§7 are all about verifying assertions; nothing prompts "re-measure its numbers" or "what did it not look at?" |
| — | **A template-owned test encoded the template's own file layout as though it were universal, so it could only fail downstream.** The `hide_parameters` guard walked every `.py` under `src/`. The template keeps all tests under `tests/` at the service root, so that was indistinguishable from "scan production code" *here* — it passed every gate, shipped in 0.157.1, and failed CI on the first instance it reached: biffo-platform's domain-driven layout puts fixture engines in `src/api/domains/<domain>/tests/`. Cost a full extra distribution lap (template PR → release → npm publish → re-cut the instance upgrade). tabsii has the same layout and would have been the second casualty | **drift** | biffo-platform#93 (CI) | biffo-template [#787](https://github.com/keiranholloway/biffo-template/pull/787) | **fixed** — exclusion matches a `tests` *path component*; the rule is now asserted on synthetic paths including the instance layout this repo has no example of, because a rule that can only fail on someone else's tree never gets tested here |
| — | **A guard written for the reported repo found two unreported engines in a different one, including a password path.** The upstream `hide_parameters` fix reached the one engine the template has. tabsii has two more the template cannot see: `admin_engine` (master/owner, **BYPASSRLS** — so echoed parameters carried *cross-tenant* rows, plus identity resolution and the public lead-capture insert, i.e. personal data from unauthenticated visitors), and `_apply_app_role`'s engine, which is handed the Terraform-generated app-role password to run role DDL. Neither was reported by anyone. This is the case the AST-walking guard was written for, and the argument against a hand-kept file list | **drift** | tabsii-platform (found by the guard, not by a report) | tabsii-platform [#284](https://github.com/tabsii-com/tabsii-platform/pull/284) | **fixed** — though `hide_parameters` covers the SQLAlchemy layer only; the password reaches `pg.fetchval` on the raw asyncpg connection, and whether asyncpg's exceptions carry bound arguments is **explicitly not claimed** |

| — | **§1 checks the issue in front of you, not the repo around it — and with several sessions running, that is where the answer already was.** [tabsii-platform#282](https://github.com/tabsii-com/tabsii-platform/issues/282) ("SES is in the sandbox; publish DKIM, request production access") was filed at **09:08**. It was found at **11:20**, after two hours spent working on tabsii-crm#52 — whose blocker it *is* — and after writing a scoreboard row about misreading the sandbox state. Nothing was duplicated, but the sandbox state was re-derived independently **and got wrong**, while a two-hour-old issue had it right with better evidence. The §1 commands search by issue number and by error string; neither surfaces *"what else is in flight in this repo right now"* | **visibility** · process | biffo-template (this session) | practice — `gh issue list --state open` on the repo you are about to touch, not just the issue you were handed | **unfiled** — cost ~2h of an avoidable wrong belief, though not 2h of wasted work |
| — | **Five milestones of candidate-facing email passed because every one was addressed to the same hand-verified mailbox.** SES on dev is sandboxed, so it rejects any unverified recipient — but every workflow built to date sent to `keiran@tabsii.com`, the one verified identity. The gate was never exercised, so it never failed, and the first genuinely external recipient (`{email}` on a "Thanks for registering" workflow) hit `MessageRejected` in front of a real user. **A constraint you never test looks identical to one you have satisfied** | **fail-open** | tabsii-platform [#282](https://github.com/tabsii-com/tabsii-platform/issues/282) | tabsii-platform (#280/#281 put the identity + config set in code; production access still to request) | **open** — recorded here because it is the strongest instance yet of this page's own headline: green is not evidence |
| — | **A published version bump is not proof YOUR change shipped.** Waited for `npm view @biffo/cli version` to change, saw `0.160.0`, and reported the feature released. It was **#795 — another session's CLI change**; my PR was still one commit ahead of that tag. Caught only by grepping the tag's *contents* and finding one `idempotency_key` field where there should have been two. With several agents merging concurrently, "the version changed" answers *a* question, just not the one asked — the third instance in one session of a plausible signal answering a slightly different question, after the paginated `length()` and the retention ceiling. The reliable check is `git show <tag>:<path>` for the thing you added | **visibility** | biffo-template releases | practice — verify the tag's content, never the version number | **fixed** in practice; re-verified all five pieces in `core-v0.161.0` by content before upgrading. **Nothing enforces it** — no tooling links a release tag to the PR that caused it |
| — | **The one admin view that would have exposed months of double-billing cannot group by what makes runs duplicates.** `AgentRunSummary` omits `causation_id`, so the agent-runs list — the surface an operator actually scans — cannot group runs by chain. Two `idea-scout-synthesis` runs one second apart on the same chain render as two ordinary rows. Establishing that #661 had fired required an **N+1 fetch of every detail record** through the API. The data was always there; the shape that makes the defect legible was not | **visibility** | biffo-platform admin portal | biffo-template `services/api` (`AgentRunSummary`) | **unfiled** — add `causation_id` to the summary, or a chain grouping/filter to the list |
| [#22](https://github.com/keiranholloway/biffo-plugin-idea-scout/issues/22) | **A deploy step skipped an admin-UI build for a plugin that declared one, silently, for every environment.** The condition was `if jq -e '.admin_ingress' … && [ -d "$plugin_dir/web-admin" ]` — declare the ingress with no `web-admin/` and the build is skipped with **no error and no warning**, the deploy reports success, and `GET /admin/` 404s. A CDN rule then rewrites that 404 into the marketing portal's HTML (#647), so the visible symptom is an admin URL apparently serving an **unauthenticated page**. Same fail-open shape as the audit gates in #591/#644. Patching it, I asserted the occurrence count expecting two (the line numbers in the issue) and found **three** — `deploy-prod` carries the same block | **fail-open** · boundary | biffo-plugin-idea-scout (admin URL) | biffo-template [#793](https://github.com/keiranholloway/biffo-template/pull/793) + the plugin [#30](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/30) + vendored resync [platform#97](https://github.com/keiranholloway/biffo-platform/pull/97) | **fixed** — deploy now fails loudly; declaration removed at source and in the vendored copy |
| — | **Shipping a new deploy-time gate can red an instance whose vendored copy is stale, and the ordering is invisible until it fails.** The guard above was correct and `biffo-platform`'s **vendored** `services/idea-scout/biffo.plugin.json` still declared `admin_ingress` — so the first core upgrade carrying the guard would have failed that instance's deploys. Merging the plugin repo does not reach the vendored copy; that needs its own resync PR. Caught before it fired, by checking both vendored manifests against the new condition rather than assuming the source fix propagated | **boundary** · process | biffo-platform deploys (predicted, not suffered) | ordering: plugin → vendored resync → core upgrade | **avoided** — resync landed first. **The general case is open**: nothing warns that a new gate will fail on an instance's current tree |

| [#22](https://github.com/keiranholloway/biffo-plugin-idea-scout/issues/22) | **A milestone was closed by a manifest declaration rather than a delivery, and the tracker then asserted the opposite of the truth for a fortnight.** Idea Scout's M5 — *"admin surface: build types, seeds, admin UI"* — is CLOSED. There was never a `web-admin/` directory: not in the repo, **not in any commit in its history**, not in the vendored copy, not in the deployed package. Declaring `admin_ingress` in `biffo.plugin.json` was enough to close it. So v1 success criterion 5 (*"an admin can add/edit/deactivate build-type categories in a UI without a code change"*) was unmet while the epic read complete, and changing a build type required an API call or a DB write. Verified before rebuilding, with `ideation` as a control proving the check works: its `web-admin` IS present in all three places | **visibility** · process | biffo-plugin-idea-scout (the epic itself) | biffo-plugin-idea-scout [#36](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/36) | **fixed** — the UI now exists and renders on dev. The general defect is **open**: nothing checks that a milestone's *acceptance criteria* were met before it closes |
| — | **A copied Vite `base` sent one plugin's admin UI to another plugin's asset path, and NO gate could see it.** `web-admin/vite.config.ts` was scaffolded from ideation's and kept `base: '/api/v1/plugins/ideation/admin/'`. The deployed page loaded its HTML (correct title) and rendered **blank**: `GET …/idea-scout/admin` 200, then `GET …/**ideation**/admin/assets/index-KqUfZSuT.js` **503** — idea-scout's own asset *filenames* under the wrong plugin's *path*. eslint, tsc, 15 unit tests and `vite build` itself all passed, because `base` only affects URLs **inside the emitted HTML** and nothing that runs locally requests them. Found solely by loading the page and reading the network log | **drift** · visibility | biffo-plugin-idea-scout (deployed page) | biffo-plugin-idea-scout [#38](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/38) | **fixed** — plus two guards that do run per-PR: the configured base, and the **built** `index.html`'s asset refs. Both proven to fail against the shipped config |
| — | **An edit whose anchor did not match reported success, shipped a half-feature, and left a validation guard dead behind it.** The API accepted `preferences`, validated their shape, echoed a stored value back — and discarded the input, because `app.py` never passed `body.preferences` to the service. The `python -c` replacement targeted a multi-line call site; the real code was one line; **every other edit in that batch asserted its anchor and this one did not**. Two things made it invisible: the service tests call `start_run` with preferences *directly* and the frontend tests assert `onStart` *receives* them — **both ends covered, the seam between them not** — and the response echoed a plausible-looking `[]`. The second-order finding is worse: the unknown-key 422 could **never fire**, because the keys it validates never reached the service holding it. A guard behind a broken pass-through is not a guard | **process** · visibility | biffo-plugin-idea-scout (live run on dev) | biffo-plugin-idea-scout [#39](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/39) | **fixed** — six transport-level tests; four fail against the shipped code, including `assert 201 == 422` for the dead guard |
| — | **A guard that bans a spelling blocks the correct fix that legitimately contains it — twice in one day.** #30's guard asserted `"parent.parent.parent" not in admin_app.py`; hours later it **rejected the correct fix**, because ideation's proven `_resolve_static_dir` keeps exactly that expression as its local-dev fallback. Then, writing the base-path guard, the same shape recurred: *"the config mentions no other plugin"* failed on the **comment explaining the bug**, which names ideation's path deliberately. The defect in both cases was never the token — it was the absent property (a `BIFFO_PLUGINS_ROOT` anchor; a correct `base`). Both guards were rewritten to assert the property | **process** | biffo-plugin-idea-scout (twice) | practice — assert the property, never the spelling | **fixed** both; the rule is now stated in both test files so the next person meets it where they would repeat it |
| — | **A unit test that encodes its own premise passes forever while the deployed path does nothing.** A run-outcome observer read `trigger_payload`, which unwraps `event["payload"]`. `WorkflowRun.trigger_event` stores the payload **flat**, so the unwrap returned `{}`, the lead id was never found, and the observer's designed early-return meant it wrote nothing and logged nothing for its entire existence. Ten unit tests passed because the fixture was written as `trigger_event={"payload": {...}}` — the assumption, not the shape. Found only by opening the deployed page and seeing "Nothing sent or logged yet" on a lead whose automation had demonstrably succeeded. The generalisation: when a test author also invents the fixture for an external contract, the test proves the author's belief, not the contract — one real sample from the running system (`/api/v1/orchestration/runs`) settled it in a minute | **visibility** · drift | tabsii-platform | tabsii-platform [#301](https://github.com/tabsii-com/tabsii-platform/pull/301) | **fixed** — fixture corrected to the real shape, and the four write-path tests watched failing against the old implementation first |
| — | **A CloudWatch metric datapoint was read as proof of a specific send, twice, and was wrong both times.** `AWS/SES` `Send` was used to conclude "the automation still works after being repointed" and later "the automation has stopped". Neither followed: the metric is account-wide and 5-minute bucketed, and a **second, unknown automation** was also sending on every lead capture — visible only once the activity timeline attributed each row to its automation by name. Two hours of diagnosis were spent on a regression that never existed. An aggregate metric can support "something happened somewhere"; it cannot attribute. Attribution needs a per-entity record, which is what the feature under construction was *for* | **visibility** | tabsii-platform (dev) | practice — never attribute an aggregate metric to a specific action | **fixed** — run history (`/orchestration/runs`) is the attributable source and answered it immediately |
| — | **`git commit --amend >/dev/null 2>&1` silenced a hook failure, and the push then succeeded carrying none of the work.** A lint hook rejected the amend; the redirect hid it; `git push` pushed the *unamended* commit. **`pre-push` pyright passed** — it type-checks the working tree, which had the fixes, not the commit, which did not. CI then failed on the three errors already fixed locally. AGENTS.md §4 warns that a push can fail while looking successful; this is the inverse — a push succeeding while carrying nothing, with a green local gate agreeing. Never redirect a git command that runs hooks | **visibility** · process | tabsii-platform | practice — `AGENTS.md` §4 deserves the inverse case | **unfiled** — worth a line in §4 |
| — | **Infrastructure can be correctly wired and still never fire, and every component reports healthy.** An SES-bounce consumer Lambda deployed, its SNS subscription **confirmed**, its IAM correct — and it has never been invoked. A deliberate bounce raised `AWS/SES` `Bounce` = 1 (account-level, needing no configuration set) while the SNS destination (which does need one) saw nothing, so the send is not resolving through the configuration set the event destination hangs off. Nothing in Terraform, the console or the metrics says "this path is dead"; the only signal was the **absence of a CloudWatch log group**, which is what "never invoked" looks like | **visibility** · boundary | tabsii-platform | tabsii-platform [#302](https://github.com/tabsii-com/tabsii-platform/issues/302) | **filed** — feature shipped inert |
| [ideation#58](https://github.com/keiranholloway/biffo-plugin-ideation/issues/58) | **A closing keyword on a satellite-repo PR closes the issue at *merge*, and in a plugin repo merge is not a deploy boundary.** `dev.biffo.io` serves the copy vendored in the instance, so #58 was auto-closed by [ideation#60](https://github.com/keiranholloway/biffo-plugin-ideation/pull/60) at 10:11:03 while the panel it was filed against was byte-for-byte unchanged. Seven hours later the reporter re-reported the same symptom. Nothing distinguishes "merged" from "reachable by the person who reported it", and the closing keyword asserts the stronger claim | **process** · visibility | biffo-plugin-ideation [#58](https://github.com/keiranholloway/biffo-plugin-ideation/issues/58) | biffo-platform resync [#101](https://github.com/keiranholloway/biffo-platform/pull/101); general fix is the preflight drift check ([#729](https://github.com/keiranholloway/biffo-template/issues/729)) | **open** — 4th recurrence of the resync row above. `cost ~35m` |
| [ideation#65](https://github.com/keiranholloway/biffo-plugin-ideation/pull/65) | **A manifest key is silently ignored when a sibling flag is set, and the ignored copy was a full duplicate of a live prompt.** `chat_agents_dynamic: true` makes Core's `register_plugin_chat_agents()` `continue` past the entire manifest, so ideation's `chat_agents` block — 1221 bytes of `CHALLENGER_INSTRUCTIONS` — had never been read by anything. Nothing warns that a declared key is unreachable, and **no test could catch the unreachable copy drifting, because nothing executes it**. Still byte-identical when removed, so latent rather than realised | **drift** | biffo-plugin-ideation | biffo-plugin-ideation [#65](https://github.com/keiranholloway/biffo-plugin-ideation/pull/65) | **fixed** — block removed, regression test pins its absence |
| [ideation#66](https://github.com/keiranholloway/biffo-plugin-ideation/pull/66) | **Two independent silent failures in one 40-line function, found hours apart because each surfaced through a different symptom.** The analyst ran on `anthropic/claude-opus-4-8` — absent from all 367 models OpenRouter serves — *and* depended on the `web_search` registry tool, which is only offered where a Brave key exists (this account's is the empty string). Either alone would have been invisible; together they meant competitive research was fabricated. The challenger's adjacent, valid `claude-sonnet-4` is what made it read as flakiness. **Neither was found by reading the module; each was found by chasing a separate report** | **fail-open** · drift | biffo-plugin-ideation | biffo-plugin-ideation [#66](https://github.com/keiranholloway/biffo-plugin-ideation/pull/66) + vendored resync [platform#104](https://github.com/keiranholloway/biffo-platform/pull/104) | **fixed and verified end to end** — `:online`, `tools` dropped, prompt forbids unsourced competitors. Proven on dev by a live session: 7/7 cited URLs resolve, including one with a typo in the source's own slug. The general gap (nothing audits declared capabilities against the runtime supplying them) is open as [#822](https://github.com/keiranholloway/biffo-template/issues/822) |
| — | **A self-reported effort figure was 45% low, and every incentive pointed the same way.** A 5.5-hour session was logged at 3 hours because the entry covered the last unit of work (the build) and silently omitted four completed earlier ones — two plans, an assessment, a third plan — each with its own PR and CI wait. The bias is **directional**: an agent reconstructs elapsed time from what is still in working memory, and finished work from the start of a long session is exactly what is not. So the error is always *low*, never high, which would make the inferred dashboard split look better-calibrated than it is — the precise failure the effort log exists to detect. Caught only because a human said "that was more like five hours" | **visibility** | biffo-template (the effort log) | practice — log each unit when its PR merges, not the session when it ends | **fixed** — four missing units logged retrospectively; §8 wording is right, the habit was not |
| — | **The same unvalidated-negative-search error three times in one five-hour session, each time producing a confident wrong conclusion.** (1) A CloudWatch `Send` bucket showed nothing for a capture's window → "the automation stopped sending"; it had sent, in an adjacent bucket, alongside a second unknown automation. (2) A CloudWatch Logs grep for `observer|run_as|lead_activit` returned empty → "the observer did not error"; the search window predated the deploy. (3) A grep of the scoreboard for `encoded its own premise` returned nothing → "two rows were lost in a rebase"; the text says `encodes`, and all five rows were present. §Never already says *"confirm the search works before trusting an empty result"* — it was read, agreed with, and then not applied, three times. The generalisable defect is that a negative result **feels like** evidence in a way a positive one does not: a hit is self-validating (you can read it), a miss validates nothing about the query. Cheapest fix is mechanical — before trusting a miss, run the same query against a case you *know* matches | **visibility** | biffo-template · tabsii-platform (dev) | practice — pair every negative search with a positive control | **fixed** — rule stated; three instances logged as one class rather than three rows |
| — | **Three requirements were assessed from source, reported to the operator, and one conclusion was flatly wrong — the deployed system had been contradicting it for weeks.** An analysis of FR-CRM-03/04/05 concluded "you cannot email a candidate on capture at all". Opening the deployed workflow builder found an **enabled** automation doing exactly that, on a trigger the source-read had dismissed. The source was not misread; it was *incomplete* — code says what is possible, a running system says what is configured, and no amount of reading the first tells you the second. The operator's prompt ("check the exposed user interfaces too") is what caught it. Any assessment of "does this product do X" needs the deployed surface, not just the repo | **visibility** | tabsii-platform / tabsii-crm | practice — assess capability against the running system, not the code | **fixed** — assessment corrected in tabsii-platform#289 before any work was planned on it |
| — | **An approved implementation plan asserted two mechanism capabilities it had not checked, and both were false.** `0007-lead-activity` was approved on "Core derives the activity, no upstream change needed" — `core-manifest.json` puts the target files in template-owned paths, so it required an upstream round trip and a core upgrade. The same plan said generic CRUD would serve the lead's timeline; `crud_handlers.make_list_handler` accepts **no filters**, so it would have returned every activity in the tenant. Both facts were one `grep` away at planning time, and both surfaced mid-build where changing course is most expensive. A plan that names the file it depends on should read that file's behaviour, not its name | **drift** | tabsii-platform | practice — planning must verify the capability it assumes, not just locate it | **worked around** — both flagged in-PR and redesigned rather than silently reinterpreted |
| — | **§8 was applied once at the end of a session and recorded only what was still in working memory — the same failure, in the same session, that made the effort figure 45% low.** Five scoreboard rows were written from the build phase; three earlier failures (a source-only assessment contradicted by the deployed system, and two unchecked capability assumptions in an approved plan) were omitted, and surfaced only when the operator asked "has all this been recorded?". The effort-log entry for this session had *already* diagnosed the cause — "logging the task instead of the session" — and stated the fix, "log each unit when it completes". That sentence was written about minutes and not generalised to findings, though it governs both. **A lesson recorded in one section does not propagate to the section next to it**, which is itself the argument for writing findings at the moment they occur rather than in a closing sweep | **process** · visibility | biffo-template (`biffo-verify` §8) | biffo-template — §8 should say "record the row when the failure happens", and the skill's triggers should fire mid-task | **fixed** — three missing rows added; skill gap recorded below |

| — | **`strings`/`grep` over a compressed artefact is a false-negative machine, and it nearly put a live private key in git.** Committing the runner fleet's Terraform (biffo-runners#1), I pre-checked `terraform/tfplan2` for credential markers and reported it clean-but-not-authoritative. It was **wrong**: a saved Terraform plan is a **DEFLATE zip**. Unzipped, its embedded `tfstate` holds the live GitHub App **private key**, App ID and generated `webhook_secret` in plaintext — confirmed by extracting the real key from `terraform.tfvars` and finding it inside the archive. `.gitignore`'s `*.tfstate` rule could never have caught it, because the state is a **member file within an archive**, not a file on disk. The generalisation is the point: **gitleaks scans blobs the same way I did**, so any compressed artefact is a hole in content-based secret scanning — plan files, `.zip` fixtures, vendored tarballs | **visibility** · fail-open | biffo-runners (pre-commit check) | practice + `tfplan*` ignored; **the estate-wide gap is open** — nothing decompresses before scanning | **avoided**, not suffered. History is 1 commit, so it was one `git add` from being permanent |
| — | **An issue's own framing said "authorization bypass"; it was a UX gap, and the backend had enforced correctly all along.** `biffo-platform-app#4` reported the Ideation role gate as client-side only and therefore bypassable. Establishing what actually enforces — rather than accepting the framing — found **three independent server-side layers** (API Gateway's JWT authorizer, the plugin host's `group_gate` re-verifying the Cognito JWT against the pool JWKS, the plugin's own `require_group`), with Core owner-scoping every read. Measured unauthenticated **against the API Gateway origin directly**, because CloudFront rewrites API errors into `200` + portal HTML (#647): every route `401`s, and `/ideation/` is **428 bytes** of empty `<div id="root">`. The real defect was narrower and real — the manifest declares `user_frontend.required_group` and ADR-0018 §2 says that gates the UI, and **nothing implemented it** — but "the shell renders" is not "data is returned", and those have different severities and different fixes | **process** · visibility | biffo-platform-app#4 (as filed) | biffo-plugin-ideation [#63](https://github.com/keiranholloway/biffo-plugin-ideation/pull/63) | **fixed** (the UX gate); the issue's **severity is still wrong on the ticket** and it stays open for a non-founder click-through nobody has done |
| — | **A merged plugin change sat undeployed for a whole working day, and nothing anywhere said so.** Resyncing ideation to carry the founder gate revealed the vendored copy was **three changes behind**: `effective_config.py` was missing **entirely** — that is #58, merged in the morning and never resynced. No dashboard, check or alert distinguishes "merged in the plugin repo" from "running on dev". The trap is already on this page; what is new is the measurement — **one day of drift, three changes, discovered only because something else forced a resync** | **visibility** · drift | biffo-plugin-ideation → biffo-platform | biffo-platform [#102](https://github.com/keiranholloway/biffo-platform/pull/102) | **fixed** for these three; the general case is **open** — nothing reports vendored-vs-source drift |
| — | **A plugin repo ships a deploy workflow that cannot run, and the instance has a different mechanism that supersedes it.** A sub-agent correctly concluded the ideation frontend needed `deploy-frontend.yml` with `frontend_bucket_name` and a distribution id — reading the **plugin repo's** workflow. That workflow's `workflow_dispatch` path falls back to `secrets.PLUGIN_OIDC_ROLE_ARN`, **which does not exist in that repo**, so a dispatch dies at the credentials step. The instance's `deploy-app.yml` already builds `services/<name>/web/` and syncs it to `<prefix>-plugin-<name>-web`. Two mechanisms for one job, one of them dead, and nothing marks which is live | **boundary** · drift | biffo-plugin-ideation `deploy-frontend.yml` | undecided — delete the dead one, or wire its secret | **unfiled** — the deploy went via the instance; the duplicate remains |
| — | **A test fake conflated two states, and the conflation only surfaced when production learned to tell them apart.** `FakeAgentRun.fail()` left `started_at` unset, so a run that was claimed-and-errored was indistinguishable from one nothing ever picked up. That was invisible while the service treated both as "failed" — and became a failing test the moment it stopped. The related shape: `AgentRunView` carried neither `error` nor `started_at`, so the plugin was **structurally incapable** of telling a founder the truth, and the misleading copy was a consequence of the model, not of the wording | **drift** | biffo-plugin-idea-scout tests | biffo-plugin-idea-scout [#41](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/41) | **fixed** — the fake models both shapes; the existing test that broke was right to break |
| — | **The same defect twice in one feature — an assumed payload shape — cost hours in one place and one log line in the other, and the only difference was whether the no-op branch said anything.** Both read a field that was not there and both then *chose not to act*. The run-outcome observer's miss ended in a bare `return`: no row, no error, no log, for its entire existence — found only by opening a deployed page, noticing an empty timeline, bisecting with an adjacent write path, and reading a real stored event off the API (tabsii-platform#301). The SES consumer's miss ended in `logger.info("Ignoring SES notification of type %s", kind)` — so its **first ever invocation** printed `type None` and named its own defect (tabsii-platform#305). Same class, same author, same week; discovery cost differing by orders of magnitude. **A silent early-return at an integration boundary is an unobservable failure mode**, and it is precisely the branch that fires when a shape assumption is wrong — so "I decided not to act" must say what it decided and on what. `type None` was still not enough to act on either: the fix logs the notification's **keys**, because naming the absent field tells you nothing about what actually arrived | **visibility** | tabsii-platform | practice — every no-op branch at a boundary logs its input's shape, not just its verdict | **fixed** — both paths now log; rule stated |
| — | **A bind parameter followed immediately by a Postgres cast is silently RENAMED, not rejected, and it has now happened twice in one feature.** SQLAlchemy's `text()` parses `:name` with a regex that stops at the first non-word character, so `::` directly after the name is consumed as part of it. `text("ANY(:ids::uuid[])")` does not fail to bind — it binds **`id`**, a parameter nobody passes, and the statement then dies at execution with a message about the *SQL*, never about the binding. Verified in isolation: `:ids::uuid[]` → `['id']`, `:ids ::uuid[]` → `['ids']`. First hit in `0006` M3 (`date_trunc('month', :date_from::timestamptz)`, where the parameter simply never substituted); hit again in `0009`'s queue endpoint by a different session in a different file. **A one-character fix — a space — and no gate anywhere can see it**: it is valid Python, valid-looking SQL, and passes lint, type-check and any test whose fixture happens not to reach that branch | **visibility** · drift | tabsii-platform `0006` M3, then `0009` M6 queue | practice — never write `::` immediately after a bind name; use `CAST(:name AS type)` or leave a space | **fixed** both times; **the general case is open** — nothing detects it, and the second instance was found only because the endpoint was exercised |
| — | **A hand-written test double returned the shape the code *emits* instead of the shape it *receives*, so 17 tests pinned a contract that did not exist.** `FakeCore.get` returned `{"items": [...]}` for `/api/v1/data/lead_source_costs`; the core's generic-CRUD list returns a **bare array**. The proxy route was declared `-> dict`, so FastAPI's *response* validation rejected the real payload and every load of the Analytics panel 500'd — while the Python suite, the JS suite, Playwright E2E and CI in two repos were all green. `CoreApiClient.get` is annotated `-> dict` but returns whatever `.json()` produced, so the annotation actively pointed the wrong way, and `rollups.py` **three files away** already had the correct `cast(list[dict], …)` + wrap. The panel's six calls run under `Promise.all`, so one rejection blanked all five other reports and the banner named none of them. Condition: **a double whose shape is written from the author's expectation rather than from the real service teaches the test the author's error** — the fixture encoded the exact assumption it existed to check | **fail-open** · drift | tabsii-crm (deployed page, first click-through) | tabsii-crm [#124](https://github.com/tabsii-com/tabsii-crm/pull/124) | **fixed** — the fake now returns a bare array and is typed `dict \| list`; three tests fail against the old route |
| — | **CSS class names are strings, so a panel written against classes that do not exist passes every gate and renders as bare HTML.** `AnalyticsPanel.tsx` used `.card`, `.data-table`, `.filter-bar`, `.error-text`, `.stat-row` — none of which exist in `tabsii-crm`, whose convention is a prefixed block per feature in `globals.css` (`.ov-*`, `.access-*`, `.discovery-*`) — and shipped with **no CSS of its own**. eslint, `tsc`, 164 unit tests, Playwright and a production build were all green, because nothing that runs locally resolves a class name against a stylesheet. The visible result was an unstyled page whose speed stat read `Median time to first contact0m5 of 17 leads contacted`. Same family as the Vite `base` row above — a string that only means something in a browser | **visibility** | tabsii-crm (deployed page) | tabsii-crm [#125](https://github.com/tabsii-com/tabsii-crm/pull/125) | **fixed** — `.analytics-*` block on the existing precedent. **The general case is open**: nothing warns that a className matches no rule in the bundle |
| — | **A repo hardened a gate for itself and went on shipping the unhardened version into every repo it generates, for as long as the hardening existed.** Both `_skeletons/*/.github/workflows/ci.yml` ran `pnpm audit --audit-level=high` and `uv run pip-audit` inline — the exact commands [#591](https://github.com/keiranholloway/biffo-template/issues/591) was filed about — while this repo's own CI had called the hardened wrappers since #592, and #636/#717/#721 kept improving them. Six siblings and two plugin repos were born reddening a required check on any npm/PyPI blip. **The distribution channel is the actual finding.** #743 proposed moving the audits into `biffo check` on the grounds that copying them into every satellite "drifts with nothing to detect it" — correct when it was written, and no longer true: `shared-files.json` + `scripts/shared-sync.sh` landed the same week, so a verbatim copy *plus* a drift check is now the cheaper answer and needs no npm round-trip in CI. The issue also says neither skeleton has a `scripts/` directory; both had one by the time it was read. **A design argument decays as fast as the constraint it rests on** — re-derive the option table before implementing an issue's recommendation | **drift** | biffo-template `_skeletons/` | biffo-template `_skeletons/`, `scripts/`, `shared-files.json` | **fixed** ([#743](https://github.com/keiranholloway/biffo-template/issues/743)) — plus a `hardened-dependency-audit` skeleton rule and a shared-files↔skeleton parity test, both watched failing first. cost ~1h 20m |
| [tabsii-platform#335](https://github.com/tabsii-com/tabsii-platform/pull/335) | **An RLS policy that passes `NULL` for a scope argument structurally excludes every scoped role, and holding the permission is irrelevant.** `media_assets_create` is `fn_authorized('media_assets.create', tenant_id, NULL, …)`; in `fn_authorized` every branch but the tenant-wide one is guarded by `p_<x>_id IS NOT NULL`, so a NULL-brand call can only match a **tenant-wide** assignment. `Brand HQ` is `scope_level = 'brand'`, so it holds `media_assets.create` and is denied anyway. The FDD publish endpoint would have 403'd for the exact role the feature exists for — Brand HQ manages a brand's disclosure documents — while working perfectly for an HQ Admin. No SQLite test can see it (SQLite runs no RLS), and a brand-scoped reviewer clicking through would not either | **drift** | tabsii-platform `domains/tabsii/fdd_admin.py` | same — the subordinate write moved to the master session, with the reason recorded | **fixed** — pinned in the real-Postgres lane: a brand-scoped `media_assets` insert is refused, the same role's `fdds` insert succeeds |
| [tabsii-platform#347](https://github.com/tabsii-com/tabsii-platform/issues/347) | **`audit_logs` is write-only: the permission is granted, the RLS policy exists, and nothing in the product can read it.** `audit_logs.read` is hand-curated into role grants in modules 019/025/027/032 and module 011 declares a SELECT policy for it — but there is no ORM model, no generic-CRUD registration and no bespoke route anywhere. `break_glass` records privileged role grants and the FDD feature records compliance events into a table reachable only by direct database access. Surfaced when the acknowledgement audit row **could not be confirmed** during dev verification and had to be recorded as unverified. Second-order: `audit_logs_read` also passes a NULL brand — the same shape as the row above — so a Brand HQ user holds `audit_logs.read` and would still read zero rows even once a route exists | **visibility** | tabsii-platform (dev verification) | tabsii-platform `domains/tabsii/` | **open** — needs a decision on *who* may read the trail before a route is worth writing |
| [tabsii-platform#343](https://github.com/tabsii-com/tabsii-platform/pull/343) | **Generic CRUD accepts a query-parameter filter over HTTP and silently ignores it, so a filtered-looking list returns everything the caller may see.** `crud_handlers.make_list_handler` takes only the tenant dependency, the caller and the session, and builds `select(model).where(model.tenant_id == tenant_id)` — no query-param filtering exists. The CRM's FDD version list was pointed at `/api/v1/data/fdds?brand_id=<id>`; a brand-scoped role is saved by the row policy, but a **tenant-wide HQ Admin would have seen every brand's disclosure documents inside one brand's panel**. 200, plausible data, wrong answer. Neither the sibling's router test (which pins the forwarded *path*) nor its Playwright E2E (whose fixture server *does* filter) could observe it | **fail-open** | tabsii-crm `routers/fdds.py` | tabsii-platform — a brand-scoped domain route | **fixed** — two brands seeded in one tenant; dropping the predicate fails with `assert 3 == 2` |
| [tabsii-platform#342](https://github.com/tabsii-com/tabsii-platform/pull/342) | **`CAST(:x AS jsonb)` silently mangles JSON into the string `"0"` on SQLite, and every `audit_logs` write in the codebase uses that exact pattern.** `jsonb` matches none of SQLite's affinity keywords, so it falls to NUMERIC affinity and CAST-ing JSON text to NUMERIC yields `"0"` with no error. Correct on Postgres, which is why it shipped. **No prior test had ever read `new_value` back**, so the pattern propagated from `break_glass.py` through `fdd_admin.py` to `public_disclosure.py` before an assertion on stored content finally caught it | **visibility** | tabsii-platform `domains/tabsii/tests/` | same — rewrite-before-execute, scoped to the SQLite lane only | **fixed** — production SQL unchanged and correct |
| [tabsii-crm#136](https://github.com/tabsii-com/tabsii-crm/pull/136) | **A date-only string parsed by a datetime parser renders the previous day west of UTC — on a legally meaningful date.** `earliest_signing_date` is a bare `YYYY-MM-DD` (the FTC cooling-off date); `new Date('2026-02-14').toLocaleDateString()` parses it as UTC midnight and shows `2/13/2026` in `America/Los_Angeles`. Every *other* field in the same response is a full ISO datetime, which is exactly what made uniform treatment look correct. Caught only because the server-side agent flagged the type difference and it was relayed before the sibling shipped | **drift** | tabsii-crm `components/LeadDrawer.tsx` | same | **fixed** — regression test pinned to `TZ=America/Los_Angeles` |
| [biffo-template#903](https://github.com/keiranholloway/biffo-template/issues/903) | **Merged, CI green and Terraform applied still leaves a feature that does not exist at runtime, and every signal says success.** After the FDD acknowledgement milestone merged, its two `authorization_type = NONE` routes were present in API Gateway (infra deploy ran) while the Lambda still served pre-merge code (app deploy queued). `GET` returned FastAPI's default `{"detail":"Not Found"}` rather than the handler's own constant. The distinction was visible **only** by comparing the 404 *message* against a pre-existing public route's handler message — status code, route listing and workflow conclusions were all consistent with a working feature. There is no signal anywhere that a deploy for a given commit has landed, so verification had to poll the deployed endpoint itself | **visibility** | tabsii-platform (dev verification) | biffo-template `.github/workflows/` | **open** |
| [biffo-template#903](https://github.com/keiranholloway/biffo-template/issues/903) | **Cross-repo deploy ordering is prose in a PR body, so a sibling shipped ahead of the core API it depends on and showed users an error.** The CRM's FDD panel calls two new core endpoints; the dependency was written into the sibling PR's description and auto-merge armed on both. The sibling's CI finished first, merged first and deployed first while the core PR sat queued behind the runner fleet — producing a live panel that errored for every user who clicked it. Each repo's CI is independent and `--auto` merges as soon as *that* repo's checks pass; nothing reads the constraint | **process** | tabsii-crm (dev deploy) | biffo-template `.github/workflows/` | **open** |
| [tabsii-crm#137](https://github.com/tabsii-com/tabsii-crm/issues/137) | **Upstream API errors reach the UI as double-encoded JSON, because the proxy passes the whole response body as its `detail` string.** `core_client.py` raises `CoreApiError(status, response.text)` on every verb and the routers pass that into `HTTPException(detail=…)`, so FastAPI serialises an already-JSON string a second time and users see `{"detail":"{\"detail\":\"Method Not Allowed\"}"}`. Pre-existing and general — every proxied router has it — and invisible until a panel rendered the failure text inline instead of swallowing it | **visibility** | tabsii-crm `core_client.py` | same | **open** |
| — | **Both dependency-audit scripts reported INCONCLUSIVE — and misdiagnosed a healthy registry — on every invocation when `jq` was absent, while exiting 0.** Found by stubbing `pnpm` to return a real, parseable, *clean* audit payload on a PATH without `jq`: the gate printed `the registry returned a non-JSON/error response` three times and passed. `jq` is the parser the entire finding-vs-hiccup distinction rests on, so without it the retry-and-warn path — written to stop the gate failing open — *is* the fail-open, and it names the wrong culprit while doing it. Exactly the shape of the dash-`echo` defect #717 fixed in the same file, one dependency further out. A missing `jq` is deterministic, not transient, so it now exits 1 loudly | **fail-open** | biffo-template `scripts/{js,py}-dependency-audit.sh` | same, and every satellite via `shared-files.json` | **fixed** ([#743](https://github.com/keiranholloway/biffo-template/issues/743)) — `command -v jq` guard, before any audit runs |
| [#883](https://github.com/keiranholloway/biffo-template/issues/883) | **A file was added to the shared set, both skeletons were fixed, and `shared-sync.sh` was never run** — so 12 of 13 satellites went without the hardened dependency audits it was added for. The skeleton only reaches repos created *afterwards*, which is precisely the "vendor it and hope" failure `shared-sync.sh` exists to end; the distribution defect recurred **through its own fix**. AGENTS.md §9 states in bold that adding a file to the shared set is not done until `--check` is clean. Found by running the estate audits, not by review | **drift** · process | biffo-template `shared-files.json` | 12 satellite repos | **fixed** (11 merged, 1 blocked on an unrelated red `dev`) |
| [#714](https://github.com/keiranholloway/biffo-template/issues/714) | **The `--auto` fix was applied by hand to five repos and nothing re-asked, so the next nine were born `false`.** #714 recorded the condition and fixed the five repos that existed; measured 2026-07-29 across 13 satellites, **9 had `allow_auto_merge=false`** — the documented default in `biffo-workflow` step 7 was unavailable in two thirds of the estate, and its assertion that "all five active Biffo repos" have it was true when written and never re-checked. Same shape as [#715](https://github.com/keiranholloway/biffo-template/issues/715): branch protection has an audit that re-asks; this setting has none | **drift** · fail-open | estate-wide sync rollout | 9 repo settings | **partly fixed** — settings corrected, but nothing re-checks them (no audit) |
| [#902](https://github.com/keiranholloway/biffo-template/pull/902) | **Arming the git hooks silently broke the cron job that measures whether hooks are armed.** Moving off husky's `core.hooksPath` into the shared `.git/hooks` means every *linked worktree* inherits them — including `practices-daily`'s, which is created by cron and never given `pnpm install`. The gate failed six checks against a missing `node_modules`, git rejected the push, and under `set -e` the job died at its last step: every audit ran, the dashboard rendered, and the snapshot reached nothing. It would have reported nothing each morning until a human noticed the series had stopped | **visibility** · drift | biffo-template `scripts/practices-daily.sh` | biffo-template `scripts/practices-daily.sh` | **fixed** ([#902](https://github.com/keiranholloway/biffo-template/pull/902)) |
| [tabsii-platform#291](https://github.com/tabsii-com/tabsii-platform/issues/291) | **An assignment outcome computed the reason a human would need and then discarded it before writing anything down.** `assignment.py`'s `_record_outcome` receives the resolved `territory_id` and includes it in the emitted `ASSIGNMENT_CHANGED` event, but the `INSERT INTO lead_assignment_history` never writes it — the table (module `056`) has no `territory_id` column at all — so a lead auto-assigned via a territory's owner rule has an owner and a reason code (`territory_rule`) but nothing anywhere records *which* territory matched. `LeadDrawer.tsx:829` reads `leads.territory_of_interest_id` for its "Territory" field, which is semantically the candidate's own explicit selection and is never written on this path, so the field renders `—` for the majority real-world case. Found only by injecting the session's own Cognito token into a live `fetch` against the real API and comparing the raw lead row to what the drawer showed — reading `assignment.py` alone would not have caught it, since the value genuinely flows through the function, it just never lands anywhere durable | **visibility** | tabsii-platform (live click-through, dev.tabsii.com/crm) | tabsii-platform [#360](https://github.com/tabsii-com/tabsii-platform/pull/360) + tabsii-crm [#143](https://github.com/tabsii-com/tabsii-crm/pull/143) | **fixed and verified live** — a fresh lead submitted through the real intake form with postcode `LS1 1AA` shows "Territory: Leeds Central" in the deployed CRM after the fix; the original bug-report lead stays `—` since nothing existed to backfill from |
| [tabsii-crm#133](https://github.com/tabsii-com/tabsii-crm/issues/133) | **The same lexical-closing-keyword trap recurred through a third vector: PR body prose, independent of the commit.** tabsii-crm#141's description contained `## Scope note — this PR alone does not close #133` — the same `close #N`-inside-a-denial shape as the tabsii-platform#76 row above — and the issue closed at merge anyway. Confirmed directly this time: the actual squash-merge commit message did **not** contain the phrase (only `Refs #133`), so keeping a denial out of the commit is not sufficient — GitHub's linker reads the PR description text on its own, separately from whatever ends up in the commit. Caught by re-listing open issues per this page's own standing rule, and reopened before the (genuinely incomplete, pending a companion PR in another repo) fix was mistaken for done | **visibility** · process | tabsii-crm [#133](https://github.com/tabsii-com/tabsii-crm/issues/133) | practice — never write a closing keyword in prose, in the PR body **or** the commit | **caught before harm** — reopened same session, re-closed once the companion PR (tabsii-platform#354) actually merged |
| — | **`practices-evidence.mjs`'s own ref-extractor silently misattributed cross-repo citations to this repo, and had already corrupted 79 stored dates before anyone noticed.** `extractRefs` resolved a bracket-wrapped number like `tabsii-platform [#360](https://github.com/tabsii-com/tabsii-platform/pull/360)` by looking only at the text immediately touching the `#` — nothing does, so it fell back to the bare-ref default, `keiranholloway/biffo-template`. `--enrich` then fetched *that* repo's real, unrelated issue #360 and wrote its creation date into a tabsii-platform row as if it were the row's own. Found while adding this session's two rows above, whose `fixesIn` cross-repo PR links tripped the same path; confirmed already live in the committed dataset — the tabsii-platform#76 row's stored date was quietly a biffo-template PR's date, off by 3 weeks. Re-running the fixed extractor against the full corpus found 79 rows carrying a date computed the same wrong way. Fixed by resolving a markdown link's **URL** first, ahead of any adjoining text, and by no longer letting a bare, unlinked `#N` default to this repo when the same number is already tied to a named repo elsewhere in the row | **fail-open** | biffo-template `scripts/practices-evidence.mjs` (this page's own tooling) | biffo-template `scripts/practices-evidence.mjs` | **fixed** — 79 corrupted dates re-enriched from the correct repo; a residual gap remains for a bare same-numbered mention inside quoted prose with no adjoining prefix at all, which still has no repo to resolve against |
| — | **The probe used to confirm a deploy is itself a gate, and mine passed when it could not discriminate.** Verifying four demo fixes on dev, two of my own ad-hoc checks returned a positive that carried no information. (1) To prove tabsii-marketplace#28 had shipped I grepped the deployed bundle for `getCurrentSession\|isValid\|replace(` — `replace(` appears in essentially every minified JS bundle, so five of the five chunks I tested "matched", including `polyfills`. It printed `PRESENT in deployed bundle` and meant nothing. Redone against `"checking"` (a `Step` value the fix introduces) and `/browse` (`safeNext`'s fallback), it discriminated — those appear in the `signin` chunk and nowhere else. (2) Probing `curl -o /dev/null -w '%{http_code}'` across `/ /marketplace /intake /crm` returned `200` for all four and I read it as "all routes live" — but `/marketplace/brands`, which **does not exist**, also returned `200`, serving the corporate marketing page through the SPA fallback. The status code was evidence the CDN answers, not that the route exists. Both are the same shape as this page's vacuous-test rows, except the artefact is a **verification command typed once and never reviewed** — no diff, no test, nothing that would ever be read again. The habit that catches it is the one already written for guards: *name the value that would make this fail, and check that value is reachable* | **fail-open** | ad-hoc deploy verification (tabsii-marketplace, tabsii-crm) | practice — a verification pattern must be unique to the change, and a 200 from a CDN is not a route | **corrected before shipping** — the weak result was retracted in the same session and re-established with discriminating markers |
| [#973](https://github.com/keiranholloway/biffo-template/issues/973) | **A deploy workflow failed outright — not a race, an actual failure — and nothing distinguished that from success for 21 hours.** tabsii-platform#399 merged to `dev` with every required check green. Its `Deploy Application` run died mid-job at `Package and deploy Lambda` (self-hosted runner killed, step conclusion `null`, cascading `null` through DB schema init, DDL imports and every plugin deploy step after it) and reported `failure` — but nothing retried it and nothing alerted on it, so the merged, CI-green PR simply never reached the deployed Lambda. The next `dev` commit hit the same runner-kill shape in its own CI run, confirming the failure mode is common infrastructure flakiness, not this PR's code. Only found because a live click-through (AGENTS.md §4) hit a 404 on a route the PR said existed, and unzipping the deployed Lambda (`aws lambda get-function` → `Code.Location`) showed the new module simply absent. This is a second, independent occurrence of the gap [#903](https://github.com/keiranholloway/biffo-template/issues/903) already named ("no signal anywhere that a deploy for a given commit has actually landed") — #903's case was an ordering race between two repos' deploys; this one is a single repo's deploy workflow failing outright with no retry path, which is arguably worse because a CI failure only blocks its own PR while a silently-failed deploy blocks everyone until someone happens to check `gh run list --branch dev` | **visibility** | tabsii-platform (dev, verifying tabsii-platform#399/tabsii-crm#153's live timeline) | biffo-template `.github/workflows/deploy-app.yml` (proposed: bounded auto-retry on a runner-cancellation signature, and/or a notification distinct from CI-red, and/or a deployed-vs-HEAD drift check) | **open** — recovered by hand this time via `gh run rerun <ci-run> --failed` (confirmed the flake) then `gh workflow run "Deploy Application" --ref dev -f environment=dev`; cost ~25m to diagnose once suspected, on top of the wait for the redeploy itself |
| — | **A guard against valuation figures could not match the exact spelling the source used.** Founder-facing copy must carry no price or multiple (the taxonomy came from *asking* prices with no confirmed sales, so a multiple reads as a valuation it is not). The guard was `\b\d+(?:\.\d+)?\s*[x\u00d7]\b` — and `\b` **cannot match between `\u00d7` (U+00D7) and a space**, because neither is a word character. It caught `4.0x` and silently ignored `5.8\u00d7`, which is the form the source table actually used. It would have passed forever on the one input it existed to reject. Caught only by writing a test *of the guard* asserting it fires on known-bad strings; a trailing `(?![a-z0-9])` fixes both spellings. **The generalisable rule: a regex guard needs a test that feeds it violations, not only clean input** — clean input cannot distinguish a working pattern from one that matches nothing | **fail-open** | biffo-plugin-idea-scout | biffo-plugin-idea-scout (`tests/test_idea_scout_seed_business_models.py`) | **fixed** ([#78](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/78)) — plus a guard-the-guard test |
| — | **A commit that silently never happened, then a push that reported success having pushed nothing.** In a fresh biffo-platform worktree the pre-commit hook runs `lint-staged`; without `pnpm install` it fails `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "lint-staged" not found` and **aborts the commit**. The subsequent `git push` then printed the full `verify passed` gate output and `* [new branch]` — pushing the branch at its base commit with nothing on it — and exited **0**. The first visible symptom was `gh pr create` failing with *"No commits between dev and <branch>"*, several minutes later. AGENTS.md §2 says install deps before working and §6 says print the exit status; both are written for the *push*, and the trap is at the **commit**. `git rev-list --count origin/dev..HEAD` before opening a PR is the cheap check that would have caught it immediately | **fail-open** · visibility | biffo-platform | AGENTS.md §2/§6 wording; `pnpm install` in a fresh worktree | **worked around** — deps installed and recommitted; the guidance still frames this as a push-time risk |
| — | **Five CI jobs killed mid-step across two PRs, reported as `cancelled` rather than `failure`, because the runner fleet is spot-only with `lowest-price` allocation.** `##[error]The runner has received a shutdown signal` five seconds into `pyright`, then `Terminate orphan process: (pyright)`. Three different instances died at the *same second* (19:48:26). The module default `instance_allocation_strategy = "lowest-price"` concentrates every runner in whichever single pool is cheapest, so the four-entry `instance_types` list bought **no** diversification: **17 of 17 recent runners were `t3a.large`**, and one pool reclamation took the whole fleet. Confirmed rather than inferred — CloudTrail showed 5 × `BidEvictedEvent` at exactly that second, while the `biffo-gha-scale-down` `TerminateInstances` calls sat three minutes earlier on *idle* runners, ruling out the orphan-sweep defect already documented in the same file. Two false trails on the way: `describe-instances` returned `InvalidInstanceID.NotFound` (the fleet is in **us-east-2**, not the instance's `eu-west-1`, same account) which read as "different account"; and `cancelled` reads as a flaky test rather than an infrastructure kill. **cost ~45m** across 3 re-runs, waiting and diagnosis | **visibility** · process | biffo-platform CI | biffo-runners (`terraform/main.tf`) | **fixed** ([biffo-runners#19](https://github.com/keiranholloway/biffo-runners/pull/19), applied) — `price-capacity-optimized`, 8 instance types, 3 AZs; next batch immediately launched mixed `t3a.large`/`t3.large` in the new AZ |
| — | **`503 {"message":"Service Unavailable"}` was a Lambda *throttle*, and the account limit was 100× below the AWS default.** `ConcurrentExecutions` was **10** vs a default of **1000** — the cap AWS applies to young accounts, **per account**: tabsii's was raised on 2026-07-10 and biffo-platform's had never been requested, so a note recording the earlier fix read as though this one had also been done. The tell is `Throttles > 0` with **`Errors: 0`** (14 throttles / 0 errors / 35 invocations over 3h): nothing is crashing, the code never runs. Amplified by the app: every `/api/v1/plugins/*` request is served by the shared plugin host which then calls Core, so **each request costs two invocations**, and a 7-call page load wanted ~14 concurrent against a ceiling of 10 — it self-throttled before a second user arrived. `core-api` showing *more* invocations than the host fronting it is the signature. **The Service Quotas case status also lies**: the raise applied in ~20 seconds while the request still read `CASE_OPENED`, so `aws lambda get-account-settings` is the authority, not the case | **visibility** · boundary | biffo-platform dev | AWS account quota; biffo-plugin-idea-scout (`GET /form-options`) | **fixed** — quota 10→1000 applied; page load 7 requests → 3 ([#80](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/80)) |
| — | **A hand-written `createApi` mock missing one new method hung the test suite past 120s, three times in one session.** Adding a method to the real client leaves the tests' bespoke `vi.mock` object short one key; the resulting undefined call rejects inside a mount-time `Promise.all`, and vitest sits until the runner's timeout rather than failing fast. Each occurrence read as "the admin suite is slow" until the mock was compared against the client. The mock's own comment already warns *"Names taken from createApi itself, not guessed — a wrong name here fails as 'no rows rendered', which reads exactly like the feature being broken."* — the warning is present, correct, and does not prevent the omission, because nothing links the two files. **cost ~15m** across three occurrences | **drift** · visibility | biffo-plugin-idea-scout (`web/`, `web-admin/`) | biffo-plugin-idea-scout | **worked around** — mocks updated each time; nothing yet asserts the mock's key set matches `createApi`'s |
| — | **The portal serves 404s as HTTP 200, so a dead URL is indistinguishable from a live one.** A reported failure at `/dashboard/new-idea-scout/` was investigated as an application bug; the path renders Next.js's *"This page could not be found"* with a **200** status (static-export behaviour), and no `dashboard` route exists in either the instance's or the template's portal source. The real app is at `/idea-scout/`. Cost the first minutes of a live incident chasing a page that does not exist, and it means no monitor or link-checker can detect a broken portal link | **visibility** | biffo-platform / apps/portal | apps/portal (template-owned) | **not fixed** — filed here only; a static export needs the 404 served with a 404 status, or CloudFront mapping it |
| — | **`practices-evidence.mjs --extract` deletes rows on every run, and its own code says it does not.** Run against a pristine `dev` with no edits at all, the dataset goes **326 -> 323**: four stored rows have no counterpart afterwards. The function that should prevent this carries an explicit comment — *"Orphans are KEPT, not dropped... This used to `return fresh.map(...)`, which silently deleted every stored row the markdown no longer mentioned. That is a data-loss fail-open, and it fired"* — so the failure mode was diagnosed, fixed once, documented at length, and is live again. The loss is invisible in the ordinary way: `--extract` reports the number it *wrote* (`extracted 323 rows`), never the number it removed, and the generated tally simply quotes a smaller total. Found only because 326 + 6 new rows produced 329 rather than 332, and the arithmetic was checked. **Anything appending to this dataset should verify the row count grows by exactly what it added.** | **fail-open** · visibility | biffo-template (the practices tooling itself) | biffo-template (`scripts/practices-evidence.mjs`, `orphanedRows`/`rowKeys` matching) | **fixed** ([#978](https://github.com/keiranholloway/biffo-template/pull/978)) — matching is now one-to-one (`pairRows`), so N stored rows sharing a ref cannot collapse onto one fresh row. Measured 326 -> 323 before, 326 -> 326 after; three of the four new tests fail against the old implementation and only those three |
| — | **A CI monitor reported `ALL SETTLED` about a commit that was no longer the PR head, and every check said `pass`.** After a force-push, `gh pr checks <N>` and `gh run list --branch <b>` both answer for *the branch*, not for a SHA — so the superseded run reaching a terminal state (`cancelled`, caused by the force-push itself) read as completion, while the real run for the new head was still `queued` with all five checks pending. Merging on that signal would have merged code no green check had described. Caught only by comparing `gh pr view --json headRefOid` against the run's `head_sha`: `723c0f1` vs `6613de4`. The same arithmetic-style check that caught the two other instrument failures this session. **The tell is that `cancelled` is a terminal state**, so any "are all checks non-pending?" loop treats a force-push-cancelled run as a finished one. A monitor must select its run by `headSha == <PR head>`, not by branch and recency. Third time in one session that a green signal described something other than the thing under test — and this instrument was **built during** the session that wrote up the other two, so knowing the pattern did not prevent reproducing it | **visibility** · fail-open | biffo-template (my own CI monitor, caught pre-merge) | diagnostic practice — pin the monitor to the PR's `headRefOid`, and treat `cancelled` as "superseded", never "done" | **corrected before merging** — monitor re-armed against the SHA; the five checks were still pending and passed ~4 min later |
| — | **A counter-metric built to falsify an experiment was, in its first version, a second reading of the metric it was meant to check — and three passing unit tests could not see it.** H3’s content-loss risk sat `open` for three days because nothing measured it. `staleMergeShare` counts merges whose base moved between the PR’s green run and its merge — anchored, at first, to the **first** green. That is wrong by construction: under `strict: true` a raced PR goes green, falls behind, rebases and re-greens, so its base *always* moved after its first green. The metric counted rebases — `racedShare` under another name — and moved **with** the primary rather than against it, scoring tabsii-platform at **44.7% stale while `strict` was still on**, a value the gate makes impossible. No unit test was wrong; each asserted exactly what it claimed, on fixtures too small to contain a rebase. What caught it was running the collector on the live estate and asking whether the number was *possible* rather than whether it was plausible. A second defect hid behind it: `runsForPr` admits runs created up to 24h **after** the merge, so the last green could postdate the merge and make a PR unstaleable — a silent false negative that had reported two real cases clean | **process** · visibility | biffo-template (caught pre-merge, on the live-data run) | biffo-template `scripts/practices-metrics.mjs` | **fixed** ([#977](https://github.com/keiranholloway/biffo-template/pull/977)) — anchored to the last green preceding the merge; regression tests pin both cases |
| — | **`enforce_admins: false` on ELEVEN of twelve estate repos makes every branch-protection rule advisory for the only human who merges, and no audit reports it.** Three repos carrying `strict: true` — `tabsii-intake`, `tabsii-geo`, `biffo-plugin-ideation` — showed merges the new stale-merge metric says were not up to date, which that gate makes impossible by construction. The explanation is that protection binds an admin **nowhere except `biffo-template`**, the single repo where `enforce_admins` is on. The daily estate audit checks that branches **are** protected (19 branches, all protected, `OK` every day) and never checks that the protection **binds anyone** — so a repo can show a full required-check list, pass the audit, and still be one where any of it can be walked past without a trace. Two consequences past the obvious: **H3’s comparator `tabsii-crm` is not gated the same way as its treatment repo**, a confound the experiment never recorded, and `tabsii-platform` — added to H3’s treatment arm the same day — is unbound too. Nothing was looking; this surfaced only because an unrelated metric disagreed with a setting | **fail-open** · visibility | estate-wide, 11 of 12 repos (via `staleMergeShare` disagreeing with `strict: true`) | not fixed — extend the daily protection audit to report `enforce_admins`, then decide per repo whether bypass is intended | **unfiled** |
| — | **A dead runner and a rejected change were the same number, so an integration branch read as broken when nothing was.** `FAILING_CONCLUSIONS` excludes `cancelled` on the stated grounds that a superseded run is not a defect — correct, and **only half the cases**: a runner killed mid-job reports `cancelled` only *sometimes*. The rest of the time GitHub concludes the run `failure` **with no failing step**, and that label was counted as if code had broken. On `tabsii-platform`, **all six** `dev` failures inspected had zero failing steps and 3–21 steps left incomplete; one deploy succeeded through thirteen steps and froze on "Package and deploy Lambda". The board reported **8 integration failures and 111.7 red minutes** on a branch where not one gate had rejected anything. Invisible because the run-level conclusion is all anyone reads — diagnosing it needs the per-run jobs payload, which the collector already fetched for an unrelated metric. It also mattered on a deadline: `tabsii-platform` joined H3’s treatment arm the same day already past both of its refutation thresholds, entirely on kills that have nothing to do with `strict` | **visibility** · fail-open | tabsii-platform `dev` (found diagnosing rank 4 of the daily standup) | biffo-template `scripts/practices-metrics.mjs` | **fixed** ([#982](https://github.com/keiranholloway/biffo-template/pull/982)) — validated against 7 real runs including a negative control; correction takes tabsii-platform 24h from 8/111.7 to 1/0 while leaving biffo-template’s genuine 2/54.7 untouched |

### What the classes say

> Generated from `docs/practices/evidence.jsonl` by
> `node scripts/practices-evidence.mjs --write`, and asserted against it by test.
> Do not edit inside the markers.
>
> **This table was stale by a factor of 2.2 until 2026-07-29**, and it had
> inverted a conclusion: it read 116 rows against a dataset of 258, and ranked
> `boundary` above `process` where the data has process well ahead. The column's
> whole purpose is that a recurring shape is a design problem — so a wrong
> *ranking* is the one error that matters here, and it is the error a
> hand-maintained count produces.

<!-- BEGIN generated: class-tally -->

_Generated by `node scripts/practices-evidence.mjs --write`. **339** classified rows, ordered by count — the ranking is the finding, so it is not fixed to the list above._

| Primary class | Rows | Share |
| --- | --- | --- |
| **visibility** | 106 | 31% |
| fail-open | 79 | 23% |
| drift | 70 | 21% |
| process | 58 | 17% |
| boundary | 26 | 8% |

<!-- END generated: class-tally -->

**The extractor once dropped rows in silence, and the cause was findable all
along.** This page twice recorded that `--extract` "silently drops a row it
cannot parse" and asked someone to reconcile the counts before pasting any
generated figure. Exactly one row triggered it: the `js-dependency-audit.sh` row
quotes a shell pipeline as `echo "$out" \| jq`, and the parser split on **every**
`|` including the markdown-escaped one — producing 7 columns, landing `class` on
the tail of the condition, failing the class parse, and `continue`-ing without a
word. Splitting on unescaped pipes only fixes it. The residual gap stands: it
would still be silent about any *other* reason it dropped a row.

**This page previously said "fail-open is the dominant shape — three of the five
filed issues".** That was true of a five-row sample and was never revised as the
sample grew. Counted across the whole corpus, fail-open is *third*, behind
visibility and drift. The
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

**What the dataset cannot yet tell us.** Cost figures remain sparse and dates
cluster in a single month, 2026-07. So rows can be
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

**Generated, not typed — and now actually generated.** The block below is
written by `node scripts/practices-evidence.mjs --write` and asserted against
`evidence.jsonl` by `cli/src/lib/practices-metrics.test.ts`. Do not edit inside the
markers; re-run the command.

> **It took four contradictory copies to earn that.** On 2026-07-29 this section
> carried **four** tables quoting **99**, **210**, **236** and **248** rows, with
> prose variously claiming 48%, 51%, 53%, 54%, 69% and 88% — under a heading
> reading *"Generated, not typed"*. It was neither. `--report` printed JSON and a
> human transcribed it, so every concurrent session appended its own copy rather
> than converging, and none could win a merge. The dataset merged cleanly
> throughout, because it is append-only. **The transcription step was the whole
> defect**, and the fix was to delete it, not to recount more carefully — which
> the page had already resolved to do three times, in prose, without effect.

<!-- BEGIN generated: fix-repo-tally -->

_Generated by `node scripts/practices-evidence.mjs --write` from **339** rows in `docs/practices/evidence.jsonl`. Do not edit between the markers — `cli/src/lib/practices-metrics.test.ts` fails when this block does not match the dataset._

| Repo | Fixes landing here | Notes |
| --- | --- | --- |
| **biffo-template** | 159 of 339 (47%) | Core API, CLI, CI, CDN module, skeletons, migrations, publish pipeline, repo settings, orchestration schema, write-back framework, the git-hook chain, the estate audits, the practices tooling itself |
| **tabsii-platform** | 34 of 339 (10%) | Divergence ratchet, repo settings, the RLS lane and its tests, raw-SQL portability, SES identity and bounce capture, the invite payload |
| **biffo-plugin-idea-scout** | 20 of 339 (6%) | Adapter seam, research search capability, its own stylesheet, release + publish workflows |
| **tabsii-crm** | 15 of 339 (4%) | Its E2E harness, a repo setting that diverged, a timeline rendering a failed fetch as "nothing sent", the missing sibling proxy |
| **biffo-platform** | 14 of 339 (4%) | Instantiated infra — API Gateway routes, CDN, vendored-plugin resyncs, DDL seeds, log config |
| **biffo-plugin-ideation** | 14 of 339 (4%) | A UI rendering a 500 as an empty state; its publish workflow; a dead manifest block; an analyst that never searched |
| **tabsii-intake** | 5 of 339 (1%) | CI generation, branch-protection contexts, the `python-jose` removal |
| **biffo-runners** | 2 of 339 (1%) | Runner fleet docs + fail-fast |
| **tabsii-marketplace** | 2 of 339 (1%) | `python-jose` removal; the credential-dependent build |

<!-- END generated: fix-repo-tally -->

### What the shape means

**More than half of all fixes land in `biffo-template` — the repo almost none of
them surfaced in.** That ratio has been stable across every recount since the
corpus passed 100 rows, through sessions of entirely unrelated work. It is the
most durable finding on this page, and it is a statement about what Biffo *is*
rather than a defect: the template is the product, and the satellites are where
its defects become visible.

Read that way, two consequences matter more than the percentage:

- **Bug reports are attributed to where they are seen, not where they live.**
  Time spent hardening plugins or instances would not have prevented most of
  these. The clearest case remains `Failed to load catalog: Unexpected token '<'`
  in the Ideation admin UI — two stacked platform defects, a routing collision
  (#652) producing a 404 and a CDN rule (#647) disguising it as a successful HTML
  response. The plugin was correct throughout.
- **A downstream repo can be blocked by a defect it cannot fix.** #652 had no
  workaround inside `biffo-plugin-ideation`; #671/#664 blocked *every* instance's
  guards from one broken npm credential. Platform defects are throughput blockers
  for everything downstream and should be priced accordingly.

**So satellite repos are the test environment, and should be resourced as one.**
Nobody is going to fix a template defect from inside a plugin. ADR-0022's
discovery order, the ownership guard's coverage, the event registry's field
metadata and migration 0010's `public.users` assumption were all green in
`biffo-template` and all broke on first real instance use. An instance is the
template's integration test, and currently the only one.

**The counter-movement is real and worth watching.** Satellites increasingly
carry defects that are genuinely *theirs* — a sibling failing to proxy a route
its own frontend called, raw SQL that only worked because of the database
underneath it, an untracked SES sending identity, a plugin's own admin UI and
asset base path. Those could not have been fixed upstream. The number to watch is
whether the template's share keeps falling as instances grow their own surface
area, because that is the point at which "fix it in the template" stops being the
default answer.

**Two caveats on reading any single recount.** Captures whose rows are findings
about the *measurement apparatus* inflate the template's share by construction —
the apparatus lives here. And `tabsii-crm`'s jump in one session came from *how*
it was checked (a browser, not a suite) rather than from how much was built
there. Neither is evidence about the estate.

### How wide one feature reaches

> **A generator that under-reports without saying so is worse than a hand
> count**, because it carries the authority of having been computed. The
> extractor once split on every `|` including markdown-escaped `\|`, silently
> dropping exactly one row via a bare `continue` — no warning, no count of
> skipped lines. That specific defect is fixed and guarded, but the residual gap
> stands: it would still be silent about any *other* reason it dropped a row.


## Where the cycles go

The scoreboard records what *broke*. This records what it *cost*, which is a
different question and often the more actionable one: a defect fixed in ten
minutes and a defect that ate an afternoon get one row each up there.

Measured on the 2026-07-27 session, which shipped one bug fix end to end.

### The transcription step, priced (2026-07-29)

**~35 min, and it had already been "fixed" three times in prose.** The
"Where the work actually lands" section carried **four** tables quoting 99, 210,
236 and 248 rows. Three separate sessions had written a warning into it — *"do
not read this table without re-running the command"*, *"regenerate the whole
block in one go; never update a number in place"*, *"these figures should be
generated and pasted, never typed"* — and the fourth session still typed one,
because pasting is a manual step and manual steps do not survive concurrency.

**Structural, not carelessness.** `evidence.jsonl` merged cleanly through every
one of those collisions because it is append-only; the prose totals could not,
because two sessions editing the same hand-maintained number from the same base
have no correct merge. The cost was not the 35 minutes to fix it — it was that
the page's single most-quoted number was wrong by a factor of 2.5 for an unknown
period, in the section headed *"Generated, not typed"*.

**The fix was to delete the step, not to do it better.** `--write` splices the
block and a test fails when it drifts. Three prose warnings achieved nothing in
several weeks; one assertion closes it. **Any instruction of the form "remember
to regenerate X" is a defect report against the tooling.**

### The estate rollout that never happened (2026-07-29)

**~25 min to find and fix, 1+ day of exposure.** #883 added two hardened
dependency-audit scripts to `shared-files.json` and fixed both skeletons — and
never ran `shared-sync.sh`. AGENTS.md §9 states in bold that adding a file to the
shared set is not done until `--check` is clean. **12 of 13 satellites were
missing them**, which is every existing repo: the skeleton fix reaches only repos
created afterwards, which is precisely the "that is not a mechanism" failure
`shared-sync.sh` was built to end. The mechanism existed, was documented, and was
not invoked — so the distribution defect recurred *through* its own fix.

Found by running the four estate audits, not by review. The audits are the only
reason the exposure was one day rather than indefinite.

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
| **4 review rounds on one milestone, ~25 min each, for a UI tab** | Every round found a real defect and every round's fix introduced or left the next one — placeholder prompts, then a fabricated model, then a fourth duplicate default. **Structural rather than careless:** each correction named a field, so each fix addressed a field. The round that ended it named the *mechanism* ("fix it at the source, not by editing the string"). The cost is in how review comments are written, not in the agent's diligence, and shortening it means changing the instruction rather than adding a round. |
| **3 build→resync→deploy laps for a net-zero outcome, plus a 4th to revert** | Each prompt-level dedup attempt is a plugin PR, an instance resync PR, a deploy and an artefact check — roughly four merge waits per attempt. Two attempts both failed their behavioural check and the second was worse than the first. **Structural, not careless:** the only test that can distinguish them costs a live agent run, so the loop is "ship it and look" by construction. **Stopped** by reverting and moving the problem upstream to idea sourcing rather than tuning the prompt again. |
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
| **~7 full CI round trips across two PRs, for want of a local Postgres that was available all along** | Building the lane took 3 (two-stack schema, Secret Scan, green); the RLS enforcement test took 4 more (masked DSN, permission-less fixture role, `uuid = text`, green). Each ~5–9 min, mostly queueing. **The diagnosis in the first version of this row was wrong**, and it is corrected here rather than deleted because the error is the finding: it read "the user is **not in the `docker` group**", which came from `id -nG` in a long-running shell — a process inherits its group set at session start, so a group added later is absent there for the life of the process. `getent group docker` said `docker:x:116:keiran` the whole time, and `sg docker -c '<cmd>'` works with no re-login and no sudo. Verified after: the same 37 tests run locally in **3.4s** | **avoidable, not structural** — this was recorded as an environment limitation and used to justify iterating in CI. It was a misread of one command. Every one of the seven round trips was a bug a local run surfaces in seconds |
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
| **3 `BEHIND` + full-CI cycles on a one-file docstring change** | #274 changed a migration docstring and nothing else. `dev` was absorbing merges from several concurrent sessions faster than a CI cycle completes, so the branch was invalidated three times before it could land. Making `RLS (real Postgres)` required — done earlier the same hour — lengthened that cycle by the lane's cold start and measurably widened the window | **structural, and the cost landed on the very next PR.** The right trade (the lane had caught two real defects by then), but the bill is immediate and falls on every PR including ones touching no Python |
| **2 self-inflicted wait loops that reported false states** | One exited while every check was still `QUEUED` and printed "not merged"; another fired `update-branch` mid-run, which can cancel checks about to pass. Neither caused a wrong action — the merge decision is GitHub's — but both produced a readout that looked like a failure and had to be walked back | **fixed** in-session: the loop now breaks on exactly four terminal states (merged / a genuinely failing check / `BEHIND` **and settled** / keep waiting). Same class as the `gh pr checks --json` row above: **a poll you have not verified against a known state is indistinguishable from the thing it is polling** |
| **~15 min re-deriving a conclusion the repo already held** | #207's blocker was diagnosed from scratch — read the four files, rule out the sibling destinations, identify the missing carve-out. `biffo.divergence.json`'s own entry for `nav.tsx` already said it: *"Product code with nowhere legitimate to go … there is no portal equivalent of ADR-0022's `domains/` carve-out, so #207 cannot relocate it."* A previous session had reached the answer and written it where it belonged | **avoidable** — the declaration file is a first-class record of *why*, not just *what*, and nothing in the §1 checklist points at it. Worth reading `biffo.divergence.json` reasons before investigating any ownership-boundary question |
| **4 defects on one E2E file, found and fixed in ~20 min — the first measurement of what the docker fix is worth** | Building the signed-in harness surfaced four separate bugs: the board fixture is `{columns:[…]}` not `{stages,leads}` (a bare "client-side exception" naming no fixture), `Units` matching both the nav item and its collapse toggle, a created unit named "York Road" colliding with its own address "12 York Road", and shared fixture state across parallel workers. Each was a full local run of ~19s | **avoided cost, quantified.** The same four in the morning's regime — no local Postgres *or* browser — would have been **four CI round trips at 5–9 min each**, most of it spot-fleet queueing. The `sg docker` correction paid for itself within one task |
| — | **154 of 155 scoreboard rows carry no cost, so the corpus can be counted but not ranked.** §8 requires "what it cost in wall-clock time"; one row has ever recorded it. A ten-minute fix and one that ate an afternoon are the same size in the dataset, which makes "what should we restructure?" — the question the scoreboard exists to answer — unanswerable from it. **Checked before blaming the extractor: only 5 rows state a duration in any form, so this is a capture failure, not a parsing one** | **visibility** | `docs/practices/evidence.jsonl` | biffo-template — the capture step, wherever it lands | unfiled |
| — | **Both recoveries from earlier data loss silently corrupted the page.** #762 ("restore three sessions deleted by a stale-base merge") and #777 ("restore 93 lines #774 deleted") each re-inserted a repo-tally row into the *cost* table, where a 3-column row is structurally valid and therefore invisible — they sat there through every subsequent edit and every review of this page. Restoring deleted content is treated as self-evidently safe and is the one operation here with no verification step at all | **drift** | `docs/guides/development-practices.md` — found by grepping for a stale count | biffo-template — the restore practice, and whatever checks table shape | unfiled |
| — | **`parseCost` takes the first match of the word "cost" and gives up, so a row that discusses cost before stating its figure loses the figure silently.** `"no cost, so the corpus … this cost 25m"` extracts `null`; `"cost 25m"` alone extracts 25. It also requires that exact keyword, so every row phrased `"~40 min round trip"` or `"ate an afternoon"` is invisible to it. Small today — it drops 5 rows — but it fails **in the direction of the discipline**: the more carefully a row explains what something cost, the likelier its number is discarded | **fail-open** | `scripts/practices-evidence.mjs` `parseCost` | biffo-template — `scripts/practices-evidence.mjs` | unfiled |
| — | **The number this page exists to produce is present three times, with three different values, and nothing reconciles them.** `docs/guides/development-practices.md` carries three `byFixRepo` tally blocks — at the time of writing saying **220**, **210** and **236** rows, with `biffo-template` at 48%, 49% and 53%. Each was written by a different session updating "the" tally and matching only the first or nearest block. I found it only because a deletions audit showed my own edit had replaced a block still reading **99 rows**, four months of drift stale, that I had not known existed. The skill's own guidance says *"a stale count is worse than none, because it will be quoted"* — this is that, tripled, on the section that answers *where should we invest*. **Left in place rather than resolved**: choosing which of three is canonical is a call for the review, and deleting two other sessions' blocks is how this page lost content twice before | **drift** | `docs/guides/development-practices.md` | needs one tally with one owner, or a generated block | unfiled |
| — | **A view labelled "built-in" served invented data, and its promote button would have written the invention into the database as production config.** An admin panel's merged agent view listed four roles whose `system_prompt` was the literal string `(Built-in prompt — stored row not found)`. "Store a copy to edit" writes the displayed row — so one click would have replaced a working research agent's prompt with that placeholder, and the next run would have briefed the agent with it. The three research agents genuinely read stored rows, so this was live, not cosmetic. **30 tests green at the time**, because they asserted the row rendered, not that its content was real | **fail-open** | `biffo-plugin-idea-scout` #61, caught in review before merge | biffo-plugin-idea-scout #61 | fixed |
| — | **A correction was applied to the field named in it, three times, rather than to the property it was about.** Told the built-in prompts were fabricated, the next revision served real prompts — with a **fabricated model**, dropping the `:online` suffix that is how research reaches the web, so promoting a built-in would have silently disabled search and bypassed the server-side guard built one milestone earlier for exactly that. Told again, the fix moved to the source rather than the symptom only when the instruction said *"fix it at the source, not by editing the string."* Condition: **"use real data" lands as a patch to the named field unless the correction states the property and the mechanism**; naming the defect is not the same as naming the class | **process** | `biffo-plugin-idea-scout` #61, three consecutive rounds | biffo-template — how a review comment is written changes what it fixes | unfiled |
| — | **Four statements of one default, none checking each other, produced two bugs in one milestone.** The built-in model defaults were written in `app.py`'s env fallback, the admin `builtin-agents` endpoint, `seed_agent_config.py` and `seed_fan_in_workflow.py`. The endpoint's copy silently lacked `:online`; the workflow seed's copy was simply a fourth. Now one constant in `definitions.py` that all four import, with a test asserting the research defaults keep their suffix — **verified by removing it, which fails that test**. This is the same shape as the estate's most-recorded class, in a feature whose entire purpose was controlling which model runs | **drift** | `biffo-plugin-idea-scout` #61 | biffo-plugin-idea-scout #66 | fixed |
| — | **A milestone's test suite grew 26 → 28 → 30, green throughout, while a destructive defect survived all three versions.** Every defect in that milestone — placeholder prompts, a fabricated model, a duplicated cross-language constant, an untested new endpoint — was found by **reading the diff**. None by any test, and the suite grew at each round because each round added tests for the thing just fixed. Condition: **a growing green suite is evidence about what the tests examine, and says nothing about what they do not**; test count is the metric most likely to be read as coverage and least likely to be one | **visibility** | `biffo-plugin-idea-scout` #61 across four review rounds | needs a review step that cannot be satisfied by adding tests | unfiled |
| — | **A subagent reported the gates of the language it started in, after changing another.** Scoped to `web-admin/`, it later added a Python endpoint in `src/idea_scout/admin_app.py` and reported `lint`, `typecheck` and `test` — all JavaScript. Running `pytest` myself showed 204, unchanged from the previous milestone, which is how I learned the new endpoint had **no Python test at all**. Nothing was wrong with the gates; they were simply the wrong ones, and the report was accurate about the checks it ran | **process** | `biffo-plugin-idea-scout` #61 | prompts must ask for gates by change, not by scope | unfiled |
| — | **A curated list shipped as the safe choice was wrong for half its consumers, and it replaced free text that at least forced deliberate entry.** Seeding the ideation model catalog, I loaded five models straight from the seed script without checking that web search travels with the model id — OpenRouter's `:online` suffix, chosen precisely *because* the tool-based alternative could be silently half-configured. Two of the four agents that read this catalog (idea-scout research, ideation analyst) do not work without it, and none of the five entries carried it. The picker shows every entry to every agent with nothing marking which will disable search, and the failure is the documented expensive one: no findings, run fails, four paid model calls. **Caught by the operator reading the list, not by me writing it or by any test.** Condition: **replacing free entry with a curated picker moves the correctness burden from the person typing to the person curating, and nothing checks the curator** | **fail-open** | `biffo-plugin-ideation` model catalog, seeded for #91 | biffo-plugin-ideation #92 — needs a `web_capable` flag, not better labels | open |
| — | **Two issues were filed on wrong premises in one session, both by grepping a single file and generalising to the feature.** #89 said "the model catalog governs nothing" — the picker already existed in `web-admin/src/components/`, which I never opened after checking the table and the request path. #888 said the run detail page "shows no cost at all — zero references" — it showed cost at `agent-run-detail-client.tsx:235`; I grepped `[slug]/page.tsx`, got zero, and never noticed the page delegates to a client component. **Both times the real defect was better than the filed one** (an empty catalog; a duplicated money formatter), so the work was not wasted — but the issues were wrong, and an issue is read by whoever picks it up. Condition: **a zero-hit grep over one file is evidence about that file, and gets written up as evidence about the feature** | **process** | `biffo-plugin-ideation` #89, `biffo-template` #888 | both closed with corrections on the issues | fixed |
| — | **An instance carried a known-fixed defect for two minor versions, and the fix arrived as a side effect of unrelated work.** `biffo-platform`'s `main.py` had `build_core_crud_router()` above `build_domain_router()` — the #668 defect, where building the domain router is what *imports* domain packages and registers their models, so reversed, every `/api/v1/data/<table>` route a relocated domain backs vanishes **silently, with a green suite and green CI**. The template fixed it; the instance did not receive it until a `core upgrade` was run for a different feature entirely, where it surfaced as a merge conflict. Nothing forces or reports the gap: an instance can sit on a fixed defect indefinitely and the only signal is somebody happening to upgrade | **drift** | `biffo-platform` `services/api/src/api/main.py` | biffo-platform#120, guarded by the template's `test_main_router_ordering.py` | fixed |
| — | **The extractor silently drops a scoreboard row whose text contains an unescaped pipe — and the row it ate was the one about piped commands.** A row is parsed by splitting on `\|`, so a literal pipe in the prose produces 7 cells where 6 are expected and `extractRows` skips it. No error, no warning: the row renders on the page and is absent from `evidence.jsonl`, so every headline computed from the dataset is short by one and the page and the dataset disagree in the *opposite* direction from the known duplication defect. Found only because I counted rows added (2) against rows written (3) | **fail-open** | `scripts/practices-evidence.mjs` `extractRows` | biffo-template — needs to warn on a cell-count mismatch, not skip | unfiled |
| — | **RECURRENCE, third instance in one day, one hour after writing the row about it: a piped git command reports the pipe's status.** `git commit … <<EOF ... EOF \| tail -2; echo $?` printed `0` while commitlint rejected the message (`merge:` is not an allowed type) and the merge stayed uncommitted. Caught only because `git log origin/dev..HEAD` showed zero commits ahead. The corpus already holds this condition twice and I had authored the second entry ninety minutes earlier. **Frequency is now the finding**: three instances in a day, by an author who knows the rule, is not an attention problem — it is a rule with no mechanism, and every instance arrived while filtering output for a legitimate reason (a dependabot banner, hook noise) | **process** | this session, third time | biffo-template — the reminder approach is falsified | unfiled |
| — | **The obvious fix for a measured failure made it measurably worse, on both axes, and was only caught because the same measurement was repeated.** Title-only dedup produced 4 candidates, 1 genuinely new. Briefing the pitches as well — more information, better targeted, cheap in tokens — produced **2 candidates, 0 new**, and reused a prior product name verbatim that the weaker version had avoided. Two is half the documented floor of five, so it was a product regression independent of how novelty is scored. Hypothesis, not conclusion: **describing what to avoid in detail may anchor a model on it rather than steer it away.** Reverted rather than tuned | **visibility** | `biffo-plugin-idea-scout` #56, reverted by #58 | biffo-plugin-idea-scout — reverted; direction moved upstream to sourcing | fixed |
| — | **Two features were built, merged, resynced across two repos and deployed before anyone asked whether they worked — and neither did.** Each attempt cost a plugin PR, an instance resync PR, a deploy and an artifact verification: **three full laps for a net-zero outcome**, plus a fourth to revert. Every gate was green throughout and every gate was honest; they assert plumbing, and the requirement was behavioural. The condition is not "we forgot to test" — **there was no cheap test to forget.** The acceptance test that settles it (run twice with identical inputs, count same-idea-different-name) costs a real agent run and a human judgement, so nothing in the pipeline will ever run it | **process** | `biffo-plugin-idea-scout` #49, twice | needs a budgeted behavioural check, not another gate | unfiled |
| — | **A feature shipped, deployed, passed every test, and does not do the thing it was built for — measured only because someone asked for the measurement.** Cross-run dedup briefs the agents with titles the founder has already seen. Four runs on dev with identical inputs: **3 of 4 candidates were near-duplicates of prior ones**, one of them the same idea with the words reordered (`Compliance-Evidence Autopilot for Fintechs on AWS/GCP` → `PCI Autopilot — continuous compliance evidence for fintech teams on AWS`). The tests were all honest: they assert the list reaches synthesis, which it does. **Nothing in the suite could have been written to assert that a model obeys an instruction**, so the gap between "the mechanism works" and "the feature works" was invisible to every gate | **fail-open** | `biffo-plugin-idea-scout` #49, reopened on evidence | biffo-plugin-idea-scout #49 — needs semantic matching, not string matching | open |
| — | **I put a made-up percentage in an issue and it became the argument for not doing the harder thing.** #49 said *"exact-ish title avoidance is the cheap 80%"* — a number with no measurement behind it, used to defer semantic deduplication as out of scope. Measured afterwards it is about **25%**. Worse, the evidence was already sitting in the product: across three pre-fix runs **no title repeated verbatim either**, so string matching could never have caught any of it, and five minutes reading the historical candidates before building would have shown that. Condition: **a quantified claim invented to justify a scope boundary is indistinguishable, in the issue text, from one that was measured** | **process** | `biffo-plugin-idea-scout` #49 as originally filed | biffo-template — a number in an issue needs its source or a hedge | unfiled |
| — | **The state existed, was named, was documented, and one call site of three ignored it.** idea-scout's `App.tsx` declares `loaded` with a comment explaining that an unloaded app and an empty list are otherwise indistinguishable. Two call sites honour it; the Past Scouts sidebar does not, and tells a founder with eleven runs that they have none. Harder than the same-day sibling defect in ideation where the concept was simply absent — **a reader sees the flag and reasonably assumes it governs the empty-state copy everywhere**, so the bug is invisible to exactly the person checking for it | **drift** | `biffo-plugin-idea-scout` `web/src/App.tsx:171` | biffo-plugin-idea-scout #53 | open |
| — | **The check I used as the resync gate all day confirms agreement between two copies, not that either is current.** Every vendored resync was verified with `diff -rq` against a local worktree of the plugin's `dev`. On the last one that worktree was stale: the vendored copy and the source were **both missing the merged change**, `diff` reported `identical` for `src` and `tests`, and the gate passed while carrying nothing. It fired only because I separately grepped the vendored file for the feature name and got zero. The condition generalises past this workflow — **any equality check between two artefacts is silent about the currency of the reference**, and a stale reference makes it pass in exactly the case it exists to catch | **fail-open** | `biffo-platform` resync of `biffo-plugin-idea-scout` #51 | biffo-platform — the resync check must establish the source's HEAD, not assume it | unfiled |
| — | **A key added to the wrong brief is dropped by the fan-in with no error, and the run still produces plausible output.** `agent_fan_in` forwards only the keys **every** contributing sibling carries with an equal value, so data added to one research brief and not its siblings never reaches synthesis. Nothing fails: no exception, no empty result, just candidates that quietly ignore the input they were supposed to weigh. Building cross-run dedup, this decided the whole design — the list had to go in the shared brief or the feature would have shipped, passed its tests, and done nothing. The repo already had a test file written for this exact shape after #26, which is the only reason it was obvious | **visibility** | `biffo-plugin-idea-scout` synthesis path | biffo-plugin-idea-scout #51 — asserted in `test_idea_scout_shared_brief.py` | fixed |
| — | **A severity estimate read off the code was wrong by roughly 8x, in the direction that argues for not doing the work.** Filing a UI defect I wrote that it *"self-corrects within a second"* and used that to classify it minor. Watching the deployed app, the window is **5–8 seconds** — still pending at a 3-second screenshot, resolved only after another five, because the plugin-host Lambda is cold. The error is not random: **reading code tells you the sequence of operations and nothing about how long each takes in the environment it runs in**, so a duration inferred that way omits every source of latency and is systematically optimistic. A founder staring at a false "you have no runs" for eight seconds is a materially different product than one seeing it for one | **visibility** | `biffo-plugin-ideation` #83, corrected on the issue after deploying | biffo-plugin-ideation #84 | fixed |
| — | **Installing dependencies "in the worktree" is not one action once a repo keeps its JS in subdirectories.** `pnpm install` at the worktree root leaves `web-admin/node_modules` absent, and the now-fixed pre-push gate fails there with `tsc: not found` and `vitest: not found` — a failure that surfaces two steps from its cause, as a rejected push. The corpus already holds *"§2's dependency install is load-bearing"*; this is the same rule with a new edge, because the number of places needing an install is a property of the repo's layout rather than of the workflow step that tells you to do it | **process** | `biffo-plugin-ideation`, push rejected | biffo-template — the workflow step needs to say per-package | unfiled |
| — | **RECURRENCE: a check was declared impossible without establishing that it was.** Asked to verify a UI feature, I told the operator twice that no one could look at it in a browser and built the case carefully — no local Core, SigV4 to a live API, no committed env config. All true, and all irrelevant: Chrome automation was available the whole time, and the operator had to ask for it. The corpus already holds *"a cleanup was declared impossible after asking only one of the two available questions"*. Condition: **a capability that must be loaded before use is indistinguishable, when reasoning about feasibility, from one that does not exist** — so the reasoning runs over a tool list that is smaller than the real one, and the conclusion is confidently wrong | **process** | this session, twice in consecutive turns | biffo-template — feasibility claims need a capability check, not an argument | unfiled |
| — | **An assertion that names a value the test never supplies cannot fail, and reads as coverage.** A generated test for "renders no title when none is given" asserted `queryAllByText(/My Awesome Idea/)` was empty — a string supplied only by a *different* test. Proven vacuous by mutating the component to always render the element: the test still passed. The replacement asserts the element's absence and fails under the same mutation with `expected <header …(1)></header> to be null`. Distinct from the corpus's existing "test encodes its own premise" row: that one asserts something true of the implementation, this one asserts something true of *nothing at all*. **Reading the test did not reveal it — mutating the code did** | **fail-open** | `biffo-plugin-ideation` #81, caught in review before merge | biffo-plugin-ideation #81 | fixed |
| — | **A UI can model "loaded" and "failed" and still have no way to say "not yet asked".** #72 gave the session sidebar a representation for *"I failed to find out"*, closing a defect that had produced two wrong diagnoses. It still asserts "No past runs yet" between mount and the first fetch resolving, because `sessions` starts `[]` and `sessionsFailed` starts `false` — indistinguishable from a completed empty load. Three states exist in reality (unknown, empty, failed); the UI models two. Self-corrects in about a second, so far less costly than #72's version — but the *same missing distinction*, found in the code that had just been fixed for its sibling | **visibility** | `biffo-plugin-ideation` `web/src/components/Sidebar.tsx` | biffo-plugin-ideation #83 | open |
| — | **A value correct in the context it was written for shipped into another where it reads as broken, and only a browser could show it.** `_derive_title` trims to 60 characters — right for a ~180px sidebar column, inherited unexamined by a ~1170px full-width tile, where the text fills a third of the space and stops mid-phrase. Every test passed; none could have caught it, because the defect is entirely in the relationship between a number and a layout. Flagged as an open question in the plan, built to the default when the question went unanswered, and **the default turned out to be wrong in a way only visible once rendered** | **drift** | `biffo-plugin-ideation` report tile, seen on dev | accepted as-is by the operator | worked around |
| — | **A single-page app that authorises requests from a session object captured at mount stops working silently at token expiry.** A `CognitoUserSession` is an immutable snapshot: `getIdToken()` returns the same token forever, and `getCurrentSession()` hands back the *cached* one whose `isValid()` is true right up to the expiry second. So a page that mounts with seconds of token life left 401s every subsequent call for the rest of its life — no signed-out state, no retry, no recovery but a reload the user has no reason to attempt. Found in the founder app and then, identically, in the admin panel beside it | **visibility** | `biffo-plugin-ideation` `web/` and `web-admin/` | biffo-plugin-ideation #72, #73/#76 | fixed |
| — | **RECURRENCE, third instance: a list that renders "loaded but empty" and "failed to load" as the same state turns any staleness or auth failure into an apparent data-loss report.** Already recorded twice — an admin panel showing a 500 as "No catalog entries yet", then the same shape in another repo. This one is the most expensive yet: "No past runs yet" was reported as lost sessions, **twice**, and each report came with a confident and wrong diagnosis (first "the list endpoint is broken", then "four Cognito pools make identity vary by page load"). Two sessions searched two wrong layers because the UI asserted a fact it could not know. The condition is not a UI-copy problem, it is a UI that has no representation for "I don't know" | **visibility** | `biffo-plugin-ideation` `web/src/components/Sidebar.tsx` | biffo-plugin-ideation #72 | fixed |
| — | **A list refreshed only on a downstream success event goes permanently stale when that event never fires.** `refreshSessions()` ran at mount, on report materialisation and after a delete — never after the create that produced the row. A run created on a page whose list predated it stayed invisible for that page's entire life while returning `200` to any direct call, and the report poll's `catch` stopped the poll permanently, removing the last remaining refresh path. The create path must refresh what it creates; hanging it off a later success couples visibility to a step that may never happen | **drift** | `biffo-plugin-ideation` `web/src/App.tsx` | biffo-plugin-ideation #72 | fixed |
| — | **A test can pin an agreement between two values, neither of which reaches a request.** `test_the_reported_models_are_the_models_the_founder_app_uses` asserted `builtin_chat_agents()["challenger"]["model"] == app._CHAT_MODEL`. Both were real, both were equal, and both were discarded before the wire — the plugin sent Core no chat model at all. The guard was green for the whole life of the defect it was named after. Condition: **a drift guard compares two sources without any assertion that either is consumed** | **fail-open** | `biffo-plugin-ideation` tests | biffo-plugin-ideation #74 | fixed |
| — | **A gate can pass while structurally unable to observe the thing it guards.** `test_costs_no_core_round_trip` enforced that `/effective-config` made no call to Core. The property wanted was "cannot fail when Core is cold"; what it encoded was "must not look" — and a route that must not look cannot be correct about anything stored. Condition: **a test asserts the absence of a mechanism as a proxy for a guarantee that mechanism could still have provided** | **fail-open** | `biffo-plugin-ideation` tests | biffo-plugin-ideation #74 | fixed |
| — | **Two panels answered the same question from different sources and only one consulted the authority.** The Chat Agents tab read stored rows and labelled them honestly; the Model Catalog tab's "Models in use" block reported built-in constants as though they were in use. Same page, same session, opposite answers — and the constant it reported could never affect a request, so this was not stale configuration but a **display fiction**. `effective_config`'s own docstring asserted a fallback that did not exist | **drift** | `biffo-plugin-ideation` `web-admin/` | biffo-plugin-ideation #74 | fixed |
| — | **Authentication runs before routing, so from outside a deployment a plugin that does not exist is indistinguishable from a live one.** Verifying an install, `/api/v1/plugins/idea-scout/build-types` returned 401 — and so did `/api/v1/plugins/does-not-exist-xyz/foo`. Four 401s read as confirmation until a deliberately-absent control was added. Nothing externally observable answers "is this plugin mounted?", which is the exact question every install verification asks | **visibility** | `biffo-platform` API Gateway / plugin host | biffo-platform — needs a discriminating signal | unfiled |
| — | **A pre-push gate reported `verify passed` on a change written entirely in a language it never checked.** In a plugin repo it printed `javascript n/a - no package.json in this repo` — true of the repo *root*, while the change was 100% TypeScript under `web-admin/`. The same gate in an instance, which has a root `package.json`, ran lint, typecheck, formatcheck and test on the same kind of change. Condition: **a gate detects applicability from a marker at the repo root, in repos whose code deliberately does not live there** — so the language most plugin changes are written in is the one least verified, in green | **fail-open** | `biffo-plugin-ideation` pre-push gate | biffo-template — the shared verify script | unfiled |
| — | **RECURRENCE of a condition this project has written down twice and warns about in AGENTS.md §6: a piped `git push` reports the pipe's status, so a failed push prints success.** I ran `git push -q ... 2>&1 \| grep -v vulnerabilit \| tail -1; echo "push: $?"` and got `push: 0` while the push had failed and the commit had never been made — `lint-staged` was missing because I skipped the worktree's `pnpm install`. It surfaced only because `gh pr create` refused for want of a remote branch. The rule was quoted earlier in the same session by the same author. Condition: **a safety rule that depends on remembering not to pipe will be violated by anyone filtering noisy output** — and both times, the noise being filtered was unrelated (a dependabot banner) | **process** | `biffo-platform` — my own command | biffo-template — the rule needs a mechanism, not a reminder | unfiled |
| — | **RECURRENCE, and a new shape: complete-but-open reached the parent.** Three more instances in one day — an epic, a milestone, and a delivered API issue. The epic's own checklist had **all nine boxes unticked against eight closed milestones**, so it asserted "nothing delivered" throughout a completed v1. Nothing ticks a parent when a child closes and nothing compares the two, so the tracker's summary view degrades in exactly the direction that hides finished work. Previously recorded at the leaf; this is the first at the roll-up that people actually read | **visibility** | `biffo-plugin-idea-scout` #1, `biffo-platform` #75, `biffo-plugin-ideation` #20 | wherever issue hygiene is automated | unfiled |
| — | **Rewording a scoreboard row silently duplicates it in the dataset.** Row identity is derived from the row's own text, and `mergeExtracted` keeps orphans, so an edited row is stored as a *new* row while the pre-edit version survives — every correction inflates the corpus. I did it three times in one session correcting my own figures, publishing a headline of 161 against a page rendering 157. **The retention is deliberate and load-bearing**: dropping orphans previously deleted every stored row a stale branch's markdown did not mention, and that fired for real. So this is a genuine trade-off between silent duplication and silent deletion, not a bug with an obvious side — and nothing currently reports either number against the other | **drift** | `scripts/practices-evidence.mjs` `mergeExtracted` / `rowKeys` | biffo-template — needs a decision, not a patch | unfiled |
| — | **51 of 155 rows have no date, so a third of the corpus cannot be time-sliced.** "Is this class getting better or worse?" is unanswerable for those rows, and they are silently excluded from any windowed view rather than reported as missing | **visibility** | `docs/practices/evidence.jsonl` | biffo-template — the capture step | unfiled |
| — | **The effort log cannot be sliced by repo: 10 of 26 entries — 1,200m, 36% of one day's logged minutes — name no repo.** The dashboard's per-repo platform/product split is inferred from commit types and repo names, and the recorded entries exist to falsify that inference. Entries naming no repo cannot confirm or refute it, so a third of the ground truth is inert against the thing it was collected for | **visibility** | `~/.practices-sessions.jsonl` | biffo-template — `scripts/practices-session.mjs` | unfiled |
| — | **Three repos merged work with no effort entry at all** — `biffo-plugins-registry` (4 PRs), `biffo-platform-app` (1), `tabsii-intake` (1). Not proof of unlogged effort: a repo can take a merge carried from elsewhere. But nothing distinguishes "no effort spent here" from "effort spent and not logged", so the zero cannot be read either way | **visibility** | estate-wide, measured across 145 merges in one day | biffo-template — the capture step | unfiled |
| — | **26 of 155 rows sit at status `unfiled`: recorded as findings with no issue raised and therefore no route to action.** They are counted in every headline the scoreboard produces, so the corpus reports a level of engagement the backlog does not carry | **process** | `docs/practices/evidence.jsonl` | wherever each row's fix belongs | unfiled |
| **1 PR merged by hand because `--auto` is rejected, not queued** | `tabsii-crm` has `allow_auto_merge=false`, so the armed merge failed immediately and the wait-loop reported failure while the PR sat green and unmerged. Cheap this time because the loop was watched; the failure mode is a green PR nobody merges | **open** — see the scoreboard row; the setting is deliberately untouched pending the H3 comparator question |
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

### Measured: one security one-liner, 2026-07-28

The clearest instance of the six-hop cost yet recorded, because the change itself
was trivial and everything else was overhead. The fix was **two keyword
arguments**. Landing it in both instances took **~100 minutes of wall clock** and
produced **7 merged PRs, 3 npm releases, 1 closed PR, and 2 full traversals of
the distribution chain**.

| Hop | What it cost |
| --- | --- |
| Template PR → merge | ~10 min (#784) |
| `core-v*` tag → npm publish | ~2–4 min, ×3 releases |
| Instance upgrade PR → CI | ~10 min, ×3 (one closed unmerged) |
| Instance merge → deploy | ~9 min |
| Post-deploy verification | ~10 min (artifact download + log queries) |

**The second lap was self-inflicted and is the single biggest line item.** The
guard shipped in 0.157.1 encoded this repo's file layout as universal (scoreboard
row above), passed every gate here, and failed on the first instance. That forced
`#787` → `core-v0.157.3` → close biffo-platform#93 → re-cut #94: **a complete
extra traversal, ~25 minutes, for a defect no local gate could have caught**.

**The merge race is still unfixed and cost 28 of those minutes.**
tabsii-platform#284 was created 10:47 and merged 11:25 — **38 minutes**, of which
roughly **28 were spent green-but-unmerged**. All six required checks passed
(including the RLS real-Postgres lane), auto-merge was armed since 10:51, and the
PR simply sat at `BEHIND`. It moved only after a manual `gh pr update-branch`,
which then triggered a **full CI re-run** before it could land.

That is the H1 experiment's predicted refutation, observed live: **auto-merge does
not update a head branch that falls behind under `strict` protection.** It removed
the retry loop but not the wait. The next move is a merge queue, or relaxing
`strict` — not more auto-merge.

**What was NOT the cost.** Writing the fix, writing 10 tests, and proving each one
failed first accounted for maybe 15 of the 100 minutes. The verification that
actually mattered — downloading the deployed Lambda and reading it — took under a
minute. **The expensive parts were all structural: waiting for the chain, and one
lap of rework the chain made expensive.** A shorter chain would have made the
mistake cheap rather than preventing it.

### Measured: shipping two plugin features to *working*, 2026-07-28

The six-hop chain again, but the instructive part is different from the
SQL-echo capture. There the cost was **waiting**; here it was **discovering, only
after each deploy, that the thing did not work** — and each discovery cost a
whole further lap.

Three deploys to land two features:

| lap | carried | what the deploy revealed |
| --- | --- | --- |
| 1 | admin UI + preferences + migration | admin page **blank**; preferences **silently dropped** |
| 2 | base-path fix | (folded, see below) |
| 3 | pass-through fix, folded into lap 2's PR | both verified working |

**Neither defect could have been caught before deploying.** The Vite `base` only
affects URLs inside the emitted HTML, so lint/types/tests/build all pass. The
pass-through was covered at both *ends* — service tests and frontend tests — and
broken in the *seam*, where nothing looked.

**The saving that did work:** folding the third fix into lap 2's still-open PR
rather than opening a third resync. One-line source fixes to the same vendored
plugin do not each deserve a lap at ~15–20 minutes of mostly waiting.

**The structural read.** The distribution chain is not the problem here — the
*feedback* chain is. Every one of these defects was a 30-second fix found in a
20-minute round trip. Anything that moves discovery earlier is worth more than
anything that shortens the lap: the two new guards (built-HTML asset paths,
transport-level pass-through tests) are exactly that, and they cost nothing to
run.

### Measured: one CRM feature across three repos, 2026-07-28

**~5.5 hours wall clock, 12 PRs merged, one feature verified working end to end
and one shipped inert.** The build was not the expensive part.

> **This figure was first written as "~3 hours" and corrected by the operator.**
> The correction is kept visible because it is the more useful finding — see
> *The self-estimate was 45% low, and the cause was the unit* below.

**The loop, not the keystrokes.** Nine PRs, each gated on a self-hosted fleet
whose CI cycle is ~3–6 min but whose *queueing* was unbounded:

- **Two jobs sat `queued` for 27 minutes** with an otherwise-empty org-wide
  queue, while three jobs from the *same run* started and finished. Cancelling
  and re-dispatching cleared it. Structural, not unlucky — nothing in the PR
  page distinguishes "queued behind work" from "queued behind nothing".
- **A force-push produced no workflow run at all** (AGENTS.md §6's documented
  case). `workflow_dispatch` re-ran it green — and **did not satisfy the
  `pull_request` required checks**, because a dispatch run is not a
  `pull_request` event. The PR still showed the cancelled run's failure. Closing
  and reopening the PR was what actually re-fired the checks. That two-step is
  not written down anywhere and cost ~25 min.
- **One rebase** after a sibling PR merged into the same router-registration
  list. Unavoidable, cheap, correctly caught by the merge state.

**Six deploy-and-verify hops.** Each upstream seam needed: merge to
`biffo-template` → `core-tag` → npm publish → `biffo core upgrade` → instance CI
→ instance deploy. ~40 min minimum for a one-line payload change to become
observable, and this feature needed the round trip **once** — the rest was
avoided by putting the instance-specific half behind a generic registry, which
is the design lesson worth keeping.

### Measured: a fix that shipped, closed its issue, and reached nobody, 2026-07-28

**~35 min, and the loop is one hop long.** The defect was found in ~10 minutes
(unzip the deployed Lambda, `grep effective`, zero hits) and the fix already
existed and was already merged. The other ~25 minutes went on establishing that
a *merged, closed, green* change was not deployed — which no artefact on the
plugin side can tell you, because every signal there was truthful about the
plugin and silent about the instance.

**This is the fourth recurrence of one condition, not a fourth incident.** The
resync row above has been "worked around — 3 resync PRs this session" since it
was written; this session added a fourth. The cost per occurrence is small
(~35m) and that is exactly why it keeps being paid rather than fixed: no single
occurrence clears the bar to restructure, and the row's own status field records
the workaround as though it were a resolution.

**Structural, not carelessness.** The 45-minute gap that caused it — resync
[#92](https://github.com/keiranholloway/biffo-platform/pull/92) carried the
plugin's #59 at 09:26; #60 merged at 10:11 — is unwinnable by hand: a resync PR
is only correct for the commits that exist when it is opened, and any plugin PR
merged after it is silently excluded with no warning at either end. The fix is
the preflight drift check ([#729](https://github.com/keiranholloway/biffo-template/issues/729)),
not more diligence.

### Measured: one symptom, six defects, four repos, 2026-07-28

**The session that prompted "we seem to be redoing so much work here."** It
started as *"the ideation admin page is empty"* and ended having merged six PRs
across four repos. That is not scope creep — every defect was real and each
blocked the next — but the **order they were found in is the finding**:

| # | Defect | Surfaced by |
| --- | --- | --- |
| 1 | #60 never resynced; deployed Lambda predated the fix | the empty panel |
| 2 | Manifest carried a dead duplicate of a live prompt | reading the manifest while fixing 1 |
| 3 | Storing a built-in froze its prompt — no edit field anywhere | doing what the panel invited |
| 4 | `web_search` declared but never offered (empty Brave key) | a user asking "is it passing `:online`?" |
| 5 | Analyst model slug absent from OpenRouter | verifying 4 against the live model list |
| 6 | Models still env-hardcoded, not in the DB | reading the panel after 1 deployed |

**Five of the six were discovered by chasing a symptom, not by reading the
code.** Defects 4 and 5 sit in the *same 40-line function*; one `grep` of
`definitions.py` against the deployed configuration would have found both in one
pass. They were found hours apart, by two unrelated routes, and only because
someone asked a good question. Defect 6 is visible on the same screen as defect
1 and was still missed on the first look.

**This is the traversal cost above, but the diagnosis is sharper than "one hop
reveals one defect".** The hops are real, yet the deeper waste is
**symptom-driven discovery serialising defects that a single audit would have
found in parallel.** Each symptom costs a full plugin → resync → deploy → click
round trip to *reach*, and then reveals exactly one thing.

**What would have changed it:** on first touching a plugin whose behaviour is
suspect, read its definition module against the deployed runtime configuration —
model ids against the provider's live model list, declared tools against the
runtime's availability predicates — before fixing the reported symptom. That is
one ~10-minute pass. It would have collapsed defects 4, 5 and 6 into the first
round trip and removed two full traversals.

**Near-miss worth its own line.** The resync for #104 was first taken from a
**stale primary checkout** (local `dev` missing both plugin PRs). It produced an
empty diff that is indistinguishable from "already resynced" — a clean
`git status` as *evidence of completion*. Caught only by grepping the vendored
file for the string the change should have introduced. Had it shipped, the PR
would have claimed a fix while carrying nothing: the same shape as the bug the
session began with, one layer down.
**Where the time actually went**, from the effort log once the missing units
were added: **330 min — delivery 180, platform 45, toil 105.** The delivery half
is three implementation plans, an assessment of three PRD requirements against a
running system, three issues, and the feature itself. The toil is CI queue,
deploy waits, and the recovery steps above.

### Second calibration: the proxy overstates toil by 32 points, 2026-07-30

The first calibration (2026-07-27) recorded **toil 30.4%** against a merge-derived
**43.5%** — the proxy overstating by ~13 points. Today, four sessions logging
**981 minutes** between them:

| | recorded | merge-derived | gap |
| --- | ---: | ---: | ---: |
| delivery | 25% | 27.5% (`capabilityShare`) | ~2 pts |
| platform | 50% | — | — |
| **toil** | **24.3%** | **56.2%** | **~32 pts** |

**The gap more than doubled, and the cause is visible in today's work.** Of 153
merges, a large share were nine near-identical `.gitignore` PRs, four resyncs and
several shared-file syncs — every one classified `chore:`/`fix:` and therefore
counted as toil, while by *intent* they were deliberate machine improvement. The
collector cannot see intent; it sees a conventional-commit type.

That is the same shape already recorded as *"share of merges is not a cost"*, now
with a number: **a day spent deliberately fixing the machine is indistinguishable
from a day lost fighting it**, and the proxy reads the second.

**What this does NOT license.** It is tempting to conclude the proxy is simply
wrong and should be discounted. Two calibration points, both from days chosen by
whoever happened to log, is not a sample — and the direction of the bias is the
convenient one for anyone recording their own effort. The honest statement is
narrower: **the proxy and the record disagree by a widening margin, the
disagreement concentrates in `toil`, and neither is yet established as the truth.**
A third and fourth data point on ordinary days, logged by sessions that did not
just have a bad one, is what would settle it.

### Measured: a one-day feature took four days, and why, 2026-07-30

The operator expected Idea Scout in its current form to be **a single day**. It
took four, and asked the right question on day four: *"we seem to be going around
in circles."* Partly. This separates the two causes, because they need different
fixes.

**Cause 1 — nothing exercised it end to end, so the defects could only be found
serially.** Four independently-sufficient defects stood between an admin edit and a
working run (row above). Each was invisible to every gate: the routing gap needs a
browser and a CDN, the absolute-path mount needs a *mounted* app rather than a
`TestClient`, the registration-order shadowing needs a built `dist` that a source
checkout does not have, and the run form needs a real founder session. So they
surfaced one per verification attempt, and each attempt cost a fix, a resync, a
deploy and a re-verification. **That is not circling; it is a queue being
discovered at the rate the only working instrument can reveal it.** But it reads
identically from outside, and four days is the honest price of finding out this
way.

| | |
| --- | --- |
| PRs merged across four repos, 2026-07-30 | **34** |
| Issues closed | **14** |
| Idea Scout issues left open | **2** — both product decisions already deferred (#49, #50) |
| Paid verification runs | 2 (~$0.52) |

**Cause 2 — my own waste, ~1h45m of the four days.** Three items, all mine:

| | cost | what would have prevented it |
| --- | ---: | --- |
| Built ideation's startup seeding on an unchecked premise | **1h 20m** | `ls db/imports/biffo/` — the working mechanism, three files, same directory |
| Asserted a model slug was dead from a catalogue listing | **~20m** | reading the billing table in the admin surface I already had open |
| Misread a 121s duration as "completed normally" | **~5m** | the run detail says `Turn 2 exceeded the run's remaining wall clock` |

Both causes share one shape, and it is the estate's most-recorded finding: **the
evidence was already in the system and nobody was reading it.** The billing table,
the duration-versus-limit margin, the workflow's own `action_config` — all present,
all queryable, none surfaced.

**What actually shortened day four.** The first thing that worked was driving the
deployed product as a founder and an admin, in a browser, and reading the
transcript of what the model was *actually sent*. That single artefact —
`definition_snapshot.instructions` — settled in one query what three merged
milestones had asserted incorrectly. It should have been the first move on day one,
not the last on day four.

### Measured: two features shipped, and the machine took a third of it (2026-07-31)

**360 agent-minutes: delivery 265 · platform 30 · toil 65.** Two Idea Scout
features reached dev and were verified live (a business-model picker; collapsing
the run form's seven mount-time requests into three), plus the corpus spike that
produced the taxonomy. The 65 minutes of toil is the interesting number, because
**none of it was caused by the change being wrong**.

- **~45m — five CI jobs killed by spot reclamation, across two PRs, three
  re-runs.** Structural, not unlucky: the fleet is spot-only with `lowest-price`
  allocation, which had put 17 of 17 recent runners in one pool. No amount of
  care in the PR avoids this; only the allocation strategy does. Each round trip
  is ~6 minutes of waiting plus the re-diagnosis cost of a failure that reports
  `cancelled` and therefore looks like a flaky test.
- **~10m — a commit that never happened.** Recovered by printing exit status and
  counting commits ahead, both of which are already in AGENTS.md and both of
  which are written about the *push* rather than the commit.
- **~15m — three suite hangs from one missing mock key**, each presenting as
  slowness rather than failure.

**The loop worth shortening is the first one**, and it was: one Terraform change
removed the concentration that made a single reclamation fatal. The other two are
symptoms of the same shape — *a failure that does not announce itself as one* —
which is what the visibility class is counting.

Worth separating from the toil: **the 503 that started the incident was real and
its diagnosis was cheap** (~15m to `Throttles > 0, Errors: 0`). What made it
expensive was that the fix required a quota raise nobody had requested for this
account, while a note recorded the *other* account's raise as done.


### Measured: 1h 20m building a hook that never fires, 2026-07-30

The mechanism already existed, in the same directory, seeding the same plugin.

| Cost | Cause | Status |
| --- | ---: | --- |
| **~38 min** building ideation's startup seeding (`ideation#93` → `#96`), an agent build plus review and merge | M3 closed at 06:41Z on the stated guarantee that a startup hook seeds; the next action was to copy that hook to the second plugin, without checking that it fires | **wasted** — the code is correct and never executes |
| **~43 min** chasing the resulting test failure (`ideation#97`, then a bisect to the exact 3-suite combination that reproduces it) | The vendored seeding test fails only under `services/api + idea-scout + ideation`. Real, still unexplained, and only reachable because the test exists to cover a hook that should not | **abandoned** — `biffo-platform#128` left open and red rather than forced through |
| **~15 min** proving lifespan does not reach a mounted sub-app | Diagnosing the right mechanism, wrongly assumed to be the only one | **recovered** — became [#924](https://github.com/keiranholloway/biffo-template/issues/924), and is the reason the ddl-import answer is defensible rather than a guess |
| Yesterday's `idea-scout#68`, unmeasured | The first instance of the same trap; nobody recorded its cost, which is why this entry exists | **superseded** by `biffo-platform#129` |

**The check that would have cost 30 seconds.** `ls db/imports/biffo/` — three of
the five files already seed this plugin. The operator asked *"why are we not
using the inbuilt seeding pattern?"* and the answer was one directory listing
away, at any point in the preceding two hours.

**The premise was checked against the wrong repo.** M3 wrote *"there is no deploy
step to hang seeding on: `biffo-plugin-idea-scout` has only `ci`,
`publish-registry` and `release` workflows — no deploy at all."* Both sentences
are true. The seed does not live in the plugin repo. It lives in the instance,
whose `deploy-app.yml` has invoked `biffo:ddl-import` for this plugin three
times. A premise about where something must run, tested where it does not run.

**This is the fourth dead hook in the estate and the second recorded this month.**
`on_install()` (ADR-0003 §9, never called — recorded in `004`'s own header),
`@app.on_event("startup")` (this), the manual `seed_agent_config.py` (needs an
admin token, invoked by nothing), and `publish-design-tokens.yml`'s decorative
trigger. The generalisation worth carrying: **a documented extension point is not
a mechanism until something is observed calling it.** Grep for a caller before
building on one.

### Measured: pricing four gaps cost less than building one of them, 2026-07-29

The counterpart to the entry below. That one measured a loop that cost three
estate rollouts; this one measures what it cost to **not** build something.

| Cost | Cause | Status |
| --- | ---: | --- |
| **~25 min to price four gaps** — CI durations, pytest timings across 7 repos, a commit-subject audit over 165 commits | H5 required a number per gap before any was built | **paid for itself immediately**: one of the four was worth zero and was declined |
| **2 further template PRs after the build** (#872, #873) and **2 extra estate sync rounds** | `--no-cov` and the `--list` disagreement, both found *during rollout* rather than review | **fixed** — and this is the same loop as the entry below, now one round shorter because the rollout is scripted |
| **~0 min** building `commit-msg` for six sibling repos | Measured 0 violations in 165 commits | **declined** — the cheapest possible outcome, and only available because it was measured first |

**Separate the symptom from the loop.** The two follow-up PRs look like two
mistakes. They are one: *a gate assumption that holds in the template and not
elsewhere*, expressing itself in a new place each time it is distributed. It has
now cost five template PRs across the day. The structural fix already landed
(`ci_has` derives checks from each repo's CI); what remains is that **the first
place any of these is exercised outside `biffo-template` is a live rollout**,
which is why every one of them was found there rather than in review.

The number worth carrying: **pricing the work took ~25 minutes and removed a
build entirely.** Cheaper than the smallest of the three that survived.

### Measured: verifying in one environment cost three estate rollouts, 2026-07-29

**The loop, not the symptom.** Eight scoreboard rows came out of this session
and they are not eight incidents — they are **one** feedback loop firing
repeatedly: *build in `biffo-template`, verify in `biffo-template`, distribute
to fourteen repos, discover the assumption was template-specific.*

| Cost | Cause | Status |
| --- | ---: | --- |
| **3 full estate rollouts** — 13 repos each, ~39 PRs opened, ~36 merged | The gate was fixed three times *after* distribution (JS discovery, Python discovery, CI-derived checks). Each fix invalidated every copy already shipped | **fixed structurally** — `ci_has` derives every check from the repo's own CI, so the class cannot recur; `shared-sync.sh --check` makes staleness detectable without a rollout |
| **8 template PRs to fix a gate that had already been declared complete** (#853–#862) | "100% armed" was reported as shift-left. Arming was a proxy; the outcome metric did not exist until `gate-coverage.sh` was written | **fixed** — coverage is the headline, arming a prerequisite (#863) |
| **~14 verification runs in the one repo where the bug could not appear** | `biffo-template` is the only repo with both a root `package.json` and a root `pyproject.toml`. Every check — the gate, the parity test, the fail-first proofs — ran there | **structural, not carelessness.** The template is the natural place to build and the worst place to verify. The fix is the rule, now written down: verify where the environment differs most |
| **3 patches of "gate stricter than CI"** before the cause was addressed | A fixed check list tuned against one repo. terraform over `infra/`, bandit over `-r services`, bandit at all in plugin repos | **fixed** ([#861](https://github.com/keiranholloway/biffo-template/pull/861)) |
| **~2 false-alarm investigations** into the drift detector and the sync's push diagnostic | Both instruments reported a cause that was not the cause: "12 repos drifted" (my clones were stale) and "PUSH REFUSED — run the gate" (a non-fast-forward, gate green) | **fixed** (#862 and the sync classifier) — but both cost real minutes reading passing logs |

**Say when the cost was structural.** It was. Nothing here was a slip: the
template genuinely is where the gate belongs, and it genuinely is the layout
that hides root-only bugs. A rollout script that copies files is easy to verify
(*did the file land?*) and that is precisely why the wrong question got asked
fourteen times. **Distribution was treated as a copy problem when it was a
behaviour problem.**

The one number worth carrying: **the first run of the gate in a non-template
layout found the defect in under a minute**, after roughly seven hours of work
built on the assumption it was fine.

### Measured: the CI tax is per-job cold start, not contention, 2026-07-29

Prompted by *"this doesn't feel like a substantially complex change, but it took
5 hours and is still undelivered"* about `0007-lead-activity`. Measured from the
commit, PR and workflow record rather than recalled.

**Elapsed: 8h25m** (12:27→20:52 UTC, 2026-07-28), not 5. Of that, the happy path
— plan through M5 — was **4h34m**. The remaining **3h51m, 46%,** was chasing
three defects, and the feature still was not verified when the session ended.

| Where the time went | |
| --- | --- |
| Blocking CI, PR open→merge | ~208 min across 10 PRs |
| Deploys after merge | 93 min app + 26 min infra |
| Two investigations (#301, #302) | 46 min + 105 min |
| One PR's CI churn (#300) | 103 min for three `pyright` errors, five runs |
| Total workflow runs in the window | **110 runs, 660 min of run wall-clock** |

**The counter-intuitive part, and the reason to record it.** Across 197 jobs:
**727 min queued vs 511 min executing — 59% queue.** The obvious reading is
runner saturation and the obvious fix is more runners. Both are wrong:

- the fleet was **idle 60% of the window** (299 of 505 min with zero jobs running)
- peak concurrency was 10, but it sat at ≤4 for almost all of it
- queue time was **flat across every job type** — 2.9–4.6 min regardless of load

Flat queue under an idle fleet is not contention; it is a **fixed ~3–4 min
cold start per job** on ephemeral runners. Several jobs cost far more to start
than to run: `RLS (real Postgres)` 3.8m queue / 1.2m exec, `Secret Scan` 2.9m /
1.1m, `Tag core version` 3.7m / **0.1m**.

**And trimming still would not help.** A PR run is ~3.5m cold start + ~5.2m for
the longest job ≈ 9m, because the five jobs run in *parallel*. Consolidating them
into one job means one cold start but serialised work: 3.5 + 14.9 ≈ **18m —
worse**. Eliminating cold start entirely takes a PR run 9m→~6m and a deploy
12m→~7m: about **1h10m of the 8h25m, ~14%**, and it is the hardest 14% to fix.

So the pipeline was **not** the thing to attack, despite being the largest single
line item. The ranking that came out of the measurement:

1. **Defect prevention** — 2h31m of pure investigation plus three extra
   round-trips, and two of the three defects die to *logging one real payload
   before writing the consumer*. Biggest bucket, cheapest fix.
2. **The `pyright` round-trip** — 103 min on one PR, fixed by a local gate.
   Root cause turned out to be hooks silently skipped in worktrees, not
   forgetfulness.
3. **Cold start** — ~1h10m, smallest and hardest.

**The general lesson is about the measurement, not the pipeline:** "59% of time
is queue" and "the fleet is saturated" sound like the same statement and are not.
Time-at-concurrency distinguished them in one query, and it inverted the fix.

### Measured: four green PRs shipped a dead feature, 2026-07-29

`0006-pipeline-analytics`, M1→M4, four PRs across two repos. Every one merged
with **full green CI in both repos** — including a Playwright E2E lane — and the
deployed feature **did not work at all**. The first click-through found a 500 on
every page load; the second found the panel rendering as unstyled HTML.

| | |
| --- | --- |
| Build → all four milestones merged | ~4h |
| Click-through and the two fixes it forced | ~50m |
| Defects found by tests + CI (2 repos, 5 lanes) | **0** |
| Defects found by opening the page | **2, both blocking** |

**Both defects share a shape worth naming: they are invisible to any check that
does not render.** A response-shape mismatch lives between two services that
tests replace with a double; a class name lives between a component and a
stylesheet nothing local resolves. Neither is exotic, and no amount of additional
unit testing would have caught either — the styling fix's own tests were green
*before* the fix, because they assert numbers and wording, not paint.

**What it says about where to invest.** The estate treats E2E as the expensive
tier and unit tests as the cheap one. On this evidence the ranking for a
*user-facing* change is inverted: one authenticated page load per feature, after
deploy, would have caught both in under two minutes. The skill already says this
(`biffo-sib-build` step 2.6, "confirm the deployed behavior directly"); it was
not followed per-milestone, and the two defects survived three further merges.

**Not measured, and it matters:** no attempt was made to catch these earlier
cheaply. A test asserting the *real* core response shape (a recorded fixture
rather than a hand-written fake) and a lint rule for unresolvable class names
would both be cheap; neither was tried, so "only a click-through could have found
these" is asserted, not demonstrated.

### Measured: five green milestones, four defects, one browser, 2026-07-29

`0008-outreach-cadences` — five milestones, ~4,500 lines across two repos, every
PR green, **1,600 backend and 181 frontend tests passing throughout**. The
feature could not create a cadence step.

| Found by | Defects |
| --- | --- |
| Unit tests, during the build | 3 (tenant-id conflation, orphaned definitions, and an unbuildable plan step caught by reading) |
| **The browser, after every milestone merged** | **4** |

The four the suites could not see, and why:

| Defect | Why no test could reach it |
| --- | --- |
| step `brand_id` missing | every test built the **object**; a constructor forces the field |
| step `from` missing | failure lives **past EventBridge**, not in the compile |
| UI never called the new route | a PR **claimed** it did; nothing asserts a claim |
| RLS blocked its own write | logic tested on **SQLite, which has no policies** |

**The cost was not the fixes — it was the round trips.** Each defect needed
fix → gate → PR → merge-race → deploy → re-test, and the deploy queue alone runs
**7–13 minutes** on this fleet. Four of those is roughly **2 hours of wall clock
for maybe 40 minutes of edits.** The loop, not the bugs.

**Two of the four are the same structural gap**, and it is worth naming once
rather than four times: *the tests mock the boundary the defect lives on.* An
object test cannot see an HTTP body; a SQLite test cannot see a policy. Both
suites were not weak — they were **pointed slightly to the left of the thing
that breaks.**

**One was not a defect at all but a false claim.** tabsii-platform#323's
description asserted the CRM called the new endpoint. Nothing checks a PR body
against the code, and the issue it "closed" stayed broken for an hour. The only
reason it surfaced is that the E2E's next step depended on it, so the claim got
tested by accident.

### Measured: the same finding again, one milestone later — six defects, 2026-07-30

`0005-agreement-e-signature` (M1–M5 + M7), and this is deliberately filed
**next to** the `0008` row above rather than instead of it: two features, two
weeks apart, same shape. That makes it a trend, not an anecdote.

| Found by | Defects |
| --- | --- |
| Unit + real-Postgres suites, during the build | several, including a TOCTOU race |
| **Driving the deployed feature by hand** | **6** |

All six passed CI at the moment they shipped. **1,730 SQLite and 189 Postgres
tests were green on the commit that returned 200 while writing nothing to the
database.**

| Defect | Why no test could reach it |
| --- | --- |
| IAM lacked the S3 prefix | presigning **never contacts S3**; every test stubs the client |
| base URL unwired → blank link in a real email | a **blank string is a valid substitution**; nothing failed |
| `media_assets` read on the RLS session | both lanes wire *one* engine to both sessions |
| `audit_logs` written on the RLS session | same — and the pg lane's engine has **BYPASSRLS** |
| stuck state unrecoverable | the docstring **claimed** the recovery path existed |
| mid-request commit discarded the RLS binding | SQLite **has no policies**; a refused UPDATE is silent |

**Three of the six are one condition** — *this table's RLS makes the row
invisible on the session this endpoint uses, and an invisible row is
indistinguishable from an absent one.* Recorded once in `evidence.jsonl` for
that reason. It is now the single most repeated failure in this codebase and it
has no guard at all.

**The new information, which `0008` did not surface.** One defect survived a
click-through that had already passed. The first dev countersign persisted
correctly; the second did not. The difference was that the first took a
**resume** path which skips the mid-request commit, so the very verification
that is supposed to be the backstop reported success on a broken endpoint —
because it happened to take the one branch where the bug is absent.

> A click-through proves the path you clicked. It is not a proof about the
> endpoint, and where two paths differ it can actively mislead. The second run
> only happened because a *fix* to something else needed re-testing.

**Cost.** Six defects × (fix → gates → PR → CI → merge → deploy → re-verify).
Deploys ran 7–13 minutes, CI ~2.5, and four PRs additionally needed a rebase
because `dev` took a merge while their checks ran. Call it **~4 hours of round
trips for well under an hour of edits** — the same ratio `0008` measured, at
1.5× the volume. **The loop is the cost, and it has not moved.**

**What actually changed the odds** was not more tests but two guards that assert
a *relationship* rather than a behaviour: `test_evidence_bucket_prefixes.py`
(the prefixes the code builds ⊆ the prefixes the IAM policy grants) and
`test_public_link_settings.py` (every `*_base_url` setting is named in the dev
Terraform). Both were written *because of* a defect above, and **both caught a
real second instance within the same session** — the prefix guard blocked M5
until its grant was added; the settings guard's drift check immediately flagged
`database_url`, which ends in the literal string `base_url`. Guards over
relationships find the class; tests over behaviour find the instance.
### Measured: five milestones, three scoped defects, and the review that caught them, 2026-07-29

`0004-fdd-disclosure` — five milestones across three repos (schema + Object-Lock
evidence store, publish, send, candidate acknowledgement, CRM surface), every PR
green, ~1,600 backend tests passing throughout.

**Three of the defects found were invisible to every test in the stack**, and all
three share one shape: *they only appear for a particular caller, timezone or
scope.*

| Defect | Who it broke for | Why no suite saw it |
| --- | --- | --- |
| `media_assets` NULL-brand policy | **only brand-scoped roles** (Brand HQ) | SQLite runs no RLS; an HQ Admin passes |
| cross-brand version list | **only tenant-wide callers** (HQ Admin) | router test pins the *path*; E2E fixture *does* filter |
| date-only parsed as datetime | **only west of UTC** | CI and dev both run UTC |

None was found by a gate. All three were found by **reading the diff and the
code it depends on** — the NULL-brand one by reading `fn_authorized`'s branch
structure after a subagent's plausible-sounding justification, the list one by
reading `make_list_handler` rather than trusting that `?brand_id=` did something,
the date one by a subagent flagging a type difference it had noticed but not been
asked about.

**The review, not the suite, was the control.** That is worth stating plainly
because it is the opposite of the usual lesson: more tests would not have caught
any of these, since each suite was pointed at a boundary the defect sits behind.

**Where the wall clock actually went**, and it was not the fixes:

| Loop | Cost | Structural? |
| --- | --- | --- |
| `BEHIND` → `update-branch` → full CI re-run | **4 occurrences**, ~6–10 min each | **Yes** — concurrent work merges into `dev` faster than a CI cycle completes; auto-merge does *not* update a stale branch |
| Deploy queue (scale-to-zero cold start) | **7–20 min per deploy**, ~6 deploys | Yes — fleet is correct, latency is inherent |
| Polling the deployed endpoint to detect a landed deploy | ~17 probes across 13 min | **Yes** — no deploy-completion signal exists (#903) |

**Auto-merge is armed and still loses the race — an eighth data point.** Arming
`--auto` removed the *merge* race but not the *staleness* race: `--auto` will not
run `update-branch`, so every time concurrent work landed first the PR sat
`BEHIND` until something noticed. The eventual working pattern was a poll loop
that re-runs `update-branch` itself. That is a workaround for a missing setting,
not a fix.

**Verification cost roughly an hour and found two more defects** — the
double-encoded proxy error and the write-only audit trail — neither of which any
amount of additional unit testing would have surfaced, because both are about
what a *human sees* rather than what the code returns.

### The self-estimate was 45% low, and the cause was the unit

The session was logged at **180 minutes**. The operator corrected it to 5–6
hours; reconstructing from the log put it at **330**.

The gap was not a bad guess about duration. It was **logging the task instead of
the session**: the entry covered the build (`0007`) and silently omitted four
earlier units of work that had already completed — two implementation plans, a
three-requirement assessment against the deployed system, and a third plan. Each
had its own PR and CI wait. Adding them retrospectively accounts for the missing
150 minutes almost exactly.

§8 says "one entry per unit of work", and that is precisely what went wrong: the
last unit felt like *the* unit, because it was the one still in working memory
when the log was written. An agent's sense of elapsed time is reconstructed from
what it can still see, and completed work at the start of a long session is
exactly what it can no longer see.

**Two consequences worth acting on.** First, the bias is *directional* — always
low, never high — so effort figures produced this way understate capacity spent
and would make the inferred dashboard split look better-calibrated than it is.
That is the specific failure this measurement exists to catch, and it caught
itself only because someone said "that was more like five hours". Second, the
fix is mechanical rather than exhortative: log each unit **when it completes**,
not the session when it ends. Every one of the four missing entries was
loggable at the moment its PR merged.

### Measured: three background agents, the same idle-loop, and a hand-rolled monitor that replaced them (2026-07-30)

Three subagents batch-working tabsii-platform/tabsii-crm/tabsii-runners issues in parallel each independently fell into the same pattern: end the turn saying "I'll wait for CI / the monitor to report", rather than polling. Nothing wakes a stopped subagent except a message from the orchestrating session — there is no such thing as "a monitor that reports to itself" — so each one **stayed stopped** until manually resumed, sometimes producing an *identical* "still waiting" report on the very next resume.

Measured: at least 5 redirect cycles across two agents (platform, crm) before the orchestrating session gave up nudging and took over the remaining merges directly with its own polling loop. Each redirect cost a full subagent turn — 250k–400k tokens per the usage figures reported — for zero new work. The fix that actually worked was not a better instruction (explicit "poll with sleep, don't end your turn" was given and still didn't stick on the third occurrence) but **removing the dependency on the agent to babysit CI entirely** — the orchestrating session polled and merged the remaining PRs itself.

**Structural, not a one-off**: identical shape in two independently-briefed agents in the same session, on the third distinct occurrence for one of them despite an explicit correction after the first two. A subagent has no mechanism to resume itself on an external event; treat "wait for X" as an instruction it structurally cannot follow, not one it forgot.

### Measured: a merged, CI-green PR sat 21 hours undeployed, discovered only by clicking through (2026-07-31)

tabsii-platform#399 merged with every check green. Its own `Deploy Application`
run failed at the "Package and deploy Lambda" step (runner killed mid-job) and
nothing re-deployed `dev` afterward — the next commit's CI hit the identical
runner-kill shape, so nobody was watching either run. The gap sat for ~21 hours
until a live click-through against the real feature hit a 404.

**~25 minutes once suspected, not counting the 21-hour wait nobody was
watching**: confirm the browser 404 → check network requests (only the CORS
preflight was visible, not the real GET) → check CloudWatch logs for both the
sibling and core Lambdas (no errors, meaning the request never reached the
missing route) → unzip the deployed core Lambda and grep for the module (absent
— the actual cause) → `gh run list --branch dev` to find the failed deploy run
→ rerun the next commit's CI to rule out a real regression → `gh workflow run
"Deploy Application" --ref dev -f environment=dev` → wait for the redeploy →
re-unzip to confirm the module landed → re-verify in the browser.

**Structural, not a one-off**: this is the second occurrence of the exact gap
[#903](https://github.com/keiranholloway/biffo-template/issues/903) already
named — "no signal anywhere that a deploy for a given commit has actually
landed" — filed as [#973](https://github.com/keiranholloway/biffo-template/issues/973).
Recovering it required knowing to unzip the deployed artifact rather than
trusting the green PR; without that specific habit this would have read as "the
feature has a bug" and sent the search into the application code instead.

### What this is not

It is not an argument for skipping hops. The ownership boundary, the guard, and
the PR-per-instance exist because manual copy-ins let instances drift silently
(#243, #325, #559) — the failure they prevent is worse and harder to see. The
argument is for making each hop **fast to verify and honest about its result**,
not for removing it.

## What went well — practices that earned their keep

**Diffing the resolved file against what the PR actually contained caught two
silent corruptions that every gate passed.** Landing #907 and #905, my first
conflict resolution was wrong both times and in opposite directions — 88 spurious
corpus rows one way, 12 deleted prose entries the other. `verify passed` on both.
The check that caught them was not a gate: it was asking *what did this PR set
out to add, and is it all present?* — `git diff origin/dev...<branch>` for the
distinctive strings, then grepping the resolved file for each. Cheap, and the
only thing standing between those two PRs and a silently corrupted corpus.

**The detector was proven to fire before its silence was trusted.** The
prose-presence check printed `*** MISSING` for all twelve entries on the first
run, which is what established that an empty result on the second run meant
something. Had the order been reversed — correct resolution first — an empty
result would have been indistinguishable from a broken grep. That is §8's
"confirm the search works before trusting an empty result", and here it held by
accident of ordering rather than by design.

**The estate rollout verified behaviour, not file placement.** `shared-sync`
rehearsed each of the 12 satellites by running *that repo's own gate* before
pushing anything — 8/8 CI checks covered in the deployable siblings, and a
correct `NO-CI` verdict in the three without a pipeline. Then `--check`
re-read every repo afterwards and reported `13 current, 0 drifted`. Twelve merged
PRs would not have proved either half.


**Three guards caught real defects in one session, and they share one property.**
The `verify-parity` test **refused** a `kind: 'slow'` exclusion because its
assertion is that the justification contains a *measurement* — I had not timed
the check, so the excuse failed; measuring gave 0.19s and a rewritten, honest
reason. `shared-files-parity` caught that editing `scripts/verify.sh` left both
skeletons carrying stale copies, which would have made every newly scaffolded
repo born drifted. The practices tally guard caught that appending corpus rows
leaves the generated blocks stale, **and its failure message named the exact
remedy command**. The property the day's four fail-opens all lacked: each of
these asserts on a *measurement* or a *derived value*, never on the presence of
text.

**Reverting the implementation and keeping the test found the difference between
a guard and a decoration, four times.** Breaking domain discovery failed exactly
the two registration tests while the negative control stayed green; moving one
line in `main.py` failed exactly the ordering test; reverting three routers gave
`10 failed, 7 passed` with the seven being the ones that *should* still pass; and
reverting `verify.sh` failed only the new banner test. In each case the split was
the evidence — a suite where everything fails proves only that something changed.


**§1 "establish current state" stopped two milestones being built twice.**
`biffo-template#713` and `#912` both read as work to do. Checking first showed
#713's defect had been *retracted by its own author in the comments* — the body
still described it, and implementing it would have reverted a merged fix and 401'd
every admin — and #912 had been **built, merged and deployed the previous
evening**, documented in a comment nobody had read. Two issues closed with
evidence instead of two features rebuilt. The cost of checking was minutes; a
sibling agent sent at #713 refused it on the same grounds independently.

**§3 "prove the test fails without the fix" caught two of my OWN vacuous tests
in one session.** Both looked correct and both proved nothing. (1) A test
asserting a franchisor row is unreachable by token used tokens that matched
nothing regardless — it passed with the security filter deleted. Its replacement
then silently matched zero rows, because SQLAlchemy stores UUIDs on SQLite as
dashless hex and the fixture bound `str(uuid)`; it passed again, still proving
nothing. (2) A mutation intended to verify an audit-session fix landed on the
*first* `audit_logs` block in the file, which belongs to a different milestone,
so the suite stayed green and the check appeared to fail. Three attempts to
prove one behaviour, two of them false positives. **A test you have not watched
fail for the right reason is not evidence, and the failure mode is not "the test
is missing" but "the test is present and green and vacuous."**

**§6 "distrust a green check when the gate can fail open" applied to a gate I had
written that morning.** `test_evidence_bucket_prefixes.py` was added to catch a
code↔IAM mismatch. One milestone later the same class of mismatch walked past it,
because its drift scan filtered on the two line spellings its author had in front
of them. It was found only by adding a prefix and noticing the guard did *not*
complain when it should have. **Ask of a new guard: what would it look like if
this were blind? Then create that condition on purpose.**

**Checking the CI annotation instead of assuming flakiness, twice.** Two Python
checks failed on the self-hosted fleet. Both were genuinely the runner
("lost communication with the server"), but that was established from
`gh api .../check-runs/<id>/annotations` — the job log is already a 404, since
self-hosted logs are not retained. The value is not the two minutes; it is that
after the second one, "just re-run it" starts to feel like knowledge rather than
a guess. It is not, and the third one is where that costs something.

> **It cost something on the fourth (2026-07-30), exactly as predicted — and the
> thing it cost was a wrong hypothesis, filed.** By occurrence three
> (tabsii-platform#393) the pattern felt understood, and the issue was written
> asserting a cause: *"both affected jobs are among the longer-running ones,
> which points at the runner being reclaimed or starved mid-job."* Occurrence
> four was `terraform fmt`/`validate` on a PR whose entire diff was **one
> markdown file** — the cheapest job in the estate. Duration cannot explain it,
> so the filed cause was wrong, and it had been sitting in the issue as the
> starting point for whoever picked it up. Four occurrences now span four
> different workflows and both trivial and heavy jobs, which points at
> fleet-level instability (spot reclamation, agent process death) instead.
> **The annotation check kept working; what failed was the theory built on top of
> a sample of two.** Re-reading the annotation each time is cheap and was done —
> generalising from it was the error, and a hypothesis written into an issue
> gets quoted back as fact long after the sample that produced it has grown.
> Corrected in the issue rather than left standing.

**§2 "verify in the environment that differs most" was the only thing that worked.**
Four independently-sufficient defects sat between an admin edit and a run, and no
gate in the estate could see any of them — a CDN routing gap needs a browser, an
absolute route path needs a *mounted* app rather than a `TestClient`, mount-order
shadowing needs a built `dist` a source checkout lacks, and a run form needs a real
founder session. Driving the deployed product and **reading the transcript of what
the model was actually sent** (`definition_snapshot.instructions`) settled in one
query what three merged, green milestones had asserted wrongly.

**§6 "suspect the ruler" caught a phantom, one hour after failing to.** A cron
worktree reported 9 unpushed commits; checking the instrument showed its upstream
pointed at the wrong branch and nothing was unpushed. That is the discipline
working. It is recorded here beside its own counter-example — the same session
asserted a model slug was dead from a catalogue listing while the estate's billing
table showed 26 billed runs on it — because the two together are the lesson:
**the rule is easy to apply to someone else's number and hard to apply to your
own conclusion.**

**A pre-push gate refusing eight pushes was correct, and the temptation was real.**
Eight fresh worktrees had no dependencies installed, so the gate could not run its
checks and refused. For a `.gitignore`-only change the refusal looks absurd, and
`BIFFO_SKIP_VERIFY=1` was one keystroke away — the escape hatch H4 pre-registered
as the counter-metric that would refute itself. Installing deps in eight worktrees
was the slower, correct answer.


**Mutation testing became the acceptance gate, not an occasional check.** Five
guards in this build were verified by breaking the code and watching the test
fail: the `web_capable` rejection (fails two tests, service and route), the
`:online` suffix on the research default, the `model: null` case, the mean-cost
denominator, and the sidebar's pending state. Every one of them passed on
report before being mutated. The cost is under a minute each and it is the only
evidence that separates a test that defends something from a test that runs.

**Reading the diff rather than the report, four times on one milestone.** Every
defect in the admin-tabs work — a promote button that would have written
placeholder text into the database as a working prompt, a fabricated model
missing `:online`, a constant duplicated across two languages, a new endpoint
with no tests — came from reading the change. The subagent's reports were
accurate about what they claimed; they simply did not claim the thing that was
wrong.

**Retracting an accusation as fast as making it.** I read `chosen_model =
research_model` as assigning a row UUID where a model slug belonged and had
most of a bug report written before following it one function further, where
`_resolve_agent` resolves id → slug correctly. Told the subagent explicitly it
was a retraction so it did not go looking for a defect that was not there — a
wrong review comment costs a round trip exactly like a wrong fix does.

**Deliberately seeding a negative case to test the filter rather than the
render.** Verifying the founder picker, I seeded three models — two web-capable
and one not — instead of three good ones. The render would have looked identical
either way; only the negative case proves the filter exists. It is the same
habit as adding an absent control to a probe, applied to data rather than to a
request.

**Computing the migration chain head instead of reading the newest file.** A
wrong `down_revision` splits an Alembic chain, and the newest file by timestamp
is not reliably the head. Parsing every revision and asserting exactly one head
before and after took one script and removed the guess entirely.

**Reading the code a subagent's justification rests on, rather than the
justification.** A build agent put an insert on the RLS session, reasoning that
`media_assets` has a real INSERT policy and bypassing it would be lazy —
plausible, well-argued, and wrong. Reading `fn_authorized`'s actual branch
structure showed the policy passes a NULL brand and so can only ever match a
tenant-wide assignment; the endpoint would have 403'd for every Brand HQ user
while working for an HQ Admin. The tell was that the argument was about a
*principle* (don't bypass RLS) rather than about *this policy's call shape*.

**Seeding a fixture so the wrong implementation cannot pass it.** The plan
required proof that the cooling-off date derives from `acknowledged_at` rather
than `delivered_at`. A fixture where those dates coincide passes either way and
proves nothing, so they were seeded **30 days apart**: re-deriving from the wrong
column fails with `assert '2026-01-15' == '2026-02-14'`. Same discipline caught
the cross-brand list — two brands in one tenant, so a missing predicate returns 3
rows where 2 are expected.

**Comparing a 404's *message*, not its status, to tell "route absent" from
"handler ran".** After a milestone merged and its Terraform applied, the endpoint
still returned 404. Status code, API Gateway route listing and workflow
conclusions all looked correct. Probing a *pre-existing* public route returned
its handler's own message while the new one returned FastAPI's default
`"Not Found"` — proving the Lambda was serving pre-merge code, in one comparison,
with no redeploy guesswork.

**Attempting the destructive operation to prove the guarantee.** The whole
feature rests on evidence being undeletable. Every layer above it was green and
the object could still have been perfectly deletable, so the delete was actually
attempted: `AccessDenied … object protected by object lock`. An overwrite was
attempted too — it created a new version while the locked original survived
intact. Neither is inferable from Terraform or from a `head-object` field.

**Creating a scoped test user rather than verifying as an admin.** The
convenient path was to click through as the already-signed-in platform admin.
That account bypasses exactly the check that had been broken. A brand-scoped
Brand HQ user was provisioned instead — and the publish that succeeded for it is
the *only* evidence that the fix works, since an admin would have passed either
way.

**Verifying an issue's claims before building from them — three of five were
stale or wrong.** #643 listed five families of instance forks. Checked against
today's code rather than the issue text: family 5's "make the role name a
variable" **already was one, added before the issue was filed**, and its second
half is impossible (HCL resource labels are not interpolatable). Family 2's
"plain backport" framing was wrong — the real gap is a 5-line discovery walk.
One file listed as forked is **byte-identical**. Building family 5 as written
would have produced a variable that already existed plus a change HCL cannot
express.
**Deviating from a proposed fix on security grounds, with a test that proves the
difference.** #889 specified short-circuiting on `permission_code` and
returning. That would leave a declared `required_role` **silently ignored** —
the exact failure `extra="forbid"` prevents, two lines up in the same file. The
axes are now AND, and `test_both_axes_must_hold_rather_than_the_code_winning`
fails under the proposed shape. The same issue said to add the branch "after the
`is_platform_admin` short-circuit"; there isn't one in either guard, and an
admin bypass was not invented to match the text.
**Two exhaustive assertions caught a new field on the authorization surface.**
`test_full_block_round_trips_through_json` and `TestSerialize::test_serialize_shape`
both compare the serialised permission block **completely**, and both failed the
moment `permission_code` appeared. They were updated with a note explaining why
they are exhaustive — deliberately **not** loosened to a subset check, which
would have deleted the guard that had just done its job.
**Measuring before acting on a request.** Asked to close open PRs because they
"keep recalculating", the measurement said otherwise: three of six consumed
**zero** runs — a PR does not re-run unless something pushes to it. The real
compute went to 957 workflow runs driven by merge volume. Closing them would
have saved nothing and the actual driver would have gone unnamed.
**Reconciling an aggregate against the rows it aggregates, in production.** The
cost summary could have been "green tests, looks right" — instead the
`claude-opus-4-8` row was checked arithmetically against live data: mean
$0.1549 is $3.5637 ÷ **23 priced runs**, not ÷ 25 ($0.1425). That is the one row
with unpriced runs, so it is the only one that could distinguish the two
denominators, and getting it backwards would make a model look *cheaper the more
of its runs failed to record a cost* — precisely inverted for the comparison the
feature exists to support.
**Mutation-testing two guards rather than trusting a subagent's report.** The
`model: null` case (reverting it fails with `assert '' is None`) and the
mean-cost denominator (changing it to `cost.runs` fails). Both passed on report;
only the mutation proves they defend anything.
**A subagent deviated from my brief and was right to.** I told it to subclass
`BiffoBaseSchema` like the neighbouring schema; that base carries
`id`/`tenant_id`/`created_at`/`updated_at`, which a per-model aggregate row has
none of. It used plain `BaseModel` and flagged the deviation. The brief was
wrong and the report said so — which only works because the prompt asked for
deviations to be surfaced rather than absorbed.
**Fixing the skill the moment its assumption was proven false.** `Step 3.6` of
`build-plugin-feature` asserted this session has no browser and should print a
URL and stop. It has one. The step now says to do the click-through, records why
the old wording was wrong, and generalises it: *a deferred capability is
indistinguishable from an absent one when you are reasoning about what is
possible.*

**Reverting on evidence instead of tuning toward a hope.** The pitch change was
a reasonable idea, cheaply built, and the measurement said it was worse on both
metrics it targeted. The tempting move is one more prompt tweak — that path is
unbounded and the measured direction was negative. Reverting cost one PR and one
resync and put the feature back to "does very little" rather than "suppresses
output", which is strictly better while the real answer is designed.

**Re-running the same measurement rather than a new one.** Because the first
comparison had already been done the same way, the second was directly
comparable: same founder, same build type, same complexity, same counting
method. A different or "improved" measurement the second time would have made
the two runs incomparable and the regression arguable.


**Pricing four gaps before building any of them, and declining one.** H5's
capture named four residual gaps. Rather than building all four, each was
measured first — and `commit-msg` in siblings turned out to be worth **nothing**:
**0 non-conventional subjects in 165 commits** across six repos with no hook at
all. Building it would have looked like diligence. The register now says that
**declining a fix is a result**, with the number and a re-open trigger, so the
next person to notice the gap does not re-propose it and throw the measurement
away.

The same exercise made `pytest` the obvious first build rather than the last:
**2.5s per push against a 14 min CI round trip is break-even at one catch per
336 pushes**, against an observed rate of roughly one per 165. That is a decision
someone can disagree with, which is the point of writing it as arithmetic.

**Pre-registering the way a fix would most likely be made meaningless, then
building against it.** H5 said in advance that gap 1's version stamp was the
likeliest thing to render useless — *"generate it from the receiving repo rather
than the template and it will always match, reporting perfect health forever"*.
That is exactly the shape of every instrument defect found earlier the same day.
So the stamp reads `$TEMPLATE_ROOT`, never the receiving worktree, and there is a
test asserting the git call targets the template and not `$wt`. **Naming the
failure mode in advance turned it from a thing to notice into a thing to test.**

**Checking the instrument before believing its output — twice, and both were the
instrument.** A conventional-commit audit reported 12% violations in
`tabsii-platform`; the regex rejected `feat(db,api):`, and commas are legal in a
scope. `biffo.sh check release-subject` printed `No base ref` and read like a
fail-open until its exit code was checked: it exits **2**, loudly. Both would
have become scoreboard rows asserting defects that do not exist. The habit that
caught them is cheap: **when a measurement surprises you, suspect the ruler
first.**

**Reading the historical data before trusting the new result.** The plan was two
fresh runs. Looking first at three pre-existing runs with the same inputs showed
that repetition was *thematic and never verbatim* — which reframed the whole
test, because it meant exact-string dedup could not possibly have worked, and it
made the post-fix run interpretable instead of just "different words again".
The control existed in the product already and cost nothing but the looking.

**The shape of the failure identified where the defect is.** Not one title
repeated verbatim after the fix, which is the signature of a model that received
the list and satisfied it lexically — precisely what the prompt forbade. That
distinguishes "the data never arrived" from "the data arrived and was gamed",
and those have completely different fixes. A bare "still repeats" verdict would
have sent the next session to debug the plumbing, which is fine.


**Adding a missing symbol on its own, so the tests failed for the right
reason.** Four tests referencing a not-yet-existing constant failed with
`ImportError`, which demonstrates nothing about behaviour — a test can fail that
way against a correct implementation. Committing only the constant first turned
three of them into `KeyError: 'previously_suggested'`, which is the actual
absence being guarded. "Watch it fail" is not enough on its own; it has to fail
*at the assertion*, and a missing import never gets there.

**Mutation-testing two guards rather than trusting them.** The omission test
("no key when there is no history") would pass against an implementation that
always writes the key — the same trap caught in review earlier. Mutating the
code to always write it made the test fail, which is the only evidence that it
guards anything. Same for the prompt/payload guard: renaming the key in one
place and not the other must fail, and does.


**The scoreboard produced a fix, and it is measurable.** Yesterday I recorded
that a plugin repo's pre-push gate printed `javascript n/a - no package.json in
this repo` and passed a 100%-TypeScript change with no JS verification. Within
hours another session read that row and fixed the gate — `scripts/verify.sh`
now enumerates every directory holding a package this repo owns, and its comment
cites the capture by number:

> *"The gate used to check the repo root and nothing else. In the ten repos with
> no root package.json — every plugin, every sibling, both runner repos — it
> printed `javascript n/a` and then `verify passed`, on repos whose entire
> frontend is JS."*

**And it immediately caught the person who reported it.** My next push to that
repo was rejected because I had installed `web/` and not `web-admin/`. Under the
previous gate that push passes green. This corpus mostly records things going
wrong; this is a recorded instance of it working, start to finish, inside a day.

**Going back to correct a severity estimate after seeing the real thing.** The
issue said "self-corrects within a second" and that claim had already done its
job — it was the argument for treating the defect as minor. Measuring 5–8
seconds on the deployed app made the original classification wrong, so the issue
now says so. An estimate that has already been used to make a decision is worth
correcting even after the work is done, because the next person reads the
estimate, not the decision.


**Proving a guard is load-bearing by removing it, three times, before believing
any of them.** `0006`'s three subtlest decisions were each verified by breaking
them rather than by reasoning about them. Rebuilt as `SECURITY INVOKER`, the
history trigger failed with `new row violates row-level security policy` — which
means every stage move on dev would have broken, not merely that a test was
weaker. With the trigger's value comparison stripped, a non-move wrote a spurious
row (`assert 2 == 1`). With the cost index's `coalesce` removed, two
contradictory January figures inserted cleanly (`DID NOT RAISE`). Each is a
defect that would otherwise have shipped silently.

**A test that passed against a deliberately broken query, caught by mutating the
implementation rather than re-reading the test.** `test_time_in_stage_excludes_synthesised_rows`
was green both with and without the exclusion it was named after. The fixture
gave the backfilled lead a synthesised row and *nothing after it*, so it produced
no span either way and the test could never have failed. The fix was a fixture
change — a backfilled lead that later *moves* — and the strengthened version
asserts the **aggregate** as well as the count, because counting alone still
passes if the span is counted but excluded from the average. It was written
deliberately as an exclusion test, by an author who knew the contract, and it
read correctly.

**Checking whether a suspicious local failure was real before acting on it.**
Deleting merged branches was blocked by the pre-push gate reporting eight `tsc`
errors — `Cannot find module 'recharts'`, plus `UnitMap` prop mismatches in two
files I had never touched. The tempting readings were "my change broke something"
and "the gate is noise, skip it". `pnpm install` in the primary checkout made all
eight vanish: every one was stale-dependency noise from a checkout not synced
since the dependency was added. The gate was right to block, and one command
distinguished a regression from an artefact.


**Mutation testing to decide whether a test is real.** A generated test looked
plausible and passed. Changing the component to always render the element it
claimed to check — the exact opposite of correct — left it passing, which
settled in one run what reading it had not. This is now the cheapest available
answer to "does this test actually defend anything?", and it took under a
minute: mutate, run the one test, restore.

**Reviewing a sub-agent's diff rather than its report.** The report was honest —
it volunteered that one test had "no actual rendering issue". The gap was not
candour but judgement about what that implied. Reading the diff turned an
accurate self-assessment into a rejection and a rewrite, which is exactly the
split the build skill describes: cheaper model implements, stronger model
decides whether it holds.

**Planning changed the design, which is the only reason planning was worth
doing.** The issue's own sketch read the title from client state, which is
empty in the window right after a live run completes. Researching before
drafting found that the report endpoint already loaded the session and
discarded it — so the feature became a one-line addition to an existing
response with a single server-side derivation, instead of a second copy of
`_derive_title` on the client.

**Matching a local build's emitted hash to the deployed bundle.** `vite build`
produced `index-BfXg-JPj.js` before anything was pushed; the CDN served exactly
that filename after deploy. Not "the hash changed" but "the deployed artifact is
this source", which is a strictly stronger claim and costs one command.



**Pricing four gaps before building any of them, and declining one.** H5's
capture named four residual gaps. Rather than building all four, each was
measured first — and `commit-msg` in siblings turned out to be worth **nothing**:
**0 non-conventional subjects in 165 commits** across six repos with no hook at
all. Building it would have looked like diligence. The register now says that
**declining a fix is a result**, with the number and a re-open trigger, so the
next person to notice the gap does not re-propose it and throw the measurement
away.

The same exercise made `pytest` the obvious first build rather than the last:
**2.5s per push against a 14 min CI round trip is break-even at one catch per
336 pushes**, against an observed rate of roughly one per 165. That is a decision
someone can disagree with, which is the point of writing it as arithmetic.

**Pre-registering the way a fix would most likely be made meaningless, then
building against it.** H5 said in advance that gap 1's version stamp was the
likeliest thing to render useless — *"generate it from the receiving repo rather
than the template and it will always match, reporting perfect health forever"*.
That is exactly the shape of every instrument defect found earlier the same day.
So the stamp reads `$TEMPLATE_ROOT`, never the receiving worktree, and there is a
test asserting the git call targets the template and not `$wt`. **Naming the
failure mode in advance turned it from a thing to notice into a thing to test.**

**Checking the instrument before believing its output — twice, and both were the
instrument.** A conventional-commit audit reported 12% violations in
`tabsii-platform`; the regex rejected `feat(db,api):`, and commas are legal in a
scope. `biffo.sh check release-subject` printed `No base ref` and read like a
fail-open until its exit code was checked: it exits **2**, loudly. Both would
have become scoreboard rows asserting defects that do not exist. The habit that
caught them is cheap: **when a measurement surprises you, suspect the ruler
first.**

**Reading the historical data before trusting the new result.** The plan was two
fresh runs. Looking first at three pre-existing runs with the same inputs showed
that repetition was *thematic and never verbatim* — which reframed the whole
test, because it meant exact-string dedup could not possibly have worked, and it
made the post-fix run interpretable instead of just "different words again".
The control existed in the product already and cost nothing but the looking.

**The shape of the failure identified where the defect is.** Not one title
repeated verbatim after the fix, which is the signature of a model that received
the list and satisfied it lexically — precisely what the prompt forbade. That
distinguishes "the data never arrived" from "the data arrived and was gamed",
and those have completely different fixes. A bare "still repeats" verdict would
have sent the next session to debug the plumbing, which is fine.


**Adding a missing symbol on its own, so the tests failed for the right
reason.** Four tests referencing a not-yet-existing constant failed with
`ImportError`, which demonstrates nothing about behaviour — a test can fail that
way against a correct implementation. Committing only the constant first turned
three of them into `KeyError: 'previously_suggested'`, which is the actual
absence being guarded. "Watch it fail" is not enough on its own; it has to fail
*at the assertion*, and a missing import never gets there.

**Mutation-testing two guards rather than trusting them.** The omission test
("no key when there is no history") would pass against an implementation that
always writes the key — the same trap caught in review earlier. Mutating the
code to always write it made the test fail, which is the only evidence that it
guards anything. Same for the prompt/payload guard: renaming the key in one
place and not the other must fail, and does.


**The scoreboard produced a fix, and it is measurable.** Yesterday I recorded
that a plugin repo's pre-push gate printed `javascript n/a - no package.json in
this repo` and passed a 100%-TypeScript change with no JS verification. Within
hours another session read that row and fixed the gate — `scripts/verify.sh`
now enumerates every directory holding a package this repo owns, and its comment
cites the capture by number:

> *"The gate used to check the repo root and nothing else. In the ten repos with
> no root package.json — every plugin, every sibling, both runner repos — it
> printed `javascript n/a` and then `verify passed`, on repos whose entire
> frontend is JS."*

**And it immediately caught the person who reported it.** My next push to that
repo was rejected because I had installed `web/` and not `web-admin/`. Under the
previous gate that push passes green. This corpus mostly records things going
wrong; this is a recorded instance of it working, start to finish, inside a day.

**Going back to correct a severity estimate after seeing the real thing.** The
issue said "self-corrects within a second" and that claim had already done its
job — it was the argument for treating the defect as minor. Measuring 5–8
seconds on the deployed app made the original classification wrong, so the issue
now says so. An estimate that has already been used to make a decision is worth
correcting even after the work is done, because the next person reads the
estimate, not the decision.


**Proving a guard is load-bearing by removing it, three times, before believing
any of them.** `0006`'s three subtlest decisions were each verified by breaking
them rather than by reasoning about them. Rebuilt as `SECURITY INVOKER`, the
history trigger failed with `new row violates row-level security policy` — which
means every stage move on dev would have broken, not merely that a test was
weaker. With the trigger's value comparison stripped, a non-move wrote a spurious
row (`assert 2 == 1`). With the cost index's `coalesce` removed, two
contradictory January figures inserted cleanly (`DID NOT RAISE`). Each is a
defect that would otherwise have shipped silently.

**A test that passed against a deliberately broken query, caught by mutating the
implementation rather than re-reading the test.** `test_time_in_stage_excludes_synthesised_rows`
was green both with and without the exclusion it was named after. The fixture
gave the backfilled lead a synthesised row and *nothing after it*, so it produced
no span either way and the test could never have failed. The fix was a fixture
change — a backfilled lead that later *moves* — and the strengthened version
asserts the **aggregate** as well as the count, because counting alone still
passes if the span is counted but excluded from the average. It was written
deliberately as an exclusion test, by an author who knew the contract, and it
read correctly.

**Checking whether a suspicious local failure was real before acting on it.**
Deleting merged branches was blocked by the pre-push gate reporting eight `tsc`
errors — `Cannot find module 'recharts'`, plus `UnitMap` prop mismatches in two
files I had never touched. The tempting readings were "my change broke something"
and "the gate is noise, skip it". `pnpm install` in the primary checkout made all
eight vanish: every one was stale-dependency noise from a checkout not synced
since the dependency was added. The gate was right to block, and one command
distinguished a regression from an artefact.


**Mutation testing to decide whether a test is real.** A generated test looked
plausible and passed. Changing the component to always render the element it
claimed to check — the exact opposite of correct — left it passing, which
settled in one run what reading it had not. This is now the cheapest available
answer to "does this test actually defend anything?", and it took under a
minute: mutate, run the one test, restore.

**Reviewing a sub-agent's diff rather than its report.** The report was honest —
it volunteered that one test had "no actual rendering issue". The gap was not
candour but judgement about what that implied. Reading the diff turned an
accurate self-assessment into a rejection and a rewrite, which is exactly the
split the build skill describes: cheaper model implements, stronger model
decides whether it holds.

**Planning changed the design, which is the only reason planning was worth
doing.** The issue's own sketch read the title from client state, which is
empty in the window right after a live run completes. Researching before
drafting found that the report endpoint already loaded the session and
discarded it — so the feature became a one-line addition to an existing
response with a single server-side derivation, instead of a second copy of
`_derive_title` on the client.

**Matching a local build's emitted hash to the deployed bundle.** `vite build`
produced `index-BfXg-JPj.js` before anything was pushed; the CDN served exactly
that filename after deploy. Not "the hash changed" but "the deployed artifact is
this source", which is a strictly stronger claim and costs one command.


**Building the source locally and matching the emitted hash against the deployed
artifact.** Verifying an admin-panel fix was live, every usual check failed to
discriminate: the bundle is minified so `getFreshIdToken` returned 0 in both old
and new, and fetching the previous asset as a control returned a 403 portal page
because deploys delete it. Building `services/ideation/web-admin` produced
`index-mta7rvZz.js` — the same hash as the bundle inside the deployed Lambda.
That is not "something changed", it is "the deployed artifact is this source".

**Sending a sub-agent to settle a contradiction rather than to fix a bug.** Two
sessions had written mutually exclusive claims: an issue said identity varied by
which tokens were unexpired, a merged commit said the library's Client-ID
scoping made that impossible. Briefing the agent to decide from the library
source rather than either prose produced the right answer — the commit was
correct, the issue's mechanism could not happen, **and the issue's original
title, discarded by two rounds of "correction", was right all along**. A brief
to "fix #69" would have produced a fix for a defect that did not exist.

**Adding a deliberately-absent control to a probe that was already agreeing with
me.** Checking whether a plugin was mounted, three real endpoints returned 401
and I was one step from calling that confirmation. A fourth request, to a plugin
name invented on the spot, also returned 401 — killing the method rather than
the conclusion. The habit worth keeping is not "use controls", it is **run the
control when the evidence is already saying what you hoped**.

**Predicting the artefact hash before deploying, then checking it.** Recorded
`index-YPgvrIdF.js` as the baseline before merging, so "did this reach the CDN?"
had a falsifiable answer rather than a vibe. It became `index-BIhdT7y3.js`, and
the served bundle carried the exact new string.


**Distrust a green check when the gate can fail open — applied to my own work.**
`publish-registry.yml` exits `success` whether it published or skipped, because
I wrote it to warn-and-skip on a missing token. Verifying the newly-set
credential by reading the run *conclusion* would have proved nothing. The check
that means something is the step list.

**`git branch -d` is a proof, not just a delete.** It refuses any branch not
fully contained in the base, so a bulk cleanup that only ever uses `-d` cannot
destroy unlanded work — git checks each one for you. 32 of 34 were accepted;
the two it would have refused were exactly the two carrying real commits. Using
`-D` everywhere would have deleted all 34 and looked identical while running.

**`biffo doctor` closed its own loop the day it shipped.** It quantified the
mess (3 errors, 68 branches, 18 worktrees across the estate), and after the
sweep reported `No findings` on the template and zero errors everywhere. First
time any of these conditions was observed by a tool rather than a human noticing.

**A no-op path cannot be verified by watching it succeed.** `publish-registry`
ran green — eleven steps, all passing — and its write path had never executed,
because the registry entry was always already current. The only way to prove the
token could write was to make the registry *wrong on purpose* and watch it be
corrected. That produced the first bot commit in the mechanism's history.

**Read past the layer, even when the layer is a CDN you trust.**
`raw.githubusercontent.com` still served the pre-correction value while
`gh api .../contents` showed the new one. The automated check said "WRITE NOT
PROVEN"; the truth was the opposite. Believing it would have sent the operator
back to regenerate a credential that was working.

**Running the thing beat testing the thing, twice in one session.** `--org` had
16 green tests and produced repos where no PR could ever merge; `doctor` had 34
green tests and cried wolf on every worktree. Neither was a coverage gap — both
test suites were correct about what they modelled. Both were found in one run
against reality, minutes apart from shipping.

**Verify by the reporter's route, even when the "reporter" is a future user.**
`plugin create --standalone --org` had 16 unit tests, all green, every remote
call behind an injected fake. Running it **once** against a real GitHub account
produced a repo whose every PR would be blocked for ever: no `RUNNER_LABEL`, so
CI died at the billing wall, while the branch protection the same command had
just applied required those six jobs. The fakes were not wrong — they modelled
the API faithfully. They could not model an account that cannot pay for runners.
The PR had said "not verified against the real GitHub API" and that sentence is
what prompted the run.

**A negative control is what separates a test from a decoration.** Both fixes in
this session were checked by reverting the implementation and confirming the new
test failed — the empty-contexts guard, and the set-label-before-push ordering.
The ordering test in particular would have passed against the racy code it was
written to prevent, since the race is usually won.

**Reading the component before writing the test, instead of probing it.** The
onboarding wizard walk was written from `UnitOnboardingWizard.tsx`'s own
declarations — four steps, `Next` on the first three, `Create unit` on the last,
and `canContinue`'s per-step requirements — rather than discovered by trial. The
first run reached the final step. A probe loop would have "worked" too, and would
have absorbed a future flow change silently instead of failing on it.

**§3 on an assertion about a request, not a return value.** The E2E claim "the UI
cannot submit an owner, tenant or alternate brand" was proven by adding
`brand_id: brandId` to the wizard's POST and watching it fail with *the wizard
submitted a brand_id field*. The same property in a component test asserts what a
handler was called with — not what crossed the wire, which is the thing the issue
actually cares about.

**A field-coverage guard, written because this page says one does not exist.**
biffo-template#694 records that nothing asserts every declared event field is
actually emitted. Applied to `user.invited`, that guard fails when a field is
declared and never sent — the case that renders as an empty token in a workflow
template, so the builder offers it, an author uses it, and the email ships with a
blank where the role should be.


**§1, applied to issues, was the highest-return step of the whole pass.** Ten
open tabsii issues; checking each against the code rather than its title found
**four already complete** (#261, #209, #244, #257 — one shipped two days earlier)
and three more materially misdescribed. #244 in particular: migration 0010 had
already been taken by core 0.152.0, verified not from the tree but from the
deploy log (`Running upgrade 0011 -> 0010`, `0010 -> 0012`). Writing code first
would have re-derived work that existed.

**§3 caught a guard that asserted the wrong thing entirely.** `whoami`'s
"the query is scoped by the caller" test checked the *bound parameters* and
passed with the whole `WHERE ura.user_id = :uid` clause deleted — on a BYPASSRLS
session, where that clause is the only scoping there is. Mutation testing turned
a test that named the risk into one that covers it: 3 of 4 mutations now fail,
and the fourth is deliberately left to the Postgres file because a fake session
cannot distinguish an ordered query from an unordered one.

**Guarding the guard, before the assertions that depend on it.** The RLS
enforcement test asserts `current_user`, `rolsuper`, `rolbypassrls` and
`tableowner` before anything else runs. Postgres skips policies for a superuser,
a `BYPASSRLS` role **and** the table's owner — under any of those a table with no
policies behaves identically to a protected one, so the file could have passed
while proving the opposite of its claim. The same reasoning produced the
symmetric case: a one-sided check passes against a policy that denies everything.

**Re-listing open issues after a merge caught an issue closed by a sentence
saying it should not be.** `## This does NOT close #76` closed #76. Nothing
warns, and an issue wrongly closed with a green PR attached reads as legitimately
done. The habit cost seconds and was the only thing between that and a silently
unmet acceptance criterion.

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


**Running the tool in the environment that differs most, instead of the one it
was built in.** Fourteen rollouts of the local gate passed because every check
was run in `biffo-template` — the one repo with both a root `package.json` and a
root `pyproject.toml`, i.e. the only layout where the gate's root-only
assumption held. **The first time it was run in a plugin repo the blind spot
appeared in under a minute.** That is now the rule the whole distribution rests
on: verify where the environment differs, not where you wrote it. The cost of
not doing it was an afternoon of rework; the cost of doing it was one command.

**Reproducing the hook failure with one variable changed, in the same tree.**
The dead-hooks fix could have been asserted. Instead: one fresh worktree, no
install, two configs.

| same worktree, no `pnpm install` | result |
| --- | --- |
| old (`core.hooksPath=.husky/_`) | `git commit -m "this subject is not conventional"` → **succeeded, exit 0** |
| new (shared `.git/hooks`) | **blocked, exit 1**, `Command "lint-staged" not found` |

That is the difference between "the fix looks right" and "the fix changes the
observed behaviour, and nothing else did". It also produced the honest framing
for the PR — the hook now *fires*; its tooling still needs installing. A silent
skip became a loud failure, which is the actual claim.

**Building the metric that could fail, and letting it.** Arming — *will a hook
execute* — reached **100%** while six repos ran **one check in eight**.
`gate-coverage.sh` asks the question that can be answered wrong: for each repo,
what share of *its own* CI's check kinds does its gate run? It reported **45%**
on its first run and named the six worst repos. An unfalsifiable 100% became a
falsifiable 45%, and that is what made the rest of the work targetable.

**Pre-registering H4 before the intervention.** The register's first rule forced
the arming-vs-coverage confusion into writing rather than leaving it as a
retrospective reinterpretation. When the headline turned out to be a proxy, the
correction had to be recorded as an amendment with both numbers — which is
exactly the mechanism working, on its author.

**The gate earned its keep the day it landed**, before any of this was measured:

- caught a `format` failure **in its own PR** (a rebase resolution had
  reformatted `core-manifest.json`);
- caught real `terraform fmt` drift sitting on `dev` in `plugin-host.core.tf`;
- **refused the `biffo-platform` core-upgrade push** with `vitest: not found`,
  because the upgrade had refreshed `pnpm-lock.yaml` and `node_modules` had not
  been reinstalled — AGENTS.md §1's stale-deps case, caught locally on the
  gate's first firing in that repo instead of in CI.

**Two of my own instruments were wrong in the flattering direction, and the
tools caught each other.** `hook-audit.sh` read `$tree/.git/hooks`, which does
not exist in a linked worktree (`.git` is a *file*) — it would have scored the
fix as a failure. `verify.sh --list` reported what the *machine* could run
rather than what the *repo* requires, so the parity test passed locally and
failed on a CI runner with no `uv`. Neither was found by inspection; both were
found by two tools disagreeing. **Build the second instrument.**

**Building the source locally and matching the emitted hash against the deployed
artifact.** Verifying an admin-panel fix was live, every usual check failed to
discriminate: the bundle is minified so `getFreshIdToken` returned 0 in both old
and new, and fetching the previous asset as a control returned a 403 portal page
because deploys delete it. Building `services/ideation/web-admin` produced
`index-mta7rvZz.js` — the same hash as the bundle inside the deployed Lambda.
That is not "something changed", it is "the deployed artifact is this source".

**Sending a sub-agent to settle a contradiction rather than to fix a bug.** Two
sessions had written mutually exclusive claims: an issue said identity varied by
which tokens were unexpired, a merged commit said the library's Client-ID
scoping made that impossible. Briefing the agent to decide from the library
source rather than either prose produced the right answer — the commit was
correct, the issue's mechanism could not happen, **and the issue's original
title, discarded by two rounds of "correction", was right all along**. A brief
to "fix #69" would have produced a fix for a defect that did not exist.

**Adding a deliberately-absent control to a probe that was already agreeing with
me.** Checking whether a plugin was mounted, three real endpoints returned 401
and I was one step from calling that confirmation. A fourth request, to a plugin
name invented on the spot, also returned 401 — killing the method rather than
the conclusion. The habit worth keeping is not "use controls", it is **run the
control when the evidence is already saying what you hoped**.

**Predicting the artefact hash before deploying, then checking it.** Recorded
`index-YPgvrIdF.js` as the baseline before merging, so "did this reach the CDN?"
had a falsifiable answer rather than a vibe. It became `index-BIhdT7y3.js`, and
the served bundle carried the exact new string.


**Distrust a green check when the gate can fail open — applied to my own work.**
`publish-registry.yml` exits `success` whether it published or skipped, because
I wrote it to warn-and-skip on a missing token. Verifying the newly-set
credential by reading the run *conclusion* would have proved nothing. The check
that means something is the step list.

**`git branch -d` is a proof, not just a delete.** It refuses any branch not
fully contained in the base, so a bulk cleanup that only ever uses `-d` cannot
destroy unlanded work — git checks each one for you. 32 of 34 were accepted;
the two it would have refused were exactly the two carrying real commits. Using
`-D` everywhere would have deleted all 34 and looked identical while running.

**`biffo doctor` closed its own loop the day it shipped.** It quantified the
mess (3 errors, 68 branches, 18 worktrees across the estate), and after the
sweep reported `No findings` on the template and zero errors everywhere. First
time any of these conditions was observed by a tool rather than a human noticing.

**A no-op path cannot be verified by watching it succeed.** `publish-registry`
ran green — eleven steps, all passing — and its write path had never executed,
because the registry entry was always already current. The only way to prove the
token could write was to make the registry *wrong on purpose* and watch it be
corrected. That produced the first bot commit in the mechanism's history.

**Read past the layer, even when the layer is a CDN you trust.**
`raw.githubusercontent.com` still served the pre-correction value while
`gh api .../contents` showed the new one. The automated check said "WRITE NOT
PROVEN"; the truth was the opposite. Believing it would have sent the operator
back to regenerate a credential that was working.

**Running the thing beat testing the thing, twice in one session.** `--org` had
16 green tests and produced repos where no PR could ever merge; `doctor` had 34
green tests and cried wolf on every worktree. Neither was a coverage gap — both
test suites were correct about what they modelled. Both were found in one run
against reality, minutes apart from shipping.

**Verify by the reporter's route, even when the "reporter" is a future user.**
`plugin create --standalone --org` had 16 unit tests, all green, every remote
call behind an injected fake. Running it **once** against a real GitHub account
produced a repo whose every PR would be blocked for ever: no `RUNNER_LABEL`, so
CI died at the billing wall, while the branch protection the same command had
just applied required those six jobs. The fakes were not wrong — they modelled
the API faithfully. They could not model an account that cannot pay for runners.
The PR had said "not verified against the real GitHub API" and that sentence is
what prompted the run.

**A negative control is what separates a test from a decoration.** Both fixes in
this session were checked by reverting the implementation and confirming the new
test failed — the empty-contexts guard, and the set-label-before-push ordering.
The ordering test in particular would have passed against the racy code it was
written to prevent, since the race is usually won.

**Reading the component before writing the test, instead of probing it.** The
onboarding wizard walk was written from `UnitOnboardingWizard.tsx`'s own
declarations — four steps, `Next` on the first three, `Create unit` on the last,
and `canContinue`'s per-step requirements — rather than discovered by trial. The
first run reached the final step. A probe loop would have "worked" too, and would
have absorbed a future flow change silently instead of failing on it.

**§3 on an assertion about a request, not a return value.** The E2E claim "the UI
cannot submit an owner, tenant or alternate brand" was proven by adding
`brand_id: brandId` to the wizard's POST and watching it fail with *the wizard
submitted a brand_id field*. The same property in a component test asserts what a
handler was called with — not what crossed the wire, which is the thing the issue
actually cares about.

**A field-coverage guard, written because this page says one does not exist.**
biffo-template#694 records that nothing asserts every declared event field is
actually emitted. Applied to `user.invited`, that guard fails when a field is
declared and never sent — the case that renders as an empty token in a workflow
template, so the builder offers it, an author uses it, and the email ships with a
blank where the role should be.


**§1, applied to issues, was the highest-return step of the whole pass.** Ten
open tabsii issues; checking each against the code rather than its title found
**four already complete** (#261, #209, #244, #257 — one shipped two days earlier)
and three more materially misdescribed. #244 in particular: migration 0010 had
already been taken by core 0.152.0, verified not from the tree but from the
deploy log (`Running upgrade 0011 -> 0010`, `0010 -> 0012`). Writing code first
would have re-derived work that existed.

**§3 caught a guard that asserted the wrong thing entirely.** `whoami`'s
"the query is scoped by the caller" test checked the *bound parameters* and
passed with the whole `WHERE ura.user_id = :uid` clause deleted — on a BYPASSRLS
session, where that clause is the only scoping there is. Mutation testing turned
a test that named the risk into one that covers it: 3 of 4 mutations now fail,
and the fourth is deliberately left to the Postgres file because a fake session
cannot distinguish an ordered query from an unordered one.

**Guarding the guard, before the assertions that depend on it.** The RLS
enforcement test asserts `current_user`, `rolsuper`, `rolbypassrls` and
`tableowner` before anything else runs. Postgres skips policies for a superuser,
a `BYPASSRLS` role **and** the table's owner — under any of those a table with no
policies behaves identically to a protected one, so the file could have passed
while proving the opposite of its claim. The same reasoning produced the
symmetric case: a one-sided check passes against a policy that denies everything.

**Re-listing open issues after a merge caught an issue closed by a sentence
saying it should not be.** `## This does NOT close #76` closed #76. Nothing
warns, and an issue wrongly closed with a green PR attached reads as legitimately
done. The habit cost seconds and was the only thing between that and a silently
unmet acceptance criterion.

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
**The core-ownership guard did exactly what it exists for, on a security fix.** A sub-agent went to patch the SQL-echo exposure in `biffo-platform` and was stopped: `services/api/` is template-owned. The instinct on a security fix is to route around a guard — the guard was right, the patch belonged upstream, and landing it in the instance would have produced a fix that the next `biffo core upgrade` silently reverted while everyone believed it was closed. The agent stopped, posted the full patch on the issue, and said it was blocked rather than improvising.

**Writing the test to observe the leak, not to assert the flag.** The obvious test for "echo is off" reads `engine.echo` — and would pass against a build where the flag no longer controlled anything. The test that earned its place executes a statement carrying a secret and reads what the `sqlalchemy.engine.Engine` logger actually emitted; without the fix it fails with `assert 'founder-pro...never-appear' not in "BEGIN (impl...,)"`, which is the exposure itself, reproduced. It also takes `hide_parameters` from the shipped engine rather than hard-coding `True`, so it cannot pass by testing SQLAlchemy instead of Biffo.

**Distrusting a sub-agent's scoping, not just its facts.** The agent's report was accurate on every claim it made, and its patch was still too narrow — it fixed the engine that was reported. Re-deriving the scope found three more engines, one of which handles `CREATE ROLE … PASSWORD`. Checking a delegated result means checking what it *left out*, which no amount of verifying its assertions would have surfaced.

**Verifying the deployed artifact settled in one minute what traffic could not settle at all.** After the fix deployed, the post-deploy log count was zero — but only 2 invocations had hit the function and neither touched the database, so zero was indistinguishable from "nothing ran". Downloading the live Lambda package and reading `database.py`, `db_app_role.py`, `config.py` and `agent_runs.py` out of it, plus confirming `BIFFO_SQL_ECHO` was unset on the function, gave direct evidence that did not depend on traffic at all. §4 is written for the stale-deploy theory; it turns out to be just as good for *"I cannot generate the conditions to observe this"*.

**A dry run before an irreversible delete caught a wrong count.** The purge script reported `0 kept` for a log group that had 16 streams that had to survive. Running it in dry-run mode first, comparing against an independently-computed number, and refusing to execute until the two agreed is what stood between a correct purge (1,323 deleted, 16 preserved) and deleting live logging. The rule that earned its keep: **if a number a script prints disagrees with a number you measured yourself, stop — do not reconcile it in your head.**

**Re-deriving a delegated result's scope found three more engines.** The sub-agent's patch fixed the engine that was reported. Independently re-scanning found three others in the template, one of which administers `CREATE ROLE … PASSWORD`; the same guard later found two more in tabsii, including a BYPASSRLS engine and a second password path. None of the five were in any report. Verifying the agent's *claims* would never have surfaced them, because every claim it made was true.

**Refusing to read a clean result as a fix.** The live verification of #661 produced exactly what success looks like: one keyed chain, one synthesis run. But **6 of 8 pre-fix chains also produced exactly one run** — the observed double-fire rate is ~25%, so one clean sample is equally consistent with "the fix works" and "the race did not trigger". Checking the base rate before claiming prevention is what stopped this being closed on evidence that proves nothing. The issue stayed open.

**Checking what a file actually served before deleting it.** Removing `admin_ingress` looked like it would take the working admin API with it — `/admin/build-types` and `/admin/chat-agents` live in `admin_app.py`, which only mounts because of that declaration. Reading the handlers showed every one is a thin proxy to Core (`_core_request`), and both capabilities remain at Core's own paths. Had I trusted the first reading, I would either have shipped a capability regression or abandoned the correct fix.

**Predicting a distribution ordering failure instead of discovering it.** A new deploy-time gate plus a stale vendored manifest equals a red instance. Checking both vendored plugins against the new condition — with `ideation` as a deliberate control to prove the gate did not simply reject everything — surfaced the ordering requirement before any deploy ran.

**Reading past the layer, again (§5), on a route nobody had documented.** A relative `fetch('/api/v1/admin/agent-runs')` from the portal origin returned 403 for every one of eight tokens, which reads as "all tokens are dead". The portal in fact calls the **API Gateway host directly**; the relative path went through CloudFront to the portal's S3 origin. One `read_network_requests` call turned eight false negatives into a working request.

**Loading the page is a different test from checking the artifact, and today only the first one worked.** After the deploy I confirmed `services/idea-scout/web-admin/dist/` was present in the Lambda package with real assets — correct, and it proved nothing. The page was blank. Artifact inspection answers *"did it ship?"*; only a browser answers *"does it work?"*. The same pair recurred an hour later: the deployed `app.py` had the request field and the response line, and lacked the one line between them.

**Capturing the request body separated two failures that looked like one.** Intercepting `fetch` to read the actual POST proved the UI half was correct — `{"preferences":["recurring-revenue","regulated-markets"]}` — at the same moment the stored run came back `[]`. Without that, "preferences do not work" would have sent me to the checkbox code first.

**Establishing the state before rebuilding, with a control.** Before building an admin UI I checked three places for an existing one and used `ideation` as a control to prove the check could find one. Without the control, "not found" is indistinguishable from "looked wrong" — and the user had explicitly challenged the claim.

**Reading the run back through the API rather than trusting the UI.** The Past Scouts list showed the run happily; only `GET /runs` showed `preferences: []`. A green-looking UI over a dropped field is exactly the shape #26 warned about.
**Verify the deployed artifact, not the source.** The reported symptom ("admin
panel still empty despite issues being raised") had two plausible causes: a data
problem, or an undeployed fix. Downloading the `biffo-platform-dev-plugin-host`
Lambda and grepping its `admin_app.py` for `effective` returned **zero hits**,
settling it in one step — the deployed code predated the fix. Without that, the
obvious next move was debugging an empty database that was working correctly.

**Compare the two copies rather than asserting the drift.** The dead `chat_agents`
manifest block looked like a drift defect and was written up as one. Diffing it
against the live `CHALLENGER_INSTRUCTIONS` showed the two were **byte-identical**,
so the PR claims a *latent* risk, not a realised divergence. The weaker, true
claim is the one that survives review; the stronger one would have been caught
and would have cost the reviewer's trust in the rest of the write-up.


**Bisect with the surface you just built.** A lead's activity timeline was empty
after a send that had demonstrably succeeded. Rather than reason about the
observer, the *manual* "Log activity" control on the same drawer was used — it
wrote and rendered correctly, which in one click eliminated the table, RLS, the
permission backfill, both proxy routes, the join and the refetch, and isolated
the fault to the observer alone. Two adjacent write paths into one table make an
excellent bisector, and it was free.

**Run the local Postgres lane instead of pushing to find out.** Three defects
were caught before CI: a seed colliding with `uq_pipeline_stages_brand_sequence`
(brands are *born* with default stages), `tenant_id` taken from the run — ADR-0001's
seam string — where `tabsii.*` needs a real UUID FK, and a `performed_at` mapped
without a `server_default` sending explicit NULL into a NOT NULL column. Each
would have been a red run at ~6 min plus queue; together they would have been
three separate round trips.

**Predicting the artefact hash before the deploy, then matching against it.** Twice this session I built the vendored source first, stated the expected bundle name in the PR (`index-D76LRuF_.js`, `index-DLF7vZoc.js`), and checked afterwards. That converts "something changed" — which is all a hash diff proves — into a match against a stated expectation. It also forced the second, better check: **fetching the served bundle and grepping it for the new copy**, with the old bundle as a control. A changed hash proves *a* different file shipped, never the *right* one, and that gap is exactly what let a blank admin page through earlier the same day.

**Delegating with the brief "do not assume the issue's framing is right".** `biffo-platform-app#4` was filed as an authorization bypass. Instructing the agent to establish what actually enforces, and to say plainly if no change was warranted rather than manufacture one, produced a correct de-escalation instead of a fix for a defect that did not exist. The counterfactual matters: an agent told to "fix the bypass" would have found something to change.

**Verifying a sub-agent's security claim rather than relaying it.** The same agent reported "the backend already enforces, no data is reachable". That downgrades a security issue, so I re-ran the unauthenticated checks against the API Gateway origin myself before repeating it. My own grep then produced a false positive (`3 matches` for `session|idea|report|prompt` — all from the word *ideation* in asset paths), which would have kept a security issue open on nothing had I not looked at what actually matched.

**Pre-checking a delegated task's risk before spawning.** Before handing over the runner-fleet commit I established what `.gitignore` covered and what would actually stage, which turned "commit the Terraform" into a brief naming the specific hazard. That is what put `tfplan` in front of the agent at all — the issue never mentioned it.
**Prove research is real by picking a discriminator the failure mode cannot
fake.** After fixing the analyst's silent no-search (#66), the obvious check —
"does the report name plausible competitors?" — proves nothing, because
fabricated competitors are *exactly* what a well-known domain produces from
parametric recall. Three choices made the run decisive instead:

1. **A deliberately niche prompt** (UK farm-shop surplus to restaurants), where
   recall has little to draw on and invention is more detectable.
2. **Resolve every cited URL**, not just eyeball the names. Seven cited, seven
   resolved (one 429 — rate limiting, not absence).
3. **The clincher was a typo.** One URL was
   `craftguildofchefs.org/news/...restaurantss-surplus-ingredients...` — a
   misspelling *in the source's own slug* — and it returned 200. A model
   inventing a plausible URL does not invent a typo that happens to resolve. It
   copied a real link, warts and all.

Corroborated by timing: the analyst run took **78.1s** against **2.7–3.3s** for
each challenger turn, consistent with multi-turn retrieval rather than one
completion. The lesson generalises: when the failure mode is *plausible output*,
the test must key on something the failure mode has no way to produce — not on
whether the output looks right.

**Not claimed:** the model slug was never found in CloudWatch. The runtime may
not log it, so that is an unknown, not a confirmation. The URL evidence stands on
its own.


**Logging the decision, not just the error, turned a repeat defect into a
one-line diagnosis.** Two integration points in one feature made the identical
mistake — reading a payload field that did not exist. The one whose no-op branch
logged what it was ignoring announced its own bug on first run; the one that
returned silently took a deployed page, a bisect and an API read to find. Nothing
about the code quality differed. The observable one was cheap because it said
what it did.

**Verifying by the route a person actually uses found a defect four API checks
missed.** `0007` M4 was confirmed at every layer — SES config, Lambda logs, Core
and BFF both returning the row `failed` with its reason. All green. Opening the
lead in the browser then showed **"Nothing sent or logged yet."**, because the
timeline could not distinguish loading from failed from empty (tabsii-crm#118).
The API was right and the product was still lying to its user. The plan had
demanded a browser check in writing; doing it is what earned this.

**Reading the producer settled a shape three sources disagreed about.** Before
changing `trigger_payload`, the question "is `trigger_event` flat or wrapped?"
was answered by reading the two ends — `dispatch_event` storing it, and
`orchestrator/plugin.py:284` reading it straight back into `format_map`. That
last one is decisive: `{email}` recipient templating *works in production*, which
is only possible if the fields are flat. Cost ~5 min, and it replaced tabsii's
local patch as evidence with the actual contract.

**Proving the test fails first caught a worthless test twice.** For both
tabsii-crm#119 and biffo-template#844 the new tests were run against the *old*
code before the fix landed. In #844 the contract test failed with the bug itself
— `{}` where the producer had stored `{'email': …, 'lead_id': …}`. Without that
step the #844 tests would have been the same self-confirming fixtures that let
the original defect through.

**Catching my own stale checkout before reporting from it.** A residual defect
was nearly reported in the SES handler — `_reason()` still reading
`notificationType` — from a primary checkout **two commits behind `dev`**. The
deployed code was already correct. `git rev-list --count HEAD..origin/dev` before
trusting a tree is in AGENTS.md §1 precisely for this, and it is cheap.

> **Recurred 2026-07-30 in a different repo, with a worse failure mode.**
> Verifying the marketplace apply-form fix, `tabsii-marketplace`'s primary was
> **5 behind `origin/dev`**; the working tree showed `const body: {message?,
> phone?}` with no postcode, which is precisely the bug that had just been fixed
> and merged. One step from reporting a regression **in work merged forty
> minutes earlier in the same session** — the most confusing possible finding to
> hand someone, because it implies the merge silently reverted. What caught it
> was not discipline but suspicion: the fix was too fresh for its absence to be
> plausible, so `git fetch && git log origin/dev` came before the report. That is
> luck, not method, and the second occurrence is where a pattern stops being an
> anecdote. **The recurrence is the finding: knowing the rule did not cause it to
> be run.** The estate has no cheap prompt for it — nothing warns that the tree
> you are reading is behind the branch you just merged into, and every agent
> reads a primary checkout at some point. A `git fetch` in the read path, or a
> staleness warning, would remove the need to remember.

**Reading the producer before building the consumer killed an unbuildable plan
step in ten minutes.** `0008` M3 specified a `trigger_filter` carrying a
`cadence_id` that `lead.captured` does not contain — every compiled step would
have been silently inert. Reading `_matches_trigger_filter` and the emit site
*before* writing the compiler turned a whole milestone's rework into a design
question asked up front.

**Proving the test fails first caught two silent bugs inside one PR.** Writing
M3's tests and running them against the unfixed compiler exposed a `tenant_id`
conflation (Core's string vs tabsii's UUID — definitions would have been created
under a tenant `dispatch_event` never scopes to) and orphaned definitions
(a removed step's workflow stayed **enabled and sending**). Both pass every other
assertion in the file.

**Checking which endpoint the deployed UI calls, before trusting a PR body.**
The E2E's conversion step depended on tabsii-platform#323's claim that the CRM
was wired to the new route. Checking rather than assuming turned "the fix does
not work" into "the fix was never connected" — and prevented an hour hunting a
bug in Core that did not exist.

**SHA-pinning a deploy check after an unpinned one lied.** A watcher matching
"newest run named Deploy" reported success for the previous commit. Every check
afterwards pinned the commit, and the next one correctly waited eleven more
minutes rather than reporting a green that belonged to something else.

**Stubbing the tool instead of reading the script — including the path where
everything is healthy.** biffo-verify §6 says to exercise *every* path, not just
the broken one. Three of the four stubs (garbage response, real advisory, clean
response) told me what I already expected. The fourth — a **clean, parseable**
audit payload on a PATH with no `jq` — found a second, unrelated fail-open that
had survived #591, #592, #636, #717 and #721 in the very file those issues
hardened, and that no amount of reading the script would have surfaced, because
the code looks correct: it *does* retry, it *does* warn, it *does* distinguish.
It just cannot, without its parser.

**Re-deriving an issue's recommendation instead of implementing it.** #743
argued for exposing the audits through `biffo check` because copying them into
satellites would drift undetected, and noted that neither skeleton had a
`scripts/` directory. Both premises were true when written and false three days
later — `shared-files.json`, `shared-sync.sh` and skeleton `scripts/` all
landed in between. Checking the premises cost two minutes and changed the
design.

**Live API querying beat reading the source, again — because the source looked correct.** `assignment.py`'s `territory_id` genuinely flows from resolution into `_record_outcome`; a read-through would plausibly conclude it is used. Only comparing a real lead's raw `GET /leads/{id}` response against what `LeadDrawer.tsx` rendered — using the session's own Cognito token, `fetch`'d directly in the browser console — showed the value was computed and then dropped before anything durable. The gap was in what the function does with the value, not in whether it receives one.

**Recognising an infeasible live-repro and falling back to the right verification instead of skipping it.** The "two territories match the same postcode" ambiguous path looked like it needed a live click-through, until checking `territory_settings.overlap_tolerance_sqm`'s default (10 sqm — a few square metres) showed two territories can't be drawn to overlap enough to share a postcode centroid without the DB trigger rejecting the draw. Rather than either forcing a doomed manual geometry exercise or shrugging the path off as "unverified", running the existing `test_assignment_resolution_pg.py` (which already documents bypassing the same trigger deliberately, in a single transaction, as the only honest way to construct the case) against a real Postgres/PostGIS container was the correct proof — and it passed.

**A green PR, green CI and a completed merge were still not treated as "shipped."** Landing the unified lead-timeline endpoint (tabsii-platform#399), the actual acceptance test was a live click-through against the real lead, not the merge itself. That single habit is what caught it: the browser rendered `Could not load activity`, and unzipping the deployed core Lambda (`aws lambda get-function` → `Code.Location` → grep) showed the new module absent entirely, 21 hours after merge, despite every visible signal — the PR page, the issue, the CI run on that PR — reading as success. Reading the source or re-running the test suite would have shown nothing wrong, because nothing was.
**Test the guard with violations, not only with clean input.** A rule forbidding
valuation figures in founder-facing copy was enforced by a regex that passed on
every real description and would have passed forever: `\b` cannot match between
`\u00d7` and a space, so it silently ignored `5.8\u00d7` — the exact spelling the
source table used. Clean input cannot tell a working pattern from one that
matches nothing. Writing a test that feeds the guard known-bad strings found it
in under a minute, and the same technique proved a second guard genuine by
showing it reports 1 for sequential awaits and 3 for `asyncio.gather`.

**CloudTrail settled which of two plausible causes was real.** Five CI jobs died
in the same second. Two mechanisms could do that: spot reclamation, or the
orphan sweep whose identical signature is documented in the same Terraform file
("killed three of them in the same seconds they claimed jobs"). Guessing had a
50% chance of shipping a fix that changed nothing. `BidEvictedEvent` × 5 at
exactly that second, against `scale-down`'s `TerminateInstances` three minutes
earlier on idle runners, decided it in one query — and `StateTransitionReason`
(`Service initiated` vs `User initiated`) corroborated it independently.

**Reproducing by the reporter's exact URL found that the page did not exist.**
The reported 503 was real, but the path it was reported on renders Next.js's
404 with a 200 status and has no route in either repo. Chasing the application
would have been chasing nothing; the actual defect was two layers away in an
account quota.

**Verifying the deployed artifact rather than the pipeline.** Three claims this
session were checked against the running system rather than a green workflow:
the served JS bundle contained `/form-options` and none of the five endpoints it
replaced; the live scale-up Lambda's environment showed
`price-capacity-optimized` (which the Terraform *plan* could not display,
because the new subnet id deferred the whole map to `known after apply`); and
the `ddl-import` payload showed `"applied": ["010_…"]` against nine `skipped`,
which a green deploy alone does not distinguish from a file that never ran.

**Checking the arithmetic on a tool's own output caught silent data loss.**
Appending 6 rows to a 326-row dataset produced 329. The command reported success
(`extracted 329 rows`) and the regenerated tally quoted 329 without complaint —
every surface agreed. Only 326 + 6 = 332 disagreed. Isolating it against a
pristine checkout showed the tool drops 4 rows on *every* run, unrelated to the
edit, in a function whose comment states it was fixed for exactly this. Two
further checks were then needed and both paid: a grep that reported rows
"missing" turned out to have broken escaping (the ruler, again), and restoring
the orphans produced 334 rather than 333 because one had been re-parsed rather
than lost. **The generalisable habit: when you add N things, assert the total
grew by N** — every other signal here was green and wrong.


**Comparing the PR head against the run's `head_sha` caught a merge about to
happen on the wrong evidence.** A monitor reported `ALL SETTLED` with five
passing checks; the run it had settled on was for a commit superseded by a
force-push, and the real run was still queued. `cancelled` is a terminal state,
so "all checks non-pending" is satisfied by a run the force-push killed. One
comparison — `gh pr view --json headRefOid` against
`gh api .../runs/<id> --jq .head_sha` — settled it. **Any check that a PR is
green has to name which commit it is green about.**


## What needs more thought

**The corpus guard asserts the file grows, not that it makes sense.**
`corpus-append-only` exists to stop rows being deleted, and it does that. But
both of today's wrong conflict resolutions satisfied it: one added 88 duplicate
rows, the other left the corpus untouched while deleting 12 prose entries from
the page beside it. **A duplicate-`summary` check is one line and would have
caught the first.** Nothing at all would have caught the second, because no gate
knows what a PR was supposed to contain — that comparison exists only in the head
of whoever is resolving, and it is exactly the thing a tired person skips.

**Nothing links a hand-written test mock to the client it doubles.** Adding a
method to `createApi` leaves every bespoke `vi.mock` object one key short, and
the failure presents as a *hang* — the undefined call rejects inside a mount-time
`Promise.all` and vitest waits for its timeout. It happened three times in one
session, in two different frontends, and the mock's own comment already warns
about exactly this. A comment that is correct, prominent and ignored three times
is not a documentation problem. A test asserting the mock's key set is a superset
of the real client's would fail loudly at the point of change.

**A recorded fix on one AWS account reads as done for the whole estate.** The
Lambda concurrency cap is per-account, and a note saying "quota increase to 1000
requested" was about tabsii's account while the same symptom was live on
biffo-platform's. Nothing in the note was wrong; nothing in it said *which*
account either. Anything recorded about an account-scoped limit needs the account
id in it, and the check is `aws lambda get-account-settings`, not the Service
Quotas case status — which still read `CASE_OPENED` after the raise had applied.

**A page load costs twice what it looks like, and nothing surfaces that.** Every
`/api/v1/plugins/*` request is served by the shared plugin host, which then calls
Core: two Lambda invocations per request, invisible from the client. Seven
mount-time fetches therefore wanted ~14 concurrent invocations. The signature is
visible in metrics — `core-api` showing *more* invocations than the host that
fronts it — but only if you already suspect it. No budget, lint or review step
counts a page's request fan-out against the platform's concurrency ceiling.

**`terraform plan` cannot show the values you most want to check.** The change
that mattered was `INSTANCE_ALLOCATION_STRATEGY`, and the plan rendered the whole
environment map as `-> (known after apply)` because one new subnet id was
unknown. The plan was reviewable for *shape* (2 add, 2 change, 0 destroy) but not
for *content*, and the only way to confirm the intended value was to apply and
then read the live Lambda. Worth knowing before treating a plan as a review
artefact.

**Two practices PRs cannot be landed independently, and the workaround is
sequential.** #907 and #905 both regenerate the same block, so #905 had to wait
for #907 to merge before rebasing — otherwise it needed two rebases instead of
one. That ordering constraint is invisible: nothing in either PR says "land the
other first", and the only symptom is a second conflict that looks like bad luck.
Filed as #953; the sequencing tax is the part the issue understated.

**The surfaces users actually complain about are the ones no agent can reach.**
All five defects in the 2026-07-30 demo-feedback batch were reported from
behind a login, and the most important of them — does the marketplace apply form
capture postcode and consent — sits behind a **buyer account**. Creating one is
outside what an agent may do, so the fix was verified by unzipping the deployed
Lambda and grepping the deployed JS chunk: strong evidence that the right code
is live, and **no evidence at all** that a real submission produces a lead with
those fields. The gap is structural, not incidental: every auth-gated surface in
the estate has the same property, and it is exactly where user-visible bugs are
reported from. Nothing currently bridges it — there is no seeded test buyer, no
long-lived non-production credential an agent may use, and no scripted
end-to-end path that starts at registration. The workaround (verify the
artefact, state plainly that the round trip is unproven) is honest but it is
still a rung below the standard this page sets for everything else, and it will
keep being the answer until someone decides what the credential story is.
Worth noting the failure mode it permits: the deployed schema can be perfect
while the *client* never sends the field, and artefact-grepping both halves
separately does not prove they meet.

**A persistent note asserted a defect that had been fixed, and it was believed
for a day.** A memory said `verify.sh` detects toolchains at the repo root only,
that siblings therefore print `verify passed` having run nothing, and that
`bandit` was excluded. Testing the current script: a repo whose only
`pyproject.toml` sits at `services/api/` yields `uv run --directory
./services/api ruff check .`, `... pyright`, `... bandit -r src -ll -q`. **All
three claims false**, fixed by #852/#853. The note was accurate when written on
2026-07-29. This is the six-of-38 decay the backlog triage found, applied to
notes rather than tickets — and notes are worse, because nothing re-reads them
the way a triage re-reads an issue, and they are consulted precisely when
planning work. **No mechanism exists to age or re-verify them.** The cheap
version is a rule ("test the gate in front of you before acting on a note about
it"); the real version is that any note asserting a defect should carry the
command that proves it, so re-checking costs one paste.

**The corpus records fail-opens faithfully and converts almost none of them into
work.** `unfiled` is a status in `evidence.jsonl` meaning *written down, no issue
ever created*, and 8 of the 80 fail-open rows carried it — three with no `refs`
at all. The dashboard's tallies look identical whether a row is fixed or
abandoned, so the gap is invisible in every number reported. #956 converts the
current backlog by hand, which is a one-off; nothing stops the next eight
accumulating. **A row that stays `unfiled` past some age is a measurable thing
and nothing measures it.**

**`/practices-standup` only fires when someone asks "what hurt us", never when
someone says "fix these".** The session that produced this page ran 1–3 hours of
throughput work — the skill's exact purpose — without invoking it, because the
work was directed from the backlog. The cost is not the skipped ranking; it is
that **no choice was recorded**, so tomorrow's loop closure has nothing to close.
And it cannot be repaired retrospectively: the skill is explicit that logging a
choice after building takes the post-fix value as baseline and guarantees a false
`did not move`. A day of throughput work is therefore *unmeasurable* rather than
merely unmeasured, and that is a worse outcome than not doing the work.

**Nothing checks that an endpoint's session can actually see the tables it
reads, and this is now the most repeated defect in the estate.** Three instances
in one day (`media_assets`, `audit_logs`, `users`), each shipping green, each
found only on dev. The shape is always the same: an RLS-gated table, a session
the caller's permissions do not cover, and a policy that answers by returning
**zero rows rather than an error** — so "refused" and "absent" are the same
observation. Neither test lane can see it, structurally: both wire `get_db` and
`get_admin_db` to a single engine, and in the pg lane that engine is the schema
owner with `BYPASSRLS`, so even real policies are inert. A test that drove the
two sessions genuinely apart (wrapping the RLS one to hide exactly the table the
policy hides) caught two of the three retrospectively in minutes. **That wrapper
should probably be a shared fixture rather than something each test file
reinvents after the bug.**

**A silent write is worse than a failed one, and the response body is complicit.**
An RLS-refused `UPDATE` affects zero rows and reports success. Endpoints then
build their response from what they *intended* — `sealed: true`,
`lead_converted: true` — rather than from what the database confirms, so the
response asserts an outcome that never happened. Asserting `rowcount` fixed one
endpoint (#373); nothing generalises it, and #372's audit of 22 other
mid-request commits is open. **The deeper question is whether any RLS-gated write
in this codebase should be allowed to go unchecked, or whether that wants a
helper that makes the check unavoidable.**

**A click-through proves the path you clicked, not the endpoint.** The strongest
verification tool in this project has a blind spot worth naming: one defect
survived a passing manual verification because that run took a *resume* branch
which skips the faulty commit. It was caught only because an unrelated fix forced
a second run down the other branch. **Where an endpoint has materially different
paths, "verified on dev" needs to say which one** — and the habit of writing
"verified" without that qualifier is exactly how a green claim becomes a false
one.

**Delegation needs the coordinator to read the diff, and the failure mode is not
the obvious one.** A subagent hit its session limit mid-task with work
uncommitted — and it had stopped directly on top of a real bug its own test had
just caught. Discarding the branch would have thrown away the finding with the
code. The risk in delegation here was not a bad diff; it was a **good diff,
abandoned mid-thought, that looks like nothing**. Reading it was worth ~40
minutes and recovered a genuine RLS defect nobody had otherwise found.

**A guard that greps source fires on the fix it was written to protect, and there
is at least one latent example in the tree right now.** Rerouting the profile
surface through the ADR-0012 seam (#949) needed a guard that no router imports the
Core user model. Written as `assert "import User" not in source`, it failed on
`from ..identity import UserProfile` — the very DTO that *replaced* the model —
and on the comment explaining the change. The idiom was copied from
`test_identity_seam.py`, which asserts the same substrings against
`middleware/auth.py` and passes only because that file happens never to mention
those words: **add one legitimate `UserProfile` import there and a correct file
fails its own compliance test.** A guard that fires on its own fix does not get
fixed, it gets deleted, so it is strictly worse than no guard. Structural claims
belong in an AST walk (`ast.ImportFrom`, resolved module name), and every guard
should be run against both the pre-fix and post-fix source before it is trusted —
one direction is not evidence. The unconverted grep-based guard is still there.

**Proving a test fails first is a destructive experiment, and nothing in the
workflow says to commit before running one.** Fail-first evidence is now expected
on any PR claiming a fix, which means routinely reverting real files to watch the
new test go red. Doing that with uncommitted work in the tree cost three files of
edits in #949: the restore step was `git checkout HEAD -- <paths>`, and `HEAD` was
still `origin/dev` because nothing had been committed yet. `git stash` is not the
alternative — it is repo-global across worktrees, which is its own recorded
hazard. The rule is one line ("commit, even scrappily, before reverting anything
to prove a failure; amend afterwards") and it is not written down anywhere the
next agent will read it.

**Four fail-opens surfaced in one day, none caught by a gate, and the fourth was
added by the fix for the third.** `ci_has()` returning true when the
workflow is unreadable (#942, filed unfixed); the branch-protection scaffold
skipping permanently on a 403; and `SubAppLifespan.start()` classifying a
*startup crash* as "this app has no lifespan handler" (#948) — in the code written
to stop plugins silently not starting. That last one had 14 new tests over it and
survived them, because Starlette sends `lifespan.startup.failed` before re-raising
and every current plugin is FastAPI, so the tested path was the correct one and
the advertised framework-agnostic path was not. It was found by reading the branch
and reproducing it by hand. **The estate has no way to ask "which of our
error-handling branches have never been executed?"** — a coverage report over
`except`/fallback branches specifically would have named all three, and would cost
one CI job.

The fourth is the sharpest, because it was introduced *by* the fix for the third
and it leaked a secret. The plugin-host quarantine interpolated a failed plugin's
reason into its 503 body, and Starlette puts the whole formatted traceback into
`lifespan.startup.failed` — so a plugin dying on a DSN returned its password to
the caller. CI was green on it. The PR's own test suite was green on it, because
two tests asserted the reason appeared in the body, which encoded the leak as the
intended behaviour. And `forward.py`, one file away, already carried
`# noqa: BLE001 — never leak a stack trace to a caller`: **the rule was written
down and nothing enforced it.** A convention that exists only as a comment in the
file that happens to follow it is not a control, and this estate now has a
measured example of what that costs.

**Nothing proves a feature works before it is called done, and "green" is
routinely all four repos agreeing about nothing.** Idea Scout's prompts feature was
merged and deployed across four repos, with three milestones closed, while four
independently-sufficient defects stood between an admin edit and a run. Every one
was outside what any gate in this estate can observe: a CDN routing gap, an
absolute path inside a mounted app, Starlette registration order against a built
`dist` a source checkout lacks, and a React state mismatch behind a blind `as T`
cast. **What would have caught all four is one scripted end-to-end exercise of the
deployed product** — sign in, open the admin surface, change something, run the
thing, read what the model was actually sent. That artefact
(`definition_snapshot.instructions`) settled in a single query what three merged
milestones had asserted wrongly. It is writable today, it needs no new
infrastructure, and its absence is why a one-day feature took four.

**Nothing establishes that an extension point is wired before work is built on
it.** This estate now has four documented hooks that never fire — `on_install()`,
`@app.on_event("startup")` under the shared host, the manual
`seed_agent_config.py`, and a release workflow whose trigger could not fire. Each
was found by noticing an absent *effect*, days or weeks later, never by noticing
the absent caller. Every one of them is a one-line grep: **does anything invoke
this?** For a lifespan hook the question is sharper — the app is fully reachable
and only its startup is skipped, so nothing looks wrong anywhere. **What would
have caught it is a guard asserting each declared hook has an observed caller**,
which is writable today and nothing requires. A skeleton that *demonstrates*
seeding through a hook the CLI never calls is worse than one that demonstrates
nothing.

**A premise about where something must run has to be tested where it runs.** M3
established "there is no deploy step to hang seeding on" by listing the plugin
repo's workflows. Correct, and about the wrong repo — the seed belongs to the
instance, which had run exactly that step for this plugin three times. The
research was real and the subject was wrong, which no amount of rigour downstream
recovers. Worth a habit: **name the repo the answer would live in, then look
there** — not at the repo the question was asked in.

**Nothing catches a UI that fabricates the data it claims to display.** The
admin panel served four "built-in" agents whose prompts were invented strings,
and every automated check passed: it typechecked, it linted, its tests asserted
the rows rendered. The defect is a mismatch between a label and a source, and no
gate in this estate expresses that. It was reachable by one click and would have
overwritten production config. **What would have caught it is a test asserting
displayed content equals its declared source** — that is writable, and nothing
requires it.

**A correction's wording determines whether it fixes an instance or a class.**
Three consecutive rounds on one milestone each fixed exactly the field the
review named and reproduced the same defect in the next field along. The round
that finally fixed it was the one that said *"fix it at the source, not by
editing the string"* and named the mechanism. That is a real, repeatable lesson
about instructing a build agent — and it is not written down anywhere a future
session would find it, which is a gap in the skill rather than in the agent.

**A subagent asked for "the gates" runs the gates of its brief, not of its
diff.** Scoped to a frontend directory, one later added a Python endpoint and
reported three JavaScript gates — accurately, and uselessly. The fix is probably
to ask for gates by what changed rather than by where the work was scoped, but
that needs the prompt to know which gates map to which paths, which nothing
currently states in one place.

**Nobody has audited how many RLS policies pass a NULL scope argument, and each
one silently excludes every scoped role.** `media_assets_create` and
`audit_logs_read` both call `fn_authorized(code, tenant_id, NULL, …)`. Because
every non-tenant-wide branch of `fn_authorized` is guarded by
`p_<x>_id IS NOT NULL`, a NULL-scope call is **only** satisfiable by a
tenant-wide assignment — so a brand-scoped role can hold the permission, appear
correctly granted in `whoami`, and read or write nothing. Two were found by
accident while building an unrelated feature. `db/imports/tabsii/011_rls_policies.sql`
is one grep away from answering how many more there are, and nothing in CI
compares a policy's call shape against the `scope_level` of the roles granted its
code.

**A subagent can be given a wrong contract and will implement it faithfully.**
The CRM was told the brand's version list lived at generic CRUD with a
`?brand_id=` filter. That filter does not exist, and the agent had no reason to
doubt it — it built against the contract, its tests pinned the contract, and its
E2E fixture *implemented* the contract, so three independent green signals agreed
with a false premise. It was caught by reading the core handler, not by anything
the sibling could have run. When two agents build either side of an interface,
the interface itself is the unreviewed artefact.

**A fixture server that is more capable than the real thing turns E2E into
theatre.** `api-fixtures.mjs` filtered the version list by brand. The real core
did not. The E2E passed *because* the fake was better than production — the
precise inversion of what a fake is for. Nothing checks that a stub's behaviour
is a subset of the real service's.

**Nothing generates the "where the work lands" table, and it drifted 2.5×.** It
is headed *"Generated, not typed"* and warns that hand-typed counts go stale —
then read 99 rows against a corpus of 248. Three sessions rewrote it in one day
(200 → 99 → 248) because the figures are transcribed by hand from a generated
report. Concurrent sessions cannot converge on a hand-copied number. A generator
emitting the markdown block is ~20 lines and does not exist.

**Resolving an append-only corpus conflict is done by ad-hoc regex each time,
and has now failed twice.** Today's failure was an **empty HEAD side**, which the
resolver's `(.*?)` could not match, so it reported "0 conflicts resolved" and the
markers were committed. Both corpora conflict on almost every concurrent PR;
this deserves one reviewed script, not a fresh regex per session.

**No documented way to land a branch checked out in someone else's worktree.**
Two stale docs PRs needed their conflicts resolved, and AGENTS.md §1 forbids
touching a worktree you did not create — which also blocks checking the branch
out anywhere else. The workaround was a throwaway clone. That works, and nothing
says so.

**Nobody measures runner cost per merge.** The estate ran **957 workflow runs**
today; `biffo-template` alone burned ~9.4 hours of runner time, and every merge
to `dev` costs a second full CI run on top of the PR's. The operator felt this
before any dashboard showed it. The practices collector counts merges, not the
compute they cause.


**A headline that cannot fail is measuring the wrong thing — including here.**
Every gate around cross-run dedup was green through two shipped versions that
did not work, because the gates assert the list is assembled and delivered, and
that is always true once the code exists. There is no value those tests could
have returned that would have read as "the feature does not work". The outcome
metric — *do two runs with identical inputs produce the same ideas?* — did not
exist until it was run by hand, and it read **3 of 4 repeats** on its first
execution and **2 of 2** on its second. The gap is not a missing test; it is
that the only test which can fail costs a live model run, and nothing in this
estate budgets for a check with a per-execution cost.




**Distributing a script does not change the workflow that calls it.**
`shared-files.json` gets the hardened audits into the six siblings and two
plugin repos, but each of those repos' `ci.yml` still runs the raw command until
someone edits it — and `ci.yml` is legitimately repo-owned, so no mechanism can
carry that edit. The scripts arrive; the defect stays until eight one-line PRs
are written by hand. That is the same "vendor it plus a one-time manual copy-in"
non-mechanism `shared-sync.sh` was built to replace, displaced one file over.
The general question is open: **what distributes a change to a file every repo
must own but only differs in by a path?**

**The `pytest` fast/slow verdict is cached and never invalidated.**
`.pytest-duration` is written on the first run and read forever after. A suite
that grows past the 15s budget keeps its `fast` verdict and stays in the gate;
one that was slow when first measured stays excluded even after it speeds up.
The cache decides **whether a check runs at all**, and nothing expires it — a
staleness problem in the mechanism built to fix a staleness problem. A max age,
or re-measuring when the suite's file count changes, would close it.

**The template version stamp is printed but never asserted.** `.biffo-shared-version`
records which template a repo's gate came from, and `verify.sh` prints it — but
nothing compares it to anything. A repo two versions behind still merges, and the
stamp is decoration until CI (or the gate itself) fails on a mismatch. It closes
the *visibility* half of H5 gap 1 and leaves the *enforcement* half open, which
should be said plainly rather than counted as done.

**`--list` under-reports on a fresh clone until the first real run.** With no
cached measurement it assumes `slow` and omits `pytest`. That is the deliberate,
safe direction — it can never claim a check that is not running — but it means
`gate-coverage.sh` reads slightly low in a just-cloned repo, and the number
silently improves after someone pushes once. Worth stating wherever that number
is quoted.

**No gate in this estate can assert that a model obeys an instruction.** Every
test around cross-run dedup passes and the feature does not work, because the
tests assert plumbing — the list is assembled, survives the fan-in, reaches
synthesis with the prompt attached — and the actual requirement is behavioural.
That requirement is testable, but only by running the thing and comparing, which
costs a real agent run and a human judgement about whether two ideas are the
same idea. Nothing currently budgets for that, so every prompt-dependent feature
in this estate ships on the strength of its plumbing tests. **This is the second
time today a measurement contradicted an argued position** — the other was a
severity estimate wrong by 8x — and both times the measurement was cheap once
someone asked for it.


**Nothing makes a test double agree with the service it stands for.** The
`FakeCore` row is not a mistake review would catch: the fake was consistent,
readable and wrong, and the route it tested was written from the same wrong
belief — so the two agreed and the suite was green. Every hand-written double in
this estate has that exposure and the number of them is growing. The obvious
answers each cost something real (recorded fixtures go stale; contract tests need
a running service; generating doubles from OpenAPI needs the schema to be
accurate, which is the same assumption one level up). What is clear is that
**"the fake matches what the service actually returns" is not a property anything
currently tests**, and the failure mode is silent green.

**`--delete-branch` is optional on a command that is otherwise complete, and the
omission has no symptom.** `gh pr merge --squash` succeeds and leaves the branch;
AGENTS.md §5 gives the flag and nothing enforces it. `tabsii-platform` has
repo-level auto-delete so it self-corrects; `tabsii-crm` does not, and had
accumulated **21 fully-merged branches** from earlier sessions plus 3 from this
one. Nobody noticed because a stale branch is pure entropy until a `git branch -a`
gets confusing. The per-repo setting is the real fix and it is unset on at least
one repo — a `biffo check` for "auto-delete-on-merge is enabled" would find the
rest.


**Nothing distinguishes a capability that is unavailable from one that is merely
unloaded.** Reasoning about whether a check was possible, I enumerated what I
could do, concluded a browser check was not among it, and argued the case twice
before the operator corrected me. The tool existed and needed one call to load.
The failure mode is specific and probably general: **feasibility gets reasoned
about from whatever is currently visible, and a deferred capability is invisible
in exactly the same way an absent one is.** A habit of checking before declaring
something impossible would have cost seconds; the argument I built instead was
detailed, technically accurate, and wrong in its conclusion.




**Nothing runs the three estate audits automatically.** `gate-coverage.sh`,
`hook-audit.sh` and `shared-sync.sh --check` all exit non-zero on a real
problem, and **all three are invoked by hand**. The gate blind spot survived
because nobody ran the check that would have shown it — and the checks did not
exist, because arming looked green. They belong in the daily practices cron, or
in a template CI job that fans out over the estate. Until then the estate is one
forgotten command away from the same state.

**A PR cannot tell you it is carrying a stale shared file.** Drift is detectable
only when someone runs `--check` from a fresh clone of the template. A sibling
merging a PR has no signal that its `verify.sh` is two versions behind — which
is exactly the condition that produced `verify passed` on a 700-line change. A
version stamp in the file plus a CI assertion would close it; neither exists.

**`commit-msg` is inert in every sibling.** No root `commitlint` config, so
subjects are not checked locally. CI still enforces Conventional Commits on the
PR title, so it is a missed shift-left rather than a hole — but the release
derives its version bump from that subject (ADR-0006), so the blast radius is
larger than "a lint".

**The exclusion list is still written by hand, and one entry was wrong for a
fortnight.** `bandit`'s rationale described what the CI step was *assumed* to do.
Re-auditing the rest found no other error, but nothing prevents the next one:
an exclusion is a claim about a CI step's behaviour and nothing tests it. The
same normalisation `gate-coverage.sh` already does could assert that an excluded
kind genuinely cannot run locally.

**`pytest` is excluded by a judgement that is right for one repo.** 56s in the
template, ~2s in a sibling. It is opt-in per repo via `BIFFO_VERIFY_PYTEST=1`
and nothing prompts a repo to opt in, so the fastest suites in the estate are
the ones not being run.


**A safety rule enforced by memory was broken by its own author in the session
that quoted it.** AGENTS.md §6 forbids piping `git push`, because the pipe's
exit status masks a rejection. I piped it — to filter an unrelated dependabot
banner — and reported success on a push that had failed and a commit that had
never happened. Two rows in this corpus already describe this condition. A third
instance is no longer evidence about attention; it is evidence the rule has no
mechanism. What would enforce it is unclear, and picking one from a single
incident is the move this programme exists to replace — but the *reminder*
approach can now be called falsified.

**Every install-verification question is asked from outside the deployment, and
the outside cannot answer it.** "Is this plugin mounted?" has no discriminating
signal: authentication precedes routing, so absent and present both return 401.
Verifying it currently requires unzipping a Lambda — credentials, and not
something a routine check can do.

**Nothing compares a parent issue's checklist to its children's real states.** An
epic sat with nine unticked boxes against eight closed milestones. The failure
is one-directional and always flatters the backlog rather than the work: a
tracker never over-reports completion this way, only under-reports it, so the
roll-up degrades silently toward "nothing is finished".


**Findings are captured and published in one step, so neither happens.** Writing
down "a saved plan is a zip, `strings | grep` cannot see inside it" costs about
ten seconds. Landing it costs a worktree, a commit, a PR into a protected branch
and a merge wait. §8 only describes the second, so at every decision point the
free action — start the next task — beat the expensive one, and the ten-second
version never happened either. Then compaction hit: those six findings survived
only because the summary happened to carry them, which is luck, not process.

The measurable cost is not the delay, it is the **weight of the evidence**. An
estimate rebuilt two hours later under "you should have done this already"
pressure is not the same datum as one written at the time, and the dashboard
currently cannot tell them apart — 19% of today's entries are reconstructed and,
until this edit, only the ones other sessions volunteered were marked.

**No fix is proposed here.** The obvious one — separate capture from publication
— is a guess from a single incident, and picking it now would be exactly the
ad-hoc change this programme exists to replace. It is listed as evidence for the
review to weigh against the other rows, not as an action.


**Nothing decompresses an artefact before scanning it for secrets.** `gitleaks` reads blobs, `.gitignore` matches paths, and both are defeated by a credential inside a zip — which is what a Terraform plan file is. This is not specific to `tfplan`: any committed archive, fixture tarball or vendored bundle is a blind spot, and the only reason nothing leaked was a manual `unzip`. A pre-commit step that expands known archive types before scanning would close it; nothing does today.

**No signal distinguishes "merged in the plugin repo" from "running on dev".** A change sat undeployed for a full working day and was found only because unrelated work forced a resync. The information exists — the vendored copy's content versus the plugin repo's `dev` — and nothing compares them. A scheduled drift check reporting "services/ideation is 3 commits behind" would have caught it on the first morning.

**A founder-facing promise is coupled to a Core setting, and nothing links them.** The new copy says a scout "will not sit there indefinitely", which is true only because `agent_run_unclaimed_after_seconds` is 1800s. Change that materially and the copy becomes a lie, with no test and no comment connecting the two repos. The general shape — UI copy asserting a timing guarantee owned by another service — has no mechanism here at all.

**Manual repo hygiene does not survive this concurrency.** The estate was swept
to zero errors; ~20 minutes later, while the write-up was being committed, other
sessions had merged and regenerated fresh stale branches, two worktrees on merged
PRs, and two primaries behind their upstream. Nothing was done wrong — every one
of those agents followed the workflow. At this many parallel sessions the
accumulation rate simply exceeds any cadence a human or a per-session cleanup can
hold, so "remember to tidy up" (AGENTS.md §1) is the wrong shape of answer.
`doctor` now *reports* it; something still has to *act* on it — a reaper on
merge, or a scheduled sweep, rather than an instruction.

**"No PR" was treated as the end of the enquiry rather than the start of a
second one.** The sweep asked GitHub whether a branch had merged; when the answer
was "there was never a PR", it concluded the branch was unprovable and stopped.
git could answer the actual question — *does this branch contain anything not
already in `dev`?* — in one command, and did, for 32 of 34. The general form:
when one authority returns "unknown", check whether a different authority
returns "no".

**Nothing distinguishes "this tool is for a local clone" from "this tool can run
anywhere".** `biffo doctor` was proposed for CI and would have failed every run:
a CI checkout is a detached HEAD with one branch and no worktrees, so five of its
six checks are meaningless there and the sixth is a permanent warning. That was
caught by checking before building — but only because someone asked. A command
whose preconditions are "a developer's clone" has no way to say so.

**An agent cannot mint a credential, and some paths need one.** That is a real
boundary, not a bug, and the useful response is architectural: prefer mechanisms
that use auth already present at the moment a human is running the command
(`sources.json` registration at create time) over mechanisms that need a stored
secret for CI to act unattended. Where a stored secret is genuinely required,
minting it is a one-time human step that should be batched into provisioning
rather than discovered mid-task.

**Nothing tests the seam between a validated request model and the service it calls.** Both ends of the preferences feature had tests and the wiring between them had none, so an accepted-then-discarded field passed everything. This is a general shape for FastAPI plugins here: a Pydantic model can accept a field the handler never forwards, and both the request and the response still look right. A convention — every request-model field asserted at the transport level — would close it, and no plugin currently has one.

**A closed milestone is not evidence its acceptance criteria were met.** M5 closed with its central criterion undelivered, and nothing noticed for a fortnight. The epic's success criteria are prose in an issue body; nothing links them to the milestones that claim to satisfy them, and nothing re-checks them when an epic is reviewed.

**Nothing links a release tag to the PR that produced it.** With several agents merging concurrently, `core-v*` tags appear continuously and none of them says which change it carries. The only reliable check is to grep the tag's tree for the thing you added — which works, but is manual and easy to skip precisely when you are in a hurry to distribute. A release note listing the squash subjects since the previous tag would make the check trivial.

**A database constraint on a VPC-only RDS instance cannot be verified from outside.** #661's uniqueness guarantee rests on a unique index. The migration is in the deployed package and `db-init` runs `command.upgrade` inline, so a green deploy is strong indirect evidence — but nothing exposes "does this index exist". The options are DB access, a duplicate insert through the SigV4-authed internal API, or an introspection endpoint built solely to satisfy the check. All three are unattractive, which is itself the finding: **we can deploy a constraint we cannot confirm.**

**Nothing checks that a template-owned test will pass on an instance's layout.** The engine guard was correct, well-tested, and structurally unable to fail here — it encoded `src/**` as production-only, which is true of this repo and false of both instances. There is no pre-flight that runs a template's own test suite against an instance tree before release, so this class of defect is *only* discoverable by shipping it. A `biffo core upgrade --dry-run` that also ran the incoming tests against the instance checkout would have caught it in seconds instead of a full release lap.

**Two irreversible-action guards fired today; neither was a gate.** The wrong stream count and the wrong exposure figure were both caught by a human-style habit ("that number disagrees with the one I measured"), not by tooling. The measurement mistakes had a 57× and a potential-data-loss blast radius respectively, and nothing in CI, no linter and no skill step would have stopped either. Worth thinking about what a gate for *measurement* would even look like.

**Two misreads of the same shape in one day, and the class has no name.** Both
`id -nG` and `ProductionAccessEnabled` were *correct data read through a label
the reader had attached* — a jq key called `sandbox`, a mental model of `id` as
"the user's groups" — and in both cases the label won over the field. Both then
propagated: into a memory entry, a scoreboard row, a recommendation, a plan. The
existing §1 discipline ("establish the current state") is written about tickets
and code; nothing tells you to apply it to **an assertion you are about to make
about your own environment**, which is exactly where both failures lived.

**Nothing reconciles "settings we believe are set" with "settings that are set".**
This page states that `allow_auto_merge` was aligned across repos on 2026-07-27.
It is `false` on `tabsii-crm`. Neither the claim nor the drift is detectable
without asking the API repo by repo, and the failure mode — `--auto` rejected
rather than queued — produces a green PR that nobody merges.

**An issue can be complete and open, and no mechanism notices.** tabsii-crm#100's
milestones both shipped; the issue stayed open because the person who knew left a
"pending checks" comment and never returned. Closing keywords do not help (they
fire, or silently do not — both are already on this page). The gap is that
*nothing re-reads an issue after the PR that finishes it merges*.


**The §1 discipline is written about tickets, and the expensive miss this session
was about the machine.** "Establish the current state before writing anything"
was applied faithfully to ten issues and not once to the claim "this environment
cannot run Postgres" — which was asserted from `id -nG`, repeated in a memory
entry, used to justify iterating in CI, written into a scoreboard row, and turned
into a recommendation to the user. It was wrong, and one `getent group docker`
would have settled it at any point. **A claim about your own tooling deserves the
same standard of evidence as a claim about the code**, and nothing in the skill
currently says so.

**Verification of a push checks the SHA, not the content.** AGENTS.md §4 says to
confirm the remote has your commit, and `git log origin/<branch> -1` satisfies it
while proving nothing about what is in the commit — which is how a
`--amend -F msg.txt` with nothing staged sent CI an identical broken file and the
repeated failure read as "the fix did not work". The rule should say verify the
**content** (`git show origin/<branch>:<path>`), because the failure it protects
against is precisely a commit whose message changed and whose tree did not.

**Nothing reads `biffo.divergence.json`'s reasons when investigating ownership.**
Its entries carry *why* a file diverges, and one of them contained the complete
diagnosis of #207's blocker — read only after the same conclusion had been
re-derived by hand. It is the closest thing the repo has to a decision log for
boundary questions and it is not in any checklist.

**A required-check list is a second place the truth lives, and it drifts.** The
RLS lane ran on every PR for hours while not being required, so `--auto` would
have merged a red one. The check existing and the check gating are different
facts, and only the second is in branch protection. Nothing reconciles "workflows
that exist" against "contexts that are required" in any repo.

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

**Keeping orphaned rows traded a silent deletion for a silent duplicate — now fixed.** `mergeExtracted` preserves a stored row the markdown no longer mentions, which stopped three sessions' work disappearing. The cost showed up within a day: matching on raw summary text made *rewording* a row read as delete-plus-add, so an edit as small as wrapping one word in `*emphasis*` left the old text behind and inflated every count derived from the dataset.

Rows now carry an identity independent of their current wording: their **refs** (the issue/PR links, stable across any rewrite) and failing that a **normalised summary** with markdown stripped and whitespace collapsed. Measured on the real 94-row table, reformatting a row used to yield 95 rows and now yields 94.

The residue, stated rather than hidden: a *substantive* rewrite of an **unfiled** row still reads as a new row plus an orphan. With no ref and no shared wording there is nothing left to match on, and the warning tells the author to prune it. Citing an issue on a row is now worth something beyond bookkeeping.
**A closing keyword asserts something the repo cannot know.** `Closes #N` on a
plugin-repo PR is evaluated at merge, but the issue was filed against
`dev.biffo.io`, which merge does not touch. Every gate on the plugin side was
honest and green; none of them is *about* the thing the issue was about. Nothing
in the workflow marks an issue as "fixed at source, not yet reachable", so the
only two states available are open and closed, and closed is a lie for as long
as the resync is outstanding. `Refs` is the honest keyword here, but it stops
the time-to-feature clock from ever starting — the metric and the honesty pull
in opposite directions, and that tension is unresolved.

**The scoreboard records recurrences as a status string, so frequency is
invisible.** The resync row has said "worked around — 3 resync PRs this session"
since it was written. This session made it four, and the only way to know that is
to read the prose. A row that recurs is a different animal from a row that
happened once, and the table cannot currently express the difference — which is
precisely how a ~35-minute cost gets paid four times without ever clearing the
bar to fix it.


**Nothing verifies that an event's stored shape matches what a consumer expects.**
`WorkflowRun.trigger_event` stores a payload flat; `RunOutcome.trigger_payload`
unwraps a `payload` key. Both are template-owned, both are reasonable, and
nothing connects them — the mismatch was invisible until a consumer read `{}`
forever without erroring. A single fixture generated *from* a real stored run,
shared by the template's own tests, would have caught it. The general form: two
halves of one contract, each individually tested against its own idea of the
shape.

**A `workflow_dispatch` re-run cannot satisfy a `pull_request` required check,
and nothing says so.** After a force-push produced no run, re-dispatching gave a
green run that the PR ignored, still showing the cancelled `pull_request` run as
failed. Closing and reopening the PR was the only thing that re-fired the real
checks. AGENTS.md §6 tells you to re-trigger via `workflow_dispatch`; it does not
say that this works for *observing* CI and not for *satisfying* it. Worth a
sentence, because the failure mode is a PR that can never go green.
**Nothing audits a plugin's declared capabilities against the runtime that has
to provide them.** ideation declared `web_search`; the runtime offers it only
with a Brave credential and drops it silently otherwise ("unconfigured means not
offered, not broken" — deliberate, and correct for the runtime). ideation named a
model OpenRouter does not serve. Both are *declarations checked by nobody*: no
test, no deploy gate, and no startup warning compares what a plugin asks for
against what its deployment can supply. idea-scout hit the identical `web_search`
case (#19) and the fix was applied **only to idea-scout**, because nothing
connects "this plugin declared it" to "every other plugin that also did".


**The effort log's cadence is stated but not enforceable, and the error is
one-directional.** §8 says "one entry per unit of work" and "run it when you
finish the task". Nothing prompts at that moment, so in practice the log gets
written once, at the end, from memory — and memory of a long session is
dominated by its last unit. A five-and-a-half hour session was logged at three.
Every mechanism that would fix this is cheap (log on merge; a post-merge
reminder; deriving a floor from PR merge timestamps), and none exists. Until one
does, every figure in this log should be read as a **lower bound**.
**A verification that lands after the write-up merges never reaches the log.**
This session's practices PR merged at 18:42, before the fix was proven, before
the four follow-up issues existed, and before the end-to-end run. Everything
after that point — including the single most reusable finding, *how* you tell
fabricated research from real research — needed a second PR that only happened
because someone asked whether the log was complete. §8 says to write up "when you
finish the task", but a task whose last act is *verification* finishes after the
natural moment to write. Nothing prompts the second pass, and the highest-value
content sits on the far side of it.


**A negative search result is trusted far more readily than it earns.** Three
times in one session — a metric bucket, a log grep, a document grep — an empty
result was read as proof of absence and was wrong each time. §Never says not to.
Reading the rule did not prevent it, which suggests the fix is not more emphasis
but a mechanism: a negative search is only evidence once the same query has been
shown to match something. Nothing in the tooling makes that cheap or habitual.

**Sibling repos have no git hooks at all, and `core upgrade` cannot reach them.**
tabsii-crm has no root `package.json`, no husky, and `core.hooksPath` unset —
zero local gates, so nothing catches a type error before CI. `.githooks/` is
template-owned, which distributes to *instances* but not to sibling or plugin
repos, and those need the skeleton change plus a manual copy-in. The repos with
the least gating are the ones the mechanism cannot serve.

**A fixture hand-written beside the code it tests is worse than no test.** Three
of this session's defects had passing tests built from the same assumption as the
implementation, so the tests confirmed the belief rather than the contract —
`trigger_payload` (ten tests), the SES envelope, and the timeline's empty state.
The countermeasure used here was a test that builds no fixture at all: dispatch a
real event, read it back from the database, hand the *stored* value to the
consumer. Nothing encodes that as a rule yet, and the class keeps recurring.

**tabsii-crm enforces no JS formatting, and running the obvious command is
destructive.** There is no prettier config and CI checks format only for Python
(`ruff format --check`). A routine `npx prettier --write` therefore reformatted
~700 lines to prettier's defaults against a single-quote/no-semicolon codebase.
Recoverable, but the trap is live for anyone who runs the tool the repo ships.

**A number in prose about repo settings went stale the same way the scoreboard's
headline did.** `biffo-workflow` states all five active Biffo repos have
`allow_auto_merge=true`. tabsii-crm reports `false` — `gh pr merge --auto` there
fails outright rather than degrading, so it was caught, but the skill's own
warning is what caught it, not the claim.

**Nothing forces a policy-touching write path to be tested on Postgres.** The
real-Postgres lane exists and is a required check, but it only runs `*_pg.py` —
and a developer writing enrolment logic naturally writes it against the fast
SQLite session like everything else. `0008` M4 had thorough cancellation tests,
all of them against a backend with no row-level security, and shipped a 500 on
the one path that mattered. A `*_pg.py` test is opt-in by filename; the decision
to write one is exactly the decision someone confident in their logic will skip.

**Nothing checks that a UI actually calls the endpoint a PR says it calls.**
tabsii-platform#323 closed tabsii-crm's gap in prose only. A grep-level guard
("this route has no caller in any sibling") would have caught it, and the same
shape — Core endpoint shipped, sibling never wired — has now happened twice this
week if you count the `trigger_payload` seam.

**The plan's own E2E was the last thing done, and it should have been the
first.** `0008`'s testing plan named the browser check explicitly, and running it
found four defects in under an hour after five milestones had merged green. Every
one would have been cheaper at M5's start than at its end. Nothing in
`biffo-sib-build` sequences the plan's E2E before the final PR merges.

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

**A brand's own creation isn't visible in the list that's supposed to show it, and nobody chased down why.** Creating a brand under a fresh tenant (`Keiran - Test Tenant`) returned success on the first `POST /brands` (confirmed indirectly: a same-name retry got `409 Conflict`), but "Brands at a glance" kept reading "No brands yet" after a hard reload. Worked around by testing against Demo Tenant's existing brands instead, since the actual task was territory verification, not this. Left open because it wasn't chased to a root cause — flagging so it isn't lost, not claiming it's understood.

## Skills used

Skills cannot be iterated on impressions. Every invocation, with an honest outcome.

| Skill | Outcome | Detail |
| --- | --- | --- |
| `biffo-verify` | **worked — §3 and §6 together caught a guard that could never fire** | The valuation guard passed on every clean description and would have passed forever. §6's *"what does this do when it cannot run?"* applied to a regex means: feed it violations. Doing so showed it matched `4.0x` and ignored `5.8\u00d7` — the exact spelling the source used. §3's discipline (watch it fail) is what turned a written test into a defending one; the same technique then proved the concurrency guard real by showing it reports 1 for sequential awaits and 3 for `asyncio.gather`. |
| `biffo-verify` | **worked — §4 and §5 turned "flaky CI" into a one-line Terraform fix** | §4 (read the *live* config, not the source) gave `INSTANCE_ALLOCATION_STRATEGY=lowest-price` and 17/17 runners on one instance type. §5 (read past the masking layer) mattered twice: `cancelled` masked an infrastructure kill as a test failure, and CloudTrail `BidEvictedEvent` distinguished reclamation from the orphan-sweep defect already documented in the same file — which would have made the fix useless. |
| `biffo-verify` | **partial — §8 was reached only when the operator typed the command, for the third recorded time** | Sections 1–7 were applied throughout and paid for themselves. The effort log was not run until `/biffo-verify` was invoked explicitly at the end of a long session. This is the **third** entry with this cause; the previous one already concluded *"it should be step 0"*. It was not, because the skill's own ordering still lists it eighth. A recommendation recorded twice and not acted on is a defect in the skill, not in the operator — the fix is to move the effort log to the top of §8, or to a §0. |
| `new-plugin-feature` | **partial — no path for a premise that dies mid-plan** | Steps 0–3 worked well; the research step surfaced that the intended data source's ToS §9.C forbids the crawling the whole feature assumed. The right answer was to abandon the plan and spike something smaller, which the skill has no route for: it goes Plan Mode → `ExitPlanMode` → file issues, and "the premise is now wrong" exits through none of them. Ended up leaving plan mode with a hand-written spike plan and never reaching Step 6. Worth a step: *if research invalidates the feature's premise, say so and stop — do not file the issues.* |
| `new-plugin-feature` | **worked — Step 3's research changed the plan's shape twice** | It established that idea-scout's agent prompts were *already* admin-editable via `_resolve_agent`, so requirement (a) was a missing UI rather than missing plumbing; and that a founder's "last used model" is derivable from their newest run, so the operator's sticky-choice decision needed no new per-founder state. Both would have been built the long way without the research step. |
| `build-plugin-feature` | **worked — and its review-the-diff step is the entire value** | Four defects in one milestone, all found by reading the change, none by a suite that was green at 26, 28 and 30 tests. The skill's claim that "a subagent reporting tests pass is not the same as the change being correct" was demonstrated four times in one build, including a button that would have destroyed a working prompt. |
| `build-plugin-feature` | **worked — Step 3.6, which I corrected earlier the same day** | The step used to say this session has no browser and should print a URL and stop. Rewritten to do the click-through, it immediately paid: the founder run form was observed with an **empty** model catalog before seeding, which verified the degradation path by accident of ordering, and then with a deliberately-seeded non-web-capable entry, which verified the filter rather than the render. Neither observation was available from tests. |
| `biffo-verify` | **worked — §1 was the entire value, three times** | Establishing current state before building overturned three of #643's five families, showed #715's named repos were already protected by hand (moving the issue from "fix these" to "nothing re-checks"), and showed #782 and #758 were already fixed. Four issues that would otherwise have been *built*. |
| `biffo-verify` | **worked — §3 gave the exact isolation** | On #889, reverting only the guard while keeping the model field produced `Failed: DID NOT RAISE HTTPException` on precisely the two guard tests. Reverting both gave 7 failures. That is what distinguishes "I wrote a test" from "this test defends the branch I added". |
| `biffo-verify` | **worked — §6 applied to my own new audit** | `protection-audit.sh` was fail-open on its first run, reporting `ok` for three unprotected branches because `gh` prints 404 bodies to stdout. Caught by reading every line, which is what §6 asks for. |
| `claude-in-chrome` | **worked — and it was the only instrument that could see the defects** | Four defects standing between an admin edit and a run were invisible to every gate in the estate; the browser found all four. It also produced the decisive artefact — the run's `definition_snapshot.instructions`, i.e. what the model was *actually sent* — which settled in one query what three merged milestones had asserted wrongly. Two operational notes: a stale bundle made a good deploy look broken until a hard reload (`index-BfpoZuPk.js` vs the server's `index-2mItIncF.js`), and the extension dropped mid-verification, which cost a reconnect. |
| `biffo-verify` | **partial — §8's effort log was not reached until the skill was invoked explicitly at the end** | Sections 1–7 were applied throughout and earned their keep (see *what went well*). §8 was applied for the scoreboard and the cost section, but the **effort log was never run**: three entries existed for 2026-07-30 and none was this session's. It was produced only when the operator typed `/biffo-verify` hours later. This is the second recorded instance of the same failure — the 45%-low entry has the identical cause — and it suggests §8's ordering is wrong: the effort log is listed after the narrative sections, so it is reached last and dropped first. **It should be step 0**, run when the unit of work ends, before the writing-up that is easy to defer. |
| `biffo-verify` | **worked — §6's "distrust a green check when the gate can fail open" was the whole session** | It produced an inventory of **20 unfixed fail-opens** (#956), two mechanisms (#957, #959) and two fixes (#960). The specific sentence that paid was *"ask where the check executes, not just what it asserts"* — applied to a substring guard, it showed the guard passed only because the file it checks happens never to mention the words it forbids. |
| `biffo-verify` | **worked — §6's "when a measurement surprises you, suspect the ruler first"**, three times | Each time the ruler was mine and each time it was wrong: a proposed lint measured at ~7% precision over 67 call sites; a claim that one CI job would catch three fail-opens that turned out to span three languages; and a backlog item already fixed since #852. All three would have shipped as confident work. |
| `biffo-verify` | **partial — §8 was again reached only when the operator typed the command** | Identical to the instance recorded above, and now the third occurrence. Sections 1–7 ran continuously and unprompted throughout; §8 did not, and the effort log was again the last thing standing. The previous entry proposed making the effort log step 0. That proposal was **not acted on**, and the same failure recurred the same day — which is itself the finding: a recorded fix to a skill that nobody applies is indistinguishable from not having recorded it. |
| `practices-standup` | **NOT INVOKED, and it should have been** | The session ran 1–3 hours of throughput work — exactly its purpose — but was driven from the backlog and from operator instructions rather than from the ranking, so its trigger (*"what hurt us most in the past 24 hours"*) never fired. Consequence: **no choice was recorded**, so tomorrow's Step 1 loop closure will find nothing to close. Recording one now would be worse than nothing, because the skill is explicit that a choice logged *after* building takes the post-fix value as its baseline and guarantees a false *did not move*. The defect is in the trigger: the skill only fires when someone asks "what hurt us", never when someone says "fix these". |
| `biffo-verify` | **worked — §8 caught that "all PRs merged" was not the same claim as "the change was distributed"** | Twelve satellite PRs merged; the thing that actually proved the rollout was `shared-sync --check` re-reading every repo (`13 current, 0 drifted`). The skill's §2 — *verify in the environment that differs most* — is what made me look for that second check rather than reporting the merges. |
| `biffo-verify` | **worked — §6's "confirm the search works before trusting an empty result"** | The prose-presence detector printed `*** MISSING` twelve times on the wrong resolution, which is what licensed reading its silence as evidence on the right one. Ordering made this hold by luck; a detector written after the fix would have had no such proof. |
| `clear_queue` | **partial — its per-PR loop assumes a PR is independent, and practices PRs are not** | Step 5 says merge once mergeable. For #907 and #905 that is wrong: both regenerate the same block, so merging either invalidates the other, and #905 had to be held back until #907 landed or it would have needed two rebases. The skill's "flag the ordering" note under *when to stop and ask* covers conflicting PRs, but frames it as an exception; here it is the normal case for a whole category of PR. |
| `clear_queue` | **worked — "rerun once, then investigate"** | `tabsii-crm`'s Playwright E2E failed on a one-file change to a *local* gate. Rather than rerun blindly I established the PR touches only `.biffo-shared-version` and `scripts/verify.sh`, and that CI never invokes `verify.sh` — so the change could not have caused it. Rerun went green. The log was unreadable (`log not found`, the documented self-hosted retention behaviour), so causality-from-the-diff was the only honest substitute. |
| `biffo-workflow` | **worked — 20+ PRs across 6 repos, no lost commits** | The unpiped push exit caught its own documented trap twice: an `echo $?` after a pipe read `0` for a push that had failed 128. The pre-push gate correctly refused nine pushes across two occasions (missing `web-admin`/`web` deps, then eight bare worktrees) — each refusal was right and each would have shipped as silence. |
| `biffo-sib-build` | **worked — Step 0.5 ("re-validate the plan's preconditions") repaid itself immediately** | The 0005 plan was three days old and wrong in four specifics: it named DDL module `047` (landed as `058`/`059`), said 0004 had *not* built the Object-Lock bucket (it had, so M5 reused it rather than building a second), gave the wrong intake page path, and cited `public_discovery.py` where `public_disclosure.py` was the fresher precedent. All four would have been discovered mid-build. The step exists because a plan ages fastest exactly where it says "X does not exist yet", and that was true here on the sentence about the bucket. |
| `biffo-sib-build` | **partial — its "delegate to a cheaper model" split is right, but says nothing about recovering a subagent that dies mid-task** | Step 1.5's division (subagent implements, this session reviews) held up: the CRM half came back correct and its report *flagged a genuine gap in the contract I had written*. But the core agent hit a provider session limit with work uncommitted, and the skill has no guidance for that — the instinct is to re-dispatch, which would have discarded a branch whose own failing test had just caught a real RLS bug. **The skill should say: read the dead agent's diff before deciding to re-run it.** Recovering it cost ~40 min and found a defect nobody else had. |
| `claude-in-chrome` | **worked — and again it was the only instrument that could see the defect** | Six defects in 0005 were invisible to 1,730 SQLite and 189 Postgres tests. The browser found the first (an IAM prefix) on the very first upload attempt of the walkthrough. One operational note worth recording: `localStorage` reads started throwing `SecurityError` after a tab was recreated, and the page had actually failed to load (`DNS_PROBE_FINISHED_NXDOMAIN`) — the JS error was a symptom of a dead document, not a permissions problem, and reading `document.body.innerText` was what disambiguated it. |
| `biffo-verify` | **partial — §8 was again not reached until invoked explicitly, third recorded instance** | Sections 1–7 ran throughout and earned their keep. §8 was written only when the operator typed `/biffo-verify` at the end of a ~7-hour session. The previous entry in this table proposed making the effort log **step 0**; that change has not been made, and the same failure has now happened again. At three occurrences this is no longer a lapse, it is the skill's ordering. |
| `/loop`, `/code-review` | **should have been used and were not** | Neither was invoked. `/code-review` in particular: this session shipped ~20 PRs, several self-reviewed only, and two carried reasoning that later proved wrong (the model-slug claim, the startup-hook premise). A second reader on the diff is precisely what catches an argument that is internally consistent and externally false. Missed because the work felt incremental — each PR small, the error only visible across them. |
| `biffo-workflow` | **worked — 7 PRs across 4 repos, no lost commits** | The unpiped push exit caught its own trap twice in one session: an `echo $?` after a pipe read `0` for a push that had failed 128, and the pre-push gate correctly refused two pushes whose worktree was missing `web-admin`/`web` deps. Both would have shipped as silence. |
| `biffo-verify` | **did NOT work — §1 was applied to the wrong repo** | "Establish current state first" was performed, thoroughly, against `biffo-plugin-idea-scout` — whose workflows genuinely contain no deploy step. The seeding mechanism lives in the *instance*. §1 says establish current state; it does not say **name the repo the answer would live in before looking**, and this session cost 1h 20m to that gap. The step needs that sentence. |
| `biffo-verify` | **should have been used and was not — §8, until the operator asked for it** | The cost record for this session was written only after *"WE NEED TO RECORD THIS AS TIME WASTED"*. §8 is step 0 of adding a row and it was not reached unprompted, which is the same failure the 45%-low effort entry already recorded: capture happens at the end, from memory, when someone asks. A trap nobody records is one the next session re-enters. |
| `biffo-workflow` | **worked — ~8 PRs, no lost commits** | Unpiped `PUSH EXIT` and the pre-push gate both fired on real problems. |
| Subagents (2 build, 2 scope) | **worked — and both scopers contradicted their own briefs** | Given read-only scoping briefs, both came back disputing the issues they were sent to plan: one found #643 family 5 false on both halves, the other found the issue's candidate list quantitatively wrong (lazy imports ceiling at ~0.25s against precompilation's ~2.5s). Briefing them to *verify first* rather than *plan* is what produced that. |
| `biffo-verify` | **worked — §7 is what made the revert possible** | Both dedup PRs carried an explicit "Verification not claimed: whether this reduces repeats is unknown until deployed and the comparison re-run". That sentence is why the measurement happened at all, and why a negative result was a planned outcome rather than an embarrassment. Under-claiming cost nothing and made the revert a decision rather than a retreat. |
| `biffo-verify` | **worked — §4, on a revert rather than a feature** | Confirmed in the deployed Lambda that pitches were gone, the cap was back to 50 and the prompt was restored. A revert is exactly the change nobody verifies, because it is "just putting things back". |
| `biffo-workflow` | **worked** | Four PRs across two repos in this loop, each rebased once for BEHIND, all landed by auto-merge with worktrees reaped. |
| `biffo-verify` | **worked — §8's ROI framing changed what got built** | Pricing the four residual gaps before building any of them killed one outright (0 violations in 165 commits) and reordered the rest. The skill's insistence on *numbers, not adjectives* is what made "decline this" a defensible answer rather than laziness. |
| `biffo-verify` | **worked — §2, again, and again it was the rollout that found it** | The `--no-cov` defect was invisible in the template and appeared the first time the gate ran in a repo whose pytest setup differed. Second time in one day that "reproduce by the reporter's route" meant "run it somewhere the assumption does not hold". |
| `biffo-workflow` | **worked — 6 PRs, no lost commits, one caught refusal** | Unpiped `PUSH EXIT` surfaced the gate legitimately refusing a push mid-rollout. Its §1 deps step remains the difference between the gate running and erroring. |
| `biffo-workflow` | **partial — step 7's `--auto` default is unavailable in two thirds of the estate** | The skill asserts "all five active Biffo repos now have `allow_auto_merge=true`", and warns that `--auto` degrades to an immediate merge when it is false. Measured across 13 satellites: **9 were false**. The assertion was true of the five repos it was written about and was never re-checked as the estate grew. Its own "confirm rather than assume" line is what caught it — the check was in the skill and paid for itself. |
| `biffo-verify` | **worked — §8's "check that your headline number can fail"** | Applied to this page's own tally: four contradictory copies of one table, none of which could fail anything. The section's fix was to delete the transcription step, not to recount. |
| `biffo-workflow` | **partial — commit bodies are shell-interpolated** | A backtick in a `-m` message silently ate a code snippet (`_out=$(cmd); _rc=$?` became blank), and a `"` -quoted `gh pr create --body` interpolated half a PR description into shell errors. The skill shows `-m "..."` throughout and never warns that message bodies containing backticks or `$(` need a heredoc or `-F`. Cost two amends. |
| `biffo-sib-build` | **worked** | Its "When to stop and ask" step is what caught M3's unbuildable design — the plan specified a filter that could not match, and the skill's instruction to redraft rather than improvise turned a silent-inert feature into an approved correction. That step earned the whole skill |
| `biffo-sib-build` | **partial** | Nothing in it sequences the plan's own E2E before the last milestone merges. Five milestones landed green; the browser then found four defects in an hour. The skill should require the testing plan's end-to-end check as a gate on the FINAL PR, not as an afterthought |
| `biffo-verify` | **worked** | §3 (prove the test fails) ran on every fix this session and caught two silent bugs inside one PR. §4 (verify the deployed artifact) caught a watcher reporting the wrong commit's deploy, which would otherwise have produced a fabricated defect report |
| `biffo-workflow` | **partial** | The `--delete-branch`-with-a-live-worktree trap hit **four more times**; the caveat sits after the command it invalidates. Separately: the masked-push trap it documents was walked into once (`| tail` reported exit 0 on a failed push) and caught only by re-running with the status visible |
| `claude-in-chrome` | **worked** | Found all four post-merge defects. Two viewport rescales mid-session caused coordinate drift and one mis-click; using `find` refs instead of coordinates was reliable and should be the default advice in the skill |
| `biffo-verify` | **worked — §8's ROI framing changed what got built** | Pricing the four residual gaps before building any of them killed one outright (0 violations in 165 commits) and reordered the rest. The skill's insistence on *numbers, not adjectives* is what made "decline this" a defensible answer rather than laziness. |
| `biffo-verify` | **worked — §2, again, and again it was the rollout that found it** | The `--no-cov` defect was invisible in the template and appeared the first time the gate ran in a repo whose pytest setup differed. Second time in one day that "reproduce by the reporter's route" meant "run it somewhere the assumption does not hold". |
| `biffo-workflow` | **worked — 6 PRs, no lost commits, one caught refusal** | Unpiped `PUSH EXIT` surfaced the gate legitimately refusing a push mid-rollout. Its §1 deps step remains the difference between the gate running and erroring. |
| `biffo-workflow` | **partial — commit bodies are shell-interpolated** | A backtick in a `-m` message silently ate a code snippet (`_out=$(cmd); _rc=$?` became blank), and a `"` -quoted `gh pr create --body` interpolated half a PR description into shell errors. The skill shows `-m "..."` throughout and never warns that message bodies containing backticks or `$(` need a heredoc or `-F`. Cost two amends. |
| `biffo-sib-build` | **worked** | Its "When to stop and ask" step is what caught M3's unbuildable design — the plan specified a filter that could not match, and the skill's instruction to redraft rather than improvise turned a silent-inert feature into an approved correction. That step earned the whole skill |
| `biffo-sib-build` | **partial** | Nothing in it sequences the plan's own E2E before the last milestone merges. Five milestones landed green; the browser then found four defects in an hour. The skill should require the testing plan's end-to-end check as a gate on the FINAL PR, not as an afterthought |
| `biffo-verify` | **worked** | §3 (prove the test fails) ran on every fix this session and caught two silent bugs inside one PR. §4 (verify the deployed artifact) caught a watcher reporting the wrong commit's deploy, which would otherwise have produced a fabricated defect report |
| `biffo-verify` | **worked — §6's "exercise _every_ path" is what paid** | On #743 the three stubs I expected to matter (garbage response, real advisory, clean response) confirmed what was already known. The fourth — clean payload, no `jq` on PATH — found a fail-open that had survived five issues in the file those issues hardened. §1 also killed the issue's own recommendation in two minutes: both premises it rested on had expired |
| `biffo-workflow` | **worked** | Unpiped `PUSH EXIT`, worktree with both `pnpm install` and `uv sync`, `hook-audit.sh` ARMED before any commit. The `-F`/`--body-file` warning in §3 was load-bearing: the commit body and PR body for #743 are almost entirely backticked command names |
| `biffo-workflow` | **partial** | The `--delete-branch`-with-a-live-worktree trap hit **four more times**; the caveat sits after the command it invalidates. Separately: the masked-push trap it documents was walked into once (`| tail` reported exit 0 on a failed push) and caught only by re-running with the status visible |
| `claude-in-chrome` | **worked** | Found all four post-merge defects. Two viewport rescales mid-session caused coordinate drift and one mis-click; using `find` refs instead of coordinates was reliable and should be the default advice in the skill |
| `new-plugin-feature` | **worked, and the research step was the whole value** | Steps 3–4 turned a plausible issue sketch into a different and better design: the issue proposed reading a title from client state, research found the server endpoint already had it. Also caught that the plan's own slug-collision check was broken — `gh search issues` returned unparseable output for a label that definitely exists, so the "no collision" answer was meaningless until re-run by listing labels per repo. |
| `build-plugin-feature` | **worked — the review-the-diff step is what earned it** | The skill insists the orchestrating session read the combined diff rather than the sub-agent's summary, "because a subagent reporting tests pass is not the same as the change being correct". That is precisely what happened: implementation correct, one test vacuous, caught before assembly. Without that step a fake test ships green. |
| `build-plugin-feature` | **partial — Step 3.6's local preview could not run as written, and the alternative it does not mention was available** | The step assumes a local preview is the way a human sees the UI, and documents fallbacks for when the backend cannot run locally. For this plugin none of them work. What it does not consider is looking at the *deployed* instance in a real browser — which was possible, and is what eventually validated the feature and found #83. |
| `biffo-workflow` | **worked — ~20 invocations, no lost commits** | Every change this session went through fresh-worktree → deps → honest unpiped push → CI-green squash-merge → reap. The `PUSH EXIT: ${PIPESTATUS[0]}` habit caught a real refusal (the gate blocking a `biffo-platform` upgrade push on stale deps) that a piped push would have reported as success. The step that earned the most was §1's "install dependencies in the new worktree" — it is the difference between the gate running and the gate erroring. |
| `biffo-workflow` | **partial — §7's cleanup assumes one repo, not fourteen** | Rolling one change across the estate means fourteen worktrees, fourteen branches and fourteen PRs. The skill's per-repo reap loop is correct and does not scale; I wrote a throwaway script three times before keeping one. An estate-wide rollout is a real workflow and the skill has no shape for it. |
| `biffo-verify` | **worked — §2 is the finding of the day** | "Reproduce by the reporter's route" is exactly what fourteen rollouts had skipped: everything was verified in `biffo-template`, the one layout where the bug could not appear. Running the gate once in a plugin repo exposed it in under a minute. The generalisation now in *What went well* — verify where the environment differs most — came straight out of this section. |
| `biffo-verify` | **worked — §6, and it applies to gates you wrote yourself** | "Distrust a green check when the gate can fail open" was written about dependency audits. It applies verbatim to this session's own gate: `verify passed` while checking nothing is the same shape. The section did not need extending; it needed applying to a tool I had just built. |
| `biffo-verify` | **missed — §8 was not run until asked** | Eight scoreboard-worthy findings accumulated across ~7 hours before the capture step ran, and only because the operator asked for it. The skill says "every unit of work"; the trigger that failed is that a long continuous session does not feel like a sequence of units. A prompt at merge time would have caught it. |
| `biffo-verify` | **worked — §1 and §2 were the whole value** | Three issues checked before building turned out already delivered (`ideation#20`, the idea-scout v1 epic, `platform#75`). A fourth, `ideation#69`, carried a diagnosis that could not be true. Nothing was built for any of them. Establishing current state is not a preamble to the task here — several times this session it **was** the task. |
| `biffo-verify` | **worked — §4, twice, and only §4 settled it** | "Verify the deployed artifact, not the source" was the only check that discriminated. Founder bundle: hash predicted before deploy, confirmed after. Admin bundle: built the source locally and matched the emitted hash to the one inside the deployed Lambda. Grepping identifiers failed (minified) and the old-asset control failed (403 after deploy) — both would otherwise have passed for evidence. |
| `biffo-workflow` | **failed — §4's honest-push rule was violated by the session quoting it** | The rule is stated plainly, I quoted it earlier in the session, then piped a push to filter a dependabot banner and reported `push: 0` on a failure. The skill says not to pipe; it does not say what to do about output there is a real reason to filter — which is precisely when the temptation arises. That gap is where it broke. |
| `biffo-workflow` | **partial — §2's dependency install is presented as hygiene and is load-bearing** | Skipping `pnpm install` in a worktree did not degrade a gate, it prevented the commit entirely (`lint-staged` missing), and the failure surfaced two steps later disguised as a push problem. The step reads as a nicety for gate accuracy; it is a precondition for committing at all. |
| `biffo-verify` | **worked** | §1 ("the work may already exist") is what caught the duplicate: `/analytics/speed` did not exist when checked, but another session built it *during* this one. Checking again before merging turned a conflicting PR into a closed one. §3 (prove the test fails first) ran twice and earned it twice |
| `biffo-workflow` | **worked** | Four PRs across three repos, no footguns hit that the skill did not warn about. Its `allow_auto_merge` check fired for real on tabsii-crm (`false`), where `--auto` errors outright rather than degrading — the warning was accurate and the repo list in the skill was not |
| `biffo-workflow` | **partial** | The `--delete-branch` + worktree ordering trap hit **three times in one session**. The skill documents it (§7, "remove the worktree first"), but the note sits after the merge command it invalidates, so the command is copied before the caveat is read. The remote branch also survives the failed delete and needs a separate `git push origin --delete`, which the skill does not mention |
| `claude-in-chrome` | **worked** | Found tabsii-crm#118, which four API-level checks had missed. Also produced a false alarm — a screenshot taken before the fetch resolved read as a defect — corrected by isolating the BFF and Core responses rather than re-screenshotting |
| **not used, should have been** | — | No skill covers *"a change is ready in the template — distribute it"*. `biffo core upgrade` was run from memory plus the mechanics note, and hit two undocumented snags (a detached-HEAD refusal, and the npx CLI failing to resolve its own packaged template root, needing `--template-repo`). That is skill-shaped and currently isn't one |
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
| `biffo-verify` | **worked** | §7 ("say what you did not verify") is the whole reason the RUNNER_LABEL defect was found. #809 shipped with an explicit *"no repository has been created against the real GitHub API"* note; that sentence is what turned into a live run, and the live run is what found a repo that could never merge a PR. Under-claiming did not just avoid an over-claim — it generated the next action. §4 ("verify the artifact, not the source") then mattered twice: the command reported protection configured, and only `gh api .../branches/dev/protection` showed *which* contexts, and only comparing them against the **pushed** `ci.yml` proved they matched. |
| `biffo-verify` | **partial** | §8 says record what it cost, but nothing in the skill prompts a **negative control** — §3 covers "prove the test fails without the fix" for a bug fix, and reads as not applying when you are adding a *feature*. Both negative controls this session were done from habit, not prompting, and one of them (the ordering test) would otherwise have shipped as a decoration. §3 should say it applies to any new assertion, not only to bug fixes. |
| `biffo-verify` | **worked** | §6 was the whole value on the last task. `publish-registry.yml` reports `success` whether it published or skipped — I wrote it that way — so verifying a newly-set token by its run conclusion would have proved nothing. §6's "what does this do when it cannot run?" is what turned the check into reading the step list instead. |
| `biffo-verify` | **worked** | §7 twice over. #809 shipped saying "no repository has been created against the real GitHub API"; that sentence became a live run, which found a repo where no PR could ever merge (#810). Under-claiming did not just avoid an over-claim — it named the next action. |
| `biffo-verify` | **partial** | §3 reads as bug-fix-only ("prove the test fails without the fix"), so nothing prompts a negative control when *adding a feature*. Three were done this session from habit; one — the set-label-before-push ordering test — would otherwise have shipped as a decoration, since the race it guards is usually won. §3 should say it applies to any new assertion. |
| `biffo-verify` | **worked** | §1 ("establish the current state before writing anything") applied to *my own* prior output. It surfaced that a claim written into #798 hours earlier — 35 branches "indistinguishable from unlanded work; no safe rule touches them" — was false: one git command proved 32 of 34 fully contained. Without §1 the sweep would have been re-run on the same wrong premise and stopped at the same place. |
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
| `biffo-verify` | **worked** | §1 was the highest-return step of the session: ten open tabsii issues checked against the code found **four already complete** and three materially misdescribed. #244's work had shipped in core 0.152.0 — confirmed from the deploy log (`Running upgrade 0011 -> 0010`), not the tree. |
| `biffo-verify` | **worked** | §3 caught a guard asserting the wrong thing: `whoami`'s "scoped by the caller" test checked bound *parameters* and passed with the entire `WHERE ura.user_id = :uid` deleted — on a BYPASSRLS session where that clause is the only scoping. Now asserts the statement; 3 of 4 mutations fail, the fourth deliberately delegated to the Postgres file. |
| `biffo-verify` | **partial — §1 is written about tickets, and the expensive miss was about the machine** | "Establish current state" was applied to ten issues and never to the claim *"this environment cannot run Postgres"*. That came from `id -nG` in a long-running shell, which reports the process's inherited groups, not the user's. It was repeated in a memory entry, used to justify ~7 CI round trips, written into a scoreboard row, and turned into a recommendation the user knew was wrong. `getent group docker` would have settled it at any point. The step should say: **a claim about your own tooling needs the same evidence as a claim about the code.** |
| `biffo-workflow` | **worked** | Invoked deliberately after two sessions of recording "should have been invoked". Step 6's guard check caught that `.github/` is template-owned **before** the push, so the `Core-Divergence:` trailer was added in the same commit rather than after a rejected CI run — the commit-time hook did not fire, and only running `sh scripts/biffo.sh check ownership` by hand surfaced it. |
| `biffo-workflow` | **partial** | Step 4 says confirm the remote has your commit, and `git log origin/<branch> -1` satisfies it while proving nothing about the tree. A `git commit --amend -F msg.txt` with nothing staged then sent CI a byte-identical broken file, and the repeated failure read as "the fix did not work". The step should name the content check (`git show origin/<branch>:<path>`), because the failure it guards against is exactly a changed message over an unchanged tree. |
| `biffo-workflow` | **worked** | Step 7's `--auto` warning earned its place in the negative: `RLS (real Postgres)` was not yet a *required* context, so `--auto` would have merged a PR with the lane red. Disabling auto-merge by hand and waiting was the right call, and the durable fix (making it required) came from the same reasoning the step already contains. |
| `biffo-verify` | **worked — §3 was the whole value, and §7 was the honest half** | Reverting the implementation and keeping the tests turned four assertions into four *demonstrations*, one of which printed the leak itself (`assert 'founder-pro...never-appear' not in "BEGIN (impl...,)"`). §7 then did the unglamorous part: the PR says plainly that nothing is verified on a deployed instance and that 365 days of already-written transcripts are untouched, rather than letting a merged security fix imply the exposure is closed. |
| `biffo-verify` | **partial — §8 has no step for checking a *delegated* result's scope** | The sub-agent's claims were all true and its patch was still too narrow: it fixed the one engine that was reported, leaving three without `hide_parameters`, including the one running `CREATE ROLE … PASSWORD`. Every §1–§7 step is about verifying assertions; none prompts *"what did this agent not look at?"*. Re-deriving the scope independently is what found the other three, and the skill should say so where it discusses trusting agent output. |
| `biffo-workflow` | **worked** | §9's ownership boundary was load-bearing rather than procedural. The sub-agent hit the core-ownership guard in `biffo-platform`, correctly read it as "this belongs upstream", and stopped with the patch posted on the issue instead of routing around a guard on a security fix — which would have produced a fix the next `biffo core upgrade` silently reverted. |
| `biffo-verify` | **worked** | §1 on tabsii-crm#52 found the stated blocker hid an unblocked half: the invite already knew the role and scope and published neither, so the payload work needed no SES at all. The issue had been read as "waiting on email infrastructure" for three weeks. |
| `biffo-verify` | **worked** | §3 twice on assertions that are easy to write vacuously — the E2E security claim (proven by injecting `brand_id` into the wizard's POST) and the invite's declared-vs-emitted field guard (proven by declaring a field that is never sent). Both would have passed against the bug they name if written the obvious way. |
| `biffo-verify` | **partial — §1 still does not cover claims about your own environment** | Recorded last session after the `id -nG` misread; it recurred within hours with `ProductionAccessEnabled` aliased to a jq key named `sandbox`. Both were correct data read under a self-chosen label that inverted the meaning, and both propagated into advice before being caught. The step says "establish the current state" and is written entirely about tickets and code. It needs a sentence about assertions you are about to make about the machine, the account, or the settings. |
| `biffo-workflow` | **should have been invoked** | Followed by hand for tabsii-crm#116 and tabsii-platform#286 — fresh worktrees, deps synced, remote content verified, guards run. It held, but Step 7's `--auto` guidance would have caught `tabsii-crm`'s `allow_auto_merge=false` *before* arming a merge that was rejected outright; the skill explicitly says to confirm that setting rather than assume it. Missed because the work read as "write tests", not "land a change" — the same trigger-wording gap recorded twice before. |
| `biffo-verify` | **worked — §4 was decisive in a way the skill does not yet advertise** | §4 is written for the stale-deploy theory. Here it solved a different problem: the post-deploy log count was zero, but only 2 invocations had run and neither touched the DB, so zero proved nothing. Downloading the deployed Lambda and reading four files out of it — plus `get-function-configuration` confirming `BIFFO_SQL_ECHO` unset — gave evidence independent of traffic. The step should also say: **use this when you cannot generate the conditions to observe the fix.** |
| `biffo-verify` | **partial — §3's "fails for the RIGHT reason" caught my own weak proof, but only because I re-read it** | The first revert made all 6 new reaper tests fail with `AttributeError: no attribute 'agent_run_unclaimed_after_seconds'` — proving the *setting* was absent, not that the behaviour was wrong. Redone with the setting present and only the reap logic reverted, 5 failed behaviourally (`assert [] == ['cb12204b-…']`) and 1 passed, revealing it as a drift guard rather than a detector. §3 says "the right reason" but gives no worked example of a *wrong* right-reason; this is one, and it is the common shape when a fix adds config. |
| `biffo-verify` | **partial — the Never list needs "never quote a config value as a measurement"** | "365-day retention" and "135 lines" and "complete agent transcripts" were all repeated from a sub-agent without measurement; actual values were ~7 days, 7,772 lines, and max 1,345 chars. The existing *"absence of evidence is not evidence"* rule covers empty results but not **confidently wrong non-empty ones**, which is what a paginated `length()` and a retention ceiling both produce. |
| `biffo-workflow` | **partial — Step 7's auto-merge caveat is now confirmed, and the step should stop recommending it alone** | tabsii-platform#284: all six required checks green, auto-merge armed at 10:51, and it sat at `BEHIND` for ~28 minutes doing nothing. Merged only after a manual `gh pr update-branch`, which forced a full CI re-run first. The step already flags this as H1's likely refutation — it is now **observed**, so the wording should lead with "arm auto-merge *and* expect to update the branch by hand", or the experiment should be closed and a merge queue pursued. |
| `biffo-verify` | **worked — §7 was the whole value this time** | The live #661 result looked like success and §7's "say what you did not verify" forced the base-rate check that showed it wasn't evidence (6 of 8 pre-fix chains also produced one run). The same step kept three separate claims apart in the write-up: key **observed**, index **inferred from a green migration**, prevention **not demonstrated**. Under-claiming cost nothing; the issue stayed open and honest. |
| `biffo-verify` | **worked** | §4 again, on a question it is not advertised for: after the upgrade I read the *deployed Lambda package* for all four pieces rather than trusting the deploy's green. §5 then salvaged the token work — eight tokens returning 403 read as "all dead" until `read_network_requests` showed the portal calls the API Gateway host directly, not `dev.biffo.io/api/v1`. |
| `biffo-verify` | **partial — the Never list still has no rule for "a signal that answers a different question"** | Three instances in one session: a paginated `length(events)` (57x undercount), a retention *ceiling* read as a data description, and now a **version bump attributed to my own PR when it was another session's release**. All three are confidently wrong non-empty answers, which the existing *absence of evidence is not evidence* rule does not cover. A fourth rule is earned: **verify the artifact carries your change, not that something changed.** |
| `biffo-workflow` | **worked** | §9's distribution ordering, applied predictively rather than after a failure: a new deploy gate + a stale vendored manifest = a red instance, so the sequence was plugin → vendored resync → core upgrade. Also caught myself writing `Closes #661` on a PR whose own body said the issue must stay open — amended to `Refs`, force-pushed, and verified the remote no longer carries the keyword. The closing-keyword trap is already on this page in both directions. |
| `biffo-verify` | **worked — §4 and §2 together, and they are not the same check** | §4 (verify the deployed artifact) confirmed `web-admin/dist` shipped with real assets. The page was still blank. §2 (reproduce by the reporter's route) is what found it — loading the page and reading the network log. Recording this because §4 is the more *tempting* check: it is fast, scriptable, and produces a satisfying green. It answers "did it ship?", never "does it work?". Both defects today sat in that gap. |
| `biffo-verify` | **worked — §7 stopped two premature "done" claims** | After lap 1 I could have reported both features shipped: the artifact carried them, the migration applied, the tests were green. Saying instead which of the three claims I had actually verified — and that the admin UI had **not** been loaded in a browser — is what led to loading it, which is what found the blank page. Under-claiming cost nothing and bought the finding. |
| `biffo-verify` | **partial — nothing in §3 covers a change that cannot be reverted to test** | §3's "prove the test fails without the fix" worked for the code fixes. It has no advice for the two defects that only exist *deployed*: reverting the Vite `base` locally proves nothing until a build and a page load. I ended up rebuilding and re-reading `dist/index.html`, which is the right move but is not in the skill. A sub-step — *for build-time config, assert on the build output, not the source* — would generalise. |
| `biffo-workflow` | **worked** | §1's freshly-fetched worktree and the parity checks caught nothing dramatic, but the resync discipline (`diff -rq` + a sorted `jq` diff against source, every time) is what let me fold #39 into #100's branch with confidence rather than opening a third lap. |



| `biffo-sib-imp` | **worked** | Three plans (`0005`, `0006`, `0007`) from PRD rows. Step 2's "read the target repo's actual current code" is what turned each one from prose into something buildable — `0005` found the tables already live and unexposed rather than missing, `0006` found `Lead` still settable through generic CRUD (which decided trigger-vs-application capture), `0007` found `core-manifest.json` made the approved design unimplementable as written. All three findings changed the plan *before* code. |
| `biffo-sib-build` | **partial** | Executed `0007` end to end, 9 PRs. But its Step 2 says "implement exactly what the milestone describes", and two milestones could not be: M5's timeline could not use generic CRUD (`make_list_handler` takes no filters) and M4's consumer could not be a plugin without touching template-owned registration. The skill's "when to stop and ask" list covers *"the plan's approach doesn't work against the real code"* — correct trigger, but it reads as an escalation gate when the honest action for a contained change is "do it and flag it loudly in the PR". Worth distinguishing a design change (ask) from a mechanism change (flag). |
| `biffo-verify` | **worked** | Invoked on a suspected regression. §2 ("reproduce, don't theorise") killed four successive theories — scope matching, tenant seam, trigger exclusion, deploy ordering — none of which survived contact with the live system. §Never ("absence of evidence is not evidence") is what forced reading the actual run history instead of a metric, which found the real bug in one call. §3 then caught that the corrected test genuinely fails without the fix. |
| `biffo-verify` | **should have been invoked sooner** | It was run at the *end*, after the build. Two of the four scoreboard rows above (the self-proving fixture, the metric attribution) were live the whole time and would have been caught by §2/§Never on the first "is this working?" question rather than the last. The trigger list is debugging-shaped; a *verification* step inside a build is the same discipline and does not read as a match. |
| `biffo-verify` | **worked** | §4 ("verify the deployed artifact, not the source") cracked this in one step: unzipping the plugin-host Lambda and grepping for `effective` returned zero hits, proving the deployed code predated the merged fix. §2's warning about 401-vs-CDN also stopped a wrong conclusion — `GET /admin/effective-config` returns `{"message":"Unauthorized"}` to a plain browser navigation whether or not the route exists, so the endpoint check proved nothing and the artifact check proved everything. |
| `biffo-verify` | **worked** | §7 ("never close an issue you have not seen fixed by the route it was reported on") is the whole finding. #58 had been closed on merge; reopening it with the artifact evidence is what turned "already fixed, user must be wrong" into a real, still-open defect. |
| `biffo-workflow` | **partial** | Step 1 says `pnpm install` in the new worktree. In a vendored plugin's `web-admin/` that **succeeds and installs nothing** — no error, no `node_modules`, and the failure only surfaces later as `sh: 1: vitest: not found` at test time. It needs `pnpm install --ignore-workspace`, which is recorded in the core-upgrade notes but not in the step that tells you to run it. |
| `biffo-workflow` | **worked** | Two changes across two repos, start → merged → reaped, including the honest-push check. Auto-merge did what Step 7 promises: #101 landed without a single rebase. |

| `biffo-verify` | **partial** | §1 ("establish the current state") was applied to the *issue* and not to the *source tree*. The first resync for platform#104 was rsynced from a primary checkout still on `316fecb`, missing both plugin PRs, and produced an empty diff that reads exactly like "already resynced". §1 says never branch from a stale local ref; it does not say **never copy from one**, and the copy case has no honest-push equivalent to catch it. Worth a line in the step. |
| `biffo-verify` | **worked** | §2 stopped a wrong filing: the challenger's stored row looked inert because `service.run_chat_turn` passes `system_prompt` and `model` into the adapter. Reading the adapter showed it sends neither — Core resolves both from the registration — so the row IS authoritative and the real defect is two dead parameters. An issue was about to be raised on the wrong premise. |
| `biffo-verify` | **worked — §1 is the reason a security issue got de-escalated instead of "fixed"** | "Establish the current state before writing anything", applied to an issue's *framing* rather than to whether the work existed. `biffo-platform-app#4` said authorization bypass; three server-side layers already enforced and the exposure was an inert 428-byte shell. §1 usually reads as "check whether someone already did it"; this is the other half — **check whether the defect is what the ticket says it is**, which is worth adding to the step. |
| `biffo-verify` | **worked — §4, on the half that keeps being skipped** | Artifact inspection said the admin UI shipped; the page was blank. This session the check became two: hash **matched against a prediction stated before the deploy**, then **fetch the served bundle and grep it for the change**, with the previous bundle as a control. §4 as written stops at "is the deployed artifact what I think"; the second step — *does the deployed artifact contain the change* — is where both of today's deploy defects hid. |
| `biffo-verify` | **failed — §8 did not fire at all until the operator asked, twice in one day** | Six findings from ~2h20m of work sat unrecorded. §8 hangs off "when you finish the task", and this session had no finishes: every unit ended with the operator handing over the next one. The trigger is bound to an event the work never produced. The operator had already corrected this the same day (~14:00, "was that effort logged? that is pretty dire") and the behaviour returned within three hours, so it is the default rather than a lapse. **Not a personal slip:** 5 of 26 effort entries logged today (19%) were reconstructed after the fact, 4 of them marked `MISSED UNIT, logged retrospectively` by other sessions. |
| `biffo-verify` | **partial — the Never list needs a rule about compressed artefacts** | "Never treat absence of evidence as evidence" is there, and I still ran `strings \| grep` over a **zip** and reported it clean. A saved Terraform plan contains the full state; the live GitHub App private key was inside. The existing rule is about *empty search results*; this is about **a search that cannot see**. Proposed: *decompress before you scan, or say you did not scan.* |
| `biffo-workflow` | **worked** | §9's resync discipline, three times in one session, each with `diff -rq` plus a sorted `jq` diff against source before committing. It is also what surfaced #58 sitting undeployed for a day — the parity check found `effective_config.py` missing entirely, which no other step would have reported. |


| `biffo-verify` | **worked** | §7 held the line under pressure to declare victory. `:online` was set, the deploy was green and the artifact verified — every signal said done. §7's "never close an issue you have not seen fixed by the route it was reported on" is why an actual session was run, and why the report's URLs were resolved rather than read. Without it the claim would have been "search is working" on the strength of a config change. |
| `biffo-verify` | **partial** | §8's cadence assumes the write-up is the last act. Here the practices PR merged **before** the fix was verified, the issues were filed, or the E2E run happened, so the log was complete-looking and missing its best finding. The step needs a "if verification is still outstanding, the write-up is not finished" clause. |
| `biffo-verify` | **partial** | §1–§7 worked well mid-task; **§8 did not, and the skill's shape is why.** Its "When to use" framing is debugging-shaped ("is this actually fixed?", "why is this failing?"), so it reads as something you invoke *once, about an incident* — and §8 then runs as a closing sweep over whatever is still in working memory. Five rows were captured that way and three were missed, all from earlier in the session; the operator had to ask before they were found. §8 already contains the fix in its own words for the effort log ("run it when you finish the task", "one entry per unit of work") but states it only there. **The step should say plainly: write the scoreboard row when the failure happens, not at the end** — and the trigger list should include "a failure just cost you 30 minutes", which is a mid-task event, not a session-end one. |
| `biffo-sib-build` | **partial — step 2.6 is the one that mattered and the one I skipped** | Steps 1–5 worked cleanly for four milestones across two repos. Step 2.6 says *"a green CI run is not sufficient evidence a deployed feature actually works… confirm the deployed behavior directly"*. I verified the deploy **succeeded** (workflow conclusion, plus the `ddl-import` payload showing modules 048/049 in `applied` with `ok: true`) and read that as satisfying the step. It does not: the artefact deployed and the feature was dead. Two blocking defects then survived three further merges. The wording is correct; what it lacks is a concrete bar — *"load the page as a user"* rather than *"confirm the deployed behavior"*, which a diligent reader can satisfy with logs. |
| `biffo-sib-build` | **partial — no notion of a plan that has gone stale** | The plan's decision 3 shipped speed-to-lead as a proxy "because `lead_activities` was never built". It had been built the day before by `0007` — which step 0 (read the plan) cannot notice, and step 2 explicitly says not to re-litigate approved scope. Surfacing it to the operator was right and the skill did not prompt it. Worth a line: *check the plan's stated preconditions still hold* — plans age fastest exactly where they say "X does not exist yet". |
| `claude-in-chrome` | **worked — it was the entire verification** | Four PRs, green CI in two repos including Playwright, and the deployed feature 100% broken. One page load found a 500; a second found an unstyled panel. It also produced *positive* evidence no test could: moving one lead made the funnel read `Qualified 1` while time-in-stage held `New 0` — the synthesised-vs-observed asymmetry demonstrated on live data. Caveat on my own use: I read the funnel from a **zoomed screenshot** and inferred `Discovery Day = 6` as "5 pre-existing + mine" from the board's counts rather than querying, so that decomposition is inference, not measurement. |
| `biffo-verify` | **worked — §4, and it killed a wrong theory in one query** | The panel's `Internal Server Error` had an obvious and wrong explanation (bad deploy / stale bundle). §4 said read the deployed artefact: CloudWatch returned the exact `ResponseValidationError` with `'input': []`, the file and the line. §5 applies too — the browser showed a generic banner because six calls run under `Promise.all` and the rejected one is not named. Neither would have come from reading the source. |
| `biffo-verify` | **partial — §8 applied as a closing sweep again, and again only by prompt** | The section says record the row when the failure happens; both defects were found, fixed, merged and deployed before anything was written here, and the write-up happened because the operator asked. That is the **third consecutive session** logging that §8 fired late, and the previous two recorded the same cause. A section that keeps diagnosing its own non-use and does not change is evidence the *trigger* is wrong: §8 needs to fire on "a defect was found", not on "the session is ending". |

| `biffo-sib-build` | **partial** | Step 0 requires the plan committed at `docs/implementation/<feature>/README.md`; ours existed only in the planning scratchpad, so the first unit of work was landing the doc — correct, but the skill reads as though that is always already true. Step 2's per-milestone loop worked well across five milestones. Its single-repo scope (`gh repo view` on the CWD) is unstated and mattered: this plan spanned four repos, and the CRM/intake halves needed their own runs. |
| `biffo-workflow` | **worked** | Twelve PRs across four repos, every worktree reaped. Step 4's honest-push discipline mattered once when a rebase needed `--force-with-lease` and re-verification; Step 7's `allow_auto_merge` pre-check mattered twice — `tabsii-crm` and `tabsii-intake` both have it **false**, so `--auto` would have merged immediately rather than queueing, exactly the trap the step warns about. Both were merged by hand after checks went green. |
| `biffo-verify` | **worked** | §1 alone saved ~40 minutes by finding [#277](https://github.com/tabsii-com/tabsii-platform/pull/277) had already built the non-superuser RLS harness this session was about to rebuild. §7 kept two PR bodies honest about what a green check did and did not prove. |
| `biffo-verify` | **partial** | §3 ("prove the test fails without the fix") could not be applied to the new RLS tests: doing so would mean shipping a commit that disables row-level security, and there is no local PostgreSQL (no Docker daemon) to do it against. The guard-the-guard tests are the structural substitute, but the step has no guidance for "the fix is a database policy" — where reverting it is not a local edit. Worth a sentence. |
| `claude-in-chrome` | **worked** | The only thing that verified any of this. Five milestones were confirmed by the route a user takes — including the 404 that both test suites reported green, and the agent-written score row appearing on the right lead. A skill-free session would have shipped M1 broken. |
| `biffo-workflow` | **should have been invoked for the plan doc** | The implementation plan was written straight into the planning scratchpad and only landed in-repo when `biffo-sib-build` refused to proceed without it. Nothing was lost, but the plan is a repo artefact from the moment it is agreed, and treating it as one unit of work from the start would have been cleaner. |
| `biffo-verify` | **worked — applied retroactively, §4/§5 in spirit** | Comparing the deployed API response and rendered UI directly (not reading `assignment.py` in isolation) is what found the territory_id gap on tabsii-platform#291 — the source alone reads as correct, since the value does flow through the function. |
| `biffo-workflow` | **partial — the recurring `dev`-staleness/auto-merge race hit again** | Same shape already on this page: ~9 PRs this session (tabsii-platform#348, #354, #355, #356 among them) needed a manual `--auto` re-arm after `gh pr merge` reported "not up to date with base branch". Reinforces the existing finding rather than adding a new one — worth downgrading from "known gap" to "expect this every time, script around it". |
| `biffo-sib-build` | **worked — Step 0.5 is the step that earns the skill** | On `0004-fdd-disclosure`, re-validating the plan's stated preconditions caught that its cited RLS-test template (`test_discovery_rls_pg.py`) was not merged and was sitting **red** in an open PR. A merged sibling was used as the pattern instead. Cost: two `ls`/`gh` calls. Step 0.5 also correctly found nothing else stale, which is the outcome that makes the cheap ones worth running. |
| `biffo-sib-build` | **partial — "one PR per milestone" does not survive a cross-repo milestone** | Step 2 assumes a milestone maps to one PR. M4 (platform + intake page) and M5 (core reads + CRM panel) each needed **two PRs in two repos**, with a merge-order constraint between them that the skill has no concept of. Ordering was written into the PR bodies as prose; the CRM merged first anyway and shipped a panel that errored (biffo-template#903). The skill needs a cross-repo milestone shape, or an explicit "core first, then the surface" step. |
| `biffo-sib-build` | **partial — the plan's own M5 was unbuildable as written** | M5 required per-lead disclosure state in the UI, but M1 had deliberately given `FddAcknowledgement` no generic CRUD and no read endpoint was ever specified — so there was no API to render it from. The skill's "stop and ask" step covers a milestone whose *approach* fails against real code; this was a milestone with a **missing dependency the plan never enumerated**. Adding the endpoint was the obvious call, but the skill offers no guidance on whether that counts as executing the plan or amending it. |
| Subagents (7 build across 3 repos) | **worked — but every one of the three real defects was found in review, not by the agent** | Each agent tested thoroughly, proved its negatives bite, and reported honestly — including flagging the `audit_logs` schema constraint and the date-vs-datetime difference rather than papering over them. What they could not do is doubt a premise they were handed: the wrong `?brand_id=` contract was implemented faithfully, pinned by its own tests, and *implemented by its own E2E fixture*. Delegation scaled the building; it did not scale the doubting. |
| `claude-in-chrome` | **worked — and was the only way to run the candidate journey** | The acknowledgement path has no authenticated caller by design (the token *is* the authority), so the browser was the genuine route. `read_network_requests` confirmed the deployed page called the deployed public route unauthenticated. One friction: network tracking only starts when the tool is first called, so the first page load's requests were missed and the page had to be reloaded. |
| `biffo-verify` | **worked — §4 caught a feature that was merged, applied, and absent** | Reading the deployed artefact rather than the source is what revealed the Lambda was serving pre-merge code while its API Gateway routes existed. §5 ("read past the layer masking the truth") is what made it legible: the 404's *message* distinguished "route absent" from "handler ran" when the status code could not. |
| `biffo-verify` | **worked — §4 was the whole of the verification, and §6 caught my own weak probe** | Five demo-feedback fixes across three repos, all merged and deployed with green CI, which §4 correctly treats as worth nothing. Unzipping `tabsii-platform-dev-core-api` showed `MarketplaceApplyRequest` carrying `postcode`/`phone`/`consent_to_contact`; grepping the deployed Next chunks showed `apply-postcode` and the `signin` fix's unique markers. Separately, §6's *"what would make this fail?"* is what exposed that my first `#28` probe matched `replace(` and could not fail — the scoreboard row above exists because the skill's own question was asked of an ad-hoc command rather than of a CI gate. |
| `biffo-verify` | **partial — §8 fired on operator prompt for the fourth consecutive session** | Previous three entries each recorded §8 arriving as a closing sweep rather than at the moment of the finding, and each named the trigger as the cause. This session the pattern was identical: five issues found, fixed, merged, deployed and verified, and nothing was written here until the operator typed `/biffo-verify`. **A section that has now diagnosed its own non-use four times running is not going to be fixed by a fifth diagnosis.** The specific defect is that §8's triggers are all *states* ("cost >30 min", "a gap you noticed") which require someone to stop and self-assess, and every one of the four misses happened while the session still had work queued. Either the skill needs an explicit "before reporting completion to the operator, write §8" step in the flow other skills already run, or `biffo-workflow`'s merge step needs to prompt it — the failure is consistently at the *seam between finishing work and reporting it*, which is a place a checklist can actually sit. |
| `biffo-verify` | **worked — §4 caught a third, differently-shaped case of the same class** | Landing tabsii-platform#399, the merge, CI and PR page were all green; only unzipping the deployed core Lambda (§4's exact technique) showed the new module absent, 21 hours after merge, because its own `Deploy Application` run had failed and nothing retried or alerted. Filed as [#973](https://github.com/keiranholloway/biffo-template/issues/973), reinforcing [#903](https://github.com/keiranholloway/biffo-template/issues/903). §8 again arrived only once the operator typed `/biffo-verify` — same seam the row above already names, so recorded here rather than argued as a fifth instance of that finding. |

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
