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
| [#671](https://github.com/keiranholloway/biffo-template/issues/671) | `scripts/biffo.sh` execs `npx @biffo/cli@$(biffo.core.json .version)`, so an unpublished core version reds **every guard on every instance**. npm publish has been failing (E404 on PUT) since 0.131.0 — the upgrade PR's own version bump is what breaks its guards, so it can never go green | **boundary** · visibility | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template (npm token + `publish-cli.yml`) | **open** — hard blocker, needs credentials |
| [#670](https://github.com/keiranholloway/biffo-template/issues/670) | Core migration 0010 does `batch_alter_table("users")`, assuming a Core-owned `public.users` in the instance's Alembic chain. tabsii's users are DDL-imported as `tabsii.users`, so the migration raises `NoSuchTableError` and takes 4 smoke tests with it | **drift** | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template `migrations/` | **open** — declined in tabsii ([#244](https://github.com/tabsii-com/tabsii-platform/issues/244)) |
| [#668](https://github.com/keiranholloway/biffo-template/issues/668) | ADR-0022 discovery runs *after* `build_core_crud_router()`, and importing a domain is what registers its models — so relocating a domain silently drops every `/api/v1/data/` route its models back. **21 routes vanished in tabsii with the full suite green (1712 passed)**; no test builds the app the way `main.py` does, so none could have failed | **visibility** · boundary | tabsii-platform [#243](https://github.com/tabsii-com/tabsii-platform/pull/243) | biffo-template `main.py` + `routing/domain_router.py` | **open** — instance reordered locally as a stopgap |
| — | `build_core_crud_router()` returns **zero** routes when called a second time (the first call consumes the registry). A guard test written for #668 compared the assembled app against a freshly-rebuilt router, so its expected set was empty and it passed against the exact bug it guarded | **fail-open** | tabsii-platform [#246](https://github.com/tabsii-com/tabsii-platform/pull/246) | biffo-template (make idempotent or document); instance test hardened to a golden list | **unfiled** |
| [tabsii#252](https://github.com/tabsii-com/tabsii-platform/issues/252) | Two events ship with no `fields` and no `payload_model` while emitting a real payload, so the workflow builder's dropdowns are empty. The guard credited with preventing this (#546) does not iterate `registered_events()` at all — no test asserts field-metadata *coverage*, here or in the template | **fail-open** · drift | tabsii-platform (found closing #221) | biffo-template `services/api/tests` | **open** |
| — | Five template-owned files diverged **undeclared** across a whole core upgrade. The instance's tests checked each declaration was valid but never that the declared set and `core diff`'s modified set *agree*, so undeclared divergence was invisible governance — the guard hard-blocked those files with no recorded reason | **visibility** | tabsii-platform [#250](https://github.com/tabsii-com/tabsii-platform/pull/250) | tabsii-platform (ratchet added); biffo-template could emit the delta from `core diff` | **fixed** in the instance |
| — | `biffo core diff` emits human-prose only. Consumers hand-parse it, and a parse that silently drops a line under-reports divergence — one did exactly that here, reporting 4 undeclared files when the answer was 5, caught only because the section header's own count disagreed | **visibility** | tabsii-platform revalidation | biffo-template `cli` (a `--json` mode) | **unfiled** |
| [#666](https://github.com/keiranholloway/biffo-template/pull/666) | Template tests asserted **ambient process state** — an empty write-back registry, and whichever identity provider happened to be installed. Both are properties only a bare template has, so 14 tests were green upstream and red the moment they were distributed | **drift** · fail-open | tabsii-platform [#241](https://github.com/tabsii-com/tabsii-platform/pull/241) | biffo-template `services/api/tests` | **fixed** ([#666](https://github.com/keiranholloway/biffo-template/pull/666)) |
| — | [#665](https://github.com/keiranholloway/biffo-template/pull/665) was written, reviewed, merged and **wrong** — it pinned the *default* identity provider, which reads `public.users`, a table the instance also lacks. It was never run against the instance it existed to unblock; [#666](https://github.com/keiranholloway/biffo-template/pull/666) corrects it | **process** | biffo-template | biffo-template | **fixed** — verify a distribution fix *against the distribution* |

### What the classes say

**fail-open is the dominant shape** — three of the five filed issues. A dependency
audit that exits 0 when the registry is broken, a skeleton lockfile no gate
audits, a CDN that turns 404 into 200. Each was individually reasonable; together
they mean *a green pipeline is not evidence that a check ran*. That is the single
most valuable lesson on this page, and it generalises: **when adding a gate, decide
explicitly what it does when it cannot run, and make "inconclusive" a distinct,
visible outcome from "passed".**

**boundary and drift are both ownership failures.** #652 is two ADRs claiming one
URL prefix; #621 is one concept with two implementations. Neither is a coding
mistake — both are two correct designs meeting with nobody owning the seam.

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

Tallying the filed issues above by the repo that must change:

| Repo | Fixes landing here | Notes |
| --- | --- | --- |
| **biffo-template** | 10 of 11 | Core API, CI, CDN module, skeletons, repo settings, ADR-0022 seam, event-registry guard, `core diff` output |
| **biffo-platform** | 2 of 11 | Shares #647 and #652 — the instantiated infra (API Gateway routes, CDN) |
| **tabsii-platform** | 1 of 11 | The divergence-coverage ratchet; every other tabsii-surfaced defect fixes upstream |
| **biffo-plugin-ideation** | **0 of 11** | Where two were *reported*; where none were *fixed* |

**The most actionable number here is still the zero — and it now has company.**
Six of these eleven were surfaced by `tabsii-platform`, and exactly one is fixed
there. The Ideation figure was the first evidence; tabsii is the second, larger
sample, and it says the same thing.

The original case: a user hit `Failed to load catalog: Unexpected token '<'` in
the Ideation admin UI, and it was two platform defects stacked — a routing
collision (#652) producing a 404, and a CDN rule (#647) disguising that 404 as a
successful HTML response. The plugin was correct throughout.

Two consequences worth internalising:

- **Bug reports are attributed to where they are seen, not where they live.** Time
  spent hardening plugins would not have prevented either defect.
- **A plugin can be blocked by a defect it cannot fix.** #652 has no workaround
  inside `biffo-plugin-ideation` — Core exposes no non-colliding path for plugin
  table CRUD — so the plugin can only wait. Platform defects are throughput
  blockers for everything downstream, and should be priced accordingly.

**What changed with this sample:** the instance repos are not just where defects
*appear*, they are where the template's untested seams get exercised for the
first time. ADR-0022, the ownership guard and the event registry were all green in
`biffo-template` and all broke on first real instance use. An instance is the
template's integration test, and currently the only one.

---

## Skills used

Skills are meant to be iterated, and they cannot be iterated on impressions.
Every session that invokes one records it here, honestly: **worked** (followed as
written, produced the intended result), **partial** (useful, but required
deviation or workaround), or **failed** (did not achieve the goal, or misled).

For anything not **worked**, the *why* is the whole value — the specific step
that misfired, not a verdict.

| Skill | Outcome | Notes |
| --- | --- | --- |
| `biffo-workflow` | **partial** | Followed for six PRs; the worktree/verify/honest-push steps all held. Step 7 (`gh pr merge --squash`) assumes you can win the up-to-date race: `dev` was taking a merge every 3–5 min against a ~2.5 min CI cycle, so the branch was `BEHIND` on every attempt and four rebases lost it. Fixed by enabling repo auto-merge; **the skill still documents the losing manual path** and should gain an auto-merge step. |
| `claude-in-chrome` | **worked** | The only way the reported bug reproduced. `curl` returned clean `401` JSON and looked healthy — the HTML only appears on an *authenticated* request, because 401 passes the CDN untouched while 403/404 are rewritten. An unauthenticated check would have concluded "works fine" and closed #647 unfound. |
| `biffo-verify` | **worked** | Written mid-session, then used on #652: its §1 "establish current state first" is what caught that the planned step 3 would have collapsed ADR-0014 §7's deliberate two-axis authorization boundary. |

### What the outcomes say

The one **partial** is not a documentation nit. `biffo-workflow` encoded a merge
step that silently assumed a quiet integration branch, and the cost only appeared
under concurrency — four wasted rebase cycles on a single PR before the real fix
(a repo setting) was even considered. **A skill that works alone and fails under
concurrency reads as user error until someone tallies it**, which is the argument
for this table existing.

## What went well — practices that earned their keep

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

**Unit-green is routinely mistaken for working.** AGENTS.md §4 already says this,
citing #275. It recurred: #659's tests prove `require_principal` in isolation, and
prove nothing about a deployed request, because no route uses it yet. The habit
worth building is stating what was *not* verified, in the PR, every time.

**Deactivation coverage is still unproven end to end.** #655 fixes the gap at the
dependency level with tests. Nobody has suspended a real Cognito user in `dev` and
replayed a plugin-forwarded call. Until that happens, #621 should not close.

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

## Skills used

Skills cannot be iterated on impressions. Every invocation, with an honest outcome.

| Skill | Outcome | Detail |
| --- | --- | --- |
| `biffo-workflow` | **worked** | Seven changes across two repos, start → merged → worktree reaped. The honest-push and remote-verify steps mattered once: a rebase onto a mid-flight core upgrade needed `--force-with-lease` and re-verification, and the step's insistence on re-checking the remote caught that the PR body's numbers were now stale. |
| `biffo-workflow` | **partial** | Step 3's commit example does not mention that a `Core-Divergence:`/`Core-Convergence:` trailer must fit commitlint's 100-character footer limit *and* stay on one line for the guard's anchored regex. Two commits were rejected after the hooks had run. Worth one line in the step. |
| `biffo-verify` | **worked** | §3 ("prove the test fails without the fix") caught a guard that passed against the bug it was written for, because its expected set was empty. Nothing else in the process would have found it — the test was green, the code was correct, and the assertion was vacuous. |
| `biffo-verify` | **should have been invoked sooner** | It was loaded at batch 4 of a five-batch relocation. Batch 3 is where 21 routes silently disappeared; the route-diff that caught them was improvised rather than prompted. The trigger wording is debugging-shaped ("investigating a bug", "green but broken"), so a *refactor* with a silent-regression risk does not read as a match. Worth adding refactors and relocations to the trigger list. |

## Adding a row

Add one when a defect costs more than ~30 minutes, or when you catch yourself
saying "how did that ever work?".

1. Add a scoreboard row: the failure *condition* (not the symptom), its class,
   where it surfaced, where the fix lands, and a link.
2. If the fix repo differs from the surfacing repo, say so — that gap is the
   point of the "where the work lands" table.
3. If a practice caught it, add it to *what went well* with the specific
   evidence. If a practice would have caught it, add it to *needs more thought*.
4. Record every **skill** you invoked in *Skills used*, with an honest outcome —
   and for anything not `worked`, the step that misfired. Also record a skill you
   *should* have used and did not, and why you missed it: a skill nobody invokes
   is indistinguishable from one that does not exist, and that is a fixable
   defect in the skill.

Keep entries falsifiable. "Testing could be better" helps nobody; "the audit gate
exits 0 when the registry returns non-JSON, so a green check does not mean the
audit ran" is something someone can act on.
