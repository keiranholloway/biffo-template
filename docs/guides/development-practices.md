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
| **biffo-template** | 5 of 5 | Core API, CI, CDN module, skeletons, repo settings |
| **biffo-platform** | 2 of 5 | Shares #647 and #652 — the instantiated infra (API Gateway routes, CDN) |
| **biffo-plugin-ideation** | **0 of 5** | Where two were *reported*; where none were *fixed* |

**The most actionable number here is that zero.** The Ideation admin UI is where a
user hit `Failed to load catalog: Unexpected token '<'`, and it turned out to be
two platform defects stacked: a routing collision (#652) producing a 404, and a
CDN rule (#647) disguising that 404 as a successful HTML response. The plugin was
correct throughout; its `model-catalog` handlers exist and its manifest is valid.

Two consequences worth internalising:

- **Bug reports are attributed to where they are seen, not where they live.** Time
  spent hardening plugins would not have prevented either defect.
- **A plugin can be blocked by a defect it cannot fix.** #652 has no workaround
  inside `biffo-plugin-ideation` — Core exposes no non-colliding path for plugin
  table CRUD — so the plugin can only wait. Platform defects are throughput
  blockers for everything downstream, and should be priced accordingly.

---

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

**Deactivation coverage is still unproven end to end.** #655 fixes the gap at the
dependency level with tests. Nobody has suspended a real Cognito user in `dev` and
replayed a plugin-forwarded call. Until that happens, #621 should not close.

---

## Adding a row

Add one when a defect costs more than ~30 minutes, or when you catch yourself
saying "how did that ever work?".

1. Add a scoreboard row: the failure *condition* (not the symptom), its class,
   where it surfaced, where the fix lands, and a link.
2. If the fix repo differs from the surfacing repo, say so — that gap is the
   point of the "where the work lands" table.
3. If a practice caught it, add it to *what went well* with the specific
   evidence. If a practice would have caught it, add it to *needs more thought*.

Keep entries falsifiable. "Testing could be better" helps nobody; "the audit gate
exits 0 when the registry returns non-JSON, so a green check does not mean the
audit ran" is something someone can act on.
