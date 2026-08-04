# H3 — relaxing `strict` removes the race without breaking `dev`

**Status:** `refuted`
**Pre-registered:** 2026-07-28, **before** `strict` was turned off
**Amended:** 2026-07-28 — counter-metric extended to cover silent content loss,
which the original could not see. Adds a way to refute; removes none. See
[Amendment](#amendment--2026-07-28-hours-after-pre-registration).
**Extended:** 2026-07-31 — `tabsii-platform` joins the treatment arm, and the
content-loss counter-metric becomes measurable rather than anecdotal (#977).
Adds no way to refute; removes none.
**Review on:** 2026-08-04 (**7 days** — cut from 14 on 2026-07-29, #850)

> Written and committed before the intervention, like [H1](./H1-merge-race.md)
> and [H2](./H2-merge-queue.md). A prediction written afterwards is a
> description, and it will always fit.

---

## Why there is an H3

[H1](./H1-merge-race.md) established that auto-merge does not update a head
branch that has fallen behind under `strict: true` — six occurrences across four
repositories, and a seventh on `#754`, the PR that documented the first six.
It named two next moves: a **merge queue**, or **relaxing `strict`**.

[H2](./H2-merge-queue.md) tried the first and found it unavailable on this
account: GitHub rejects the `merge_queue` ruleset rule, and the branch protection
UI offers no such option. That experiment never ran.

This is the remaining one. H1 called it "cheaper, weaker" and that framing is
kept honestly: it does not make merging *safer*, it removes a gate whose cost has
been measured and whose benefit has not.

## Claim

`strict: true` ("require branches to be up to date before merging") is what
creates the `BEHIND` state. Remove it and the race cannot occur: a PR that is
green merges, regardless of what landed on `dev` while its checks ran.

The gate exists to prevent a **semantic conflict** — two PRs that each pass alone
but break when combined. The wager is that this estate's semantic conflict rate
is low enough that the gate costs more than it saves.

That wager is exactly what the counter-metric below tests, and it is the reason
this experiment can fail even if its primary metric succeeds.

## Baseline — measured 2026-07-28, before the change

`scripts/practices-metrics.mjs --window 7`:

| | `keiranholloway/biffo-template` | comparator: `tabsii-com/tabsii-crm` |
| --- | --- | --- |
| merged PRs | 275 | 13 |
| **racedShare** | **16.0%** | 0% |
| repushRate | 43.6% | 7.7% |
| green-but-unmerged | 81.5h (**17.8 min/PR**) | 0.8h |
| greenToMergeP90Minutes | 22.3 | 11 |
| **integration failures on `dev`** | **0** (of 383 runs) | — |
| **integration red minutes** | **0** | — |
| ciFailureRate (per PR) | 12.7% | — |

## Intervention

Set `required_status_checks.strict = false` on `dev` in
`keiranholloway/biffo-template`, via the dedicated sub-endpoint rather than a
full `PUT` of the protection object — a full replace silently clears any field
omitted from the payload.

**Everything else is unchanged.** All five required status checks stay required,
`enforce_admins` stays on, force pushes and deletions stay disallowed, and PRs
are still required. The only thing removed is the requirement that a branch be
*up to date* — not the requirement that it be *green*.

## Prediction

By **2026-08-04**, on a 7-day window, for `keiranholloway/biffo-template`:

- **`racedShare` below 3%** (from 16.0%) — primary
- `repushRate` below 25% (from 43.6%) — secondary
- green-but-unmerged below 8 min/PR (from 17.8) — tertiary

The mechanism is direct rather than statistical: `racedShare` counts PRs that sat
green over ten minutes *and* were repushed, and the dominant cause of both here
is `gh pr update-branch` on a `BEHIND` PR. Removing `BEHIND` should remove most
of the metric. If it does not, the race had a cause nobody has identified, which
is itself worth knowing.

## Counter-metric — the entire risk of this change

Relaxing `strict` trades contention for the possibility of **untested
combinations landing on `dev`**. There is a direct measurement of exactly that,
and it currently sits at a perfect zero:

- **`integration.failures` on `dev`** — currently **0** of 383 runs over 7 days
- **`integration.redMinutes`** — currently **0**

**H3 is refuted if `integration.failures` exceeds 2, or `integration.redMinutes`
exceeds 60, in the review window — regardless of what `racedShare` does.**

The tolerance is deliberately tight. `AGENTS.md` treats a red integration branch
as blocking everyone and makes fixing it the next task, so "a few red minutes" is
not a cheap trade against saved developer waiting; it is the same cost moved onto
whoever pushes next.

Note the honest circularity: `integration.failures` is 0 **partly because
`strict` is on**. That is precisely why it is the right counter-metric — it
measures the thing the gate was buying, so its movement is the price of removing
it.

### Amendment — 2026-07-28, hours after pre-registration

**The counter-metric above was incomplete, and the gap is one this change makes
more likely rather than less.**

`integration.failures` and `redMinutes` only see failures that **redden the
build**. The dominant risk of relaxing `strict` turns out to include a failure
mode that never does: a branch rewriting a shared append-only file **wholesale
from a stale base**, which merges with no conflict, no failing check, and no
reviewer prompt. The practices corpus lost content this way three times in 24
hours — 18 scoreboard rows and 23 narrative entries in one incident — and every
one was found by a human noticing a count had gone down.

`strict` is precisely what forced a rebase before merge, and a rebase is what
would have surfaced that stale-base rewrite as a conflict. **Removing it removes
the barrier**, and the counter-metric as pre-registered would have reported H3
healthy throughout.

So the counter-metric gains a third condition, effective immediately:

- **A silent-content-loss incident** — a PR merging that deletes rows from
  `docs/practices/evidence.jsonl` or a table in `development-practices.md`
  without a `Practices-Removal:` trailer. **More than one in the review window
  refutes H3**, regardless of `racedShare` or `integration.failures`.

Two things about this amendment, recorded so it cannot be read charitably later:

1. **It only adds a way to refute, never removes one.** Every original condition
   stands unchanged. An amendment that loosened a threshold mid-flight would be
   worthless; this makes the experiment easier to fail, not harder.
2. **It was made before any result was known.** No reading has been taken since
   `strict` came off beyond five green `dev` runs. Amending after seeing the
   number would be indistinguishable from fitting the test to the answer.

A guard now fails a PR that shrinks either corpus (#778), so from today an
incident of this class should be *prevented* rather than merely counted. That
does not retire the condition — a guard that has never fired and a risk that
does not exist look identical, which is the mistake this whole file exists to
avoid.

### Extension — 2026-07-31, `tabsii-platform` joins the treatment arm

**Recorded before the numbers it will be judged on exist**, and against the
author's own interest: H3 is currently tracking toward *refuted*, so this extends
a treatment that may be rolled back on 2026-08-04.

Day 0 named the thread and did not pull it: *"`tabsii-platform` at 30% is the one
repo behaving as the theory predicts a `strict: true` repo should, which is a
thread worth pulling — it is also the busiest instance."* It has since become the
estate's single largest measured cost — **16.8h of 33.1h green-but-unmerged in
24 hours, 50.8% of the total** — so `strict` came off its `dev` on 2026-07-31 via
the same sub-endpoint, all six required checks unchanged.

Baseline at the moment of change, from the 2026-07-31 snapshot:

| | 24h | 7d |
| --- | ---: | ---: |
| `racedShare` | **47.2%** | 30.3% |
| `repushRate` | 52.8% | 43.0% |
| green-but-unmerged | 16.8h (n=36) | 101.1h (n=142) |
| `integration.failures` | **8** | 11 |
| `integration.redMinutes` | **111.7** | 175.2 |

**The counter-metric's central premise does not hold here, and that is the most
useful thing this extension contributes.** The original argued
`integration.failures` sits at zero *partly because `strict` is on*, which is why
its movement prices the gate. On `tabsii-platform` the gate was fully on and
`dev` still took **8 failures and 111.7 red minutes in one day** — already past
both thresholds (`>2`, `>60`) that would refute H3 on `biffo-template`. Whatever
was reddening that branch, `strict` was not preventing it. A gate charged 16.8h a
day whose stated benefit is already absent is the clearest case in the estate for
removing it.

Predicted by 2026-08-04, 7-day window, `tabsii-platform`: `racedShare` below 15%
(from 30.3%), `repushRate` below 30% (from 43.0%). Deliberately weaker than
`biffo-template`'s <3%, because that target has not been met and predicting it
again would be ignoring the estate's own reading.

**What this costs, stated plainly.** It spends the cleanest `strict: true`
observation in the estate four days before review — day 0's interim analysis
leans on `tabsii-platform` as the repo behaving as theory predicts, and that data
point stops accruing now. `tabsii-crm` remains the untouched comparator, so H3's
actual falsification test is intact, but the *interim narrative* is weaker and no
later reading should pretend otherwise. The rollback rule now covers two repos:
a refuted H3 turns `strict` back on for `tabsii-platform` as well.

### Amendment — 2026-07-31, the counter-metric becomes measurable

The 2026-07-28 amendment added silent content loss as a refuting condition and
left it detectable **only by a human noticing a count had gone down**. That is
not a measurement, and a condition nobody can evaluate is one that will read as
"did not occur" at review time.

`contention.staleMergeShare` (#977) now counts merges whose base moved between
the PR's first green and its merge — the population content loss is drawn from,
collected for every repo at no extra API cost. It **adds no refuting condition**;
the three above stand exactly as written. It makes the third one checkable
instead of anecdotal, and it establishes what the exposure was under `strict` so
the after-reading has something to be compared against.

Read it as **exposure, not damage**: most stale merges touch nothing in common.
A rise means the risk window widened, not that anything broke.

**Validated against the estate rather than only against its own unit tests**, on
2026-07-31, 7-day window — the check being that a metric of what `strict`
prevents must read ~0 wherever `strict` is on:

| repo | `strict` | stale | raced |
| --- | --- | ---: | ---: |
| biffo-template | **false** | **1.9%** | 12.3% |
| tabsii-platform | **false** (today) | **3.5%** | 30.6% |
| tabsii-crm, geo, marketplace, app, biffo-platform, both plugins | true | **0%** | 4–30% |
| tabsii-intake | true | 4.5% | 18.2% |

The two `strict: false` repos are the only ones carrying exposure, while
`strict: true` repos score zero against raced shares as high as 30% — so the
metric separates staleness from the race instead of restating it.

**The exceptions are a finding, not noise, and they change what this experiment
has been comparing.** Three `strict: true` repos show non-zero staleness
(`tabsii-intake`, `tabsii-geo`, `biffo-plugin-ideation`). The cause is
`enforce_admins: false` on **eleven of twelve estate repos**: protection does not
bind the estate's only admin anywhere except `biffo-template`, so `strict` is
advisory almost everywhere and the metric caught merges that genuinely were not
up to date. A counter-metric that only ever agreed with the settings would be
worth little; this one disagreed and was right.

**The confound that follows was never recorded, and it is H3's, not the
metric's.** `biffo-template` — the treatment repo — is the *one* repo where
branch protection actually binds. Its comparator `tabsii-crm` has
`enforce_admins: false`, and so does `tabsii-platform`, added to the treatment
arm today. So the pre-registered contrast was never purely `strict: false` vs
`strict: true`; it was partly *"bound"* vs *"advisory"*. This does not rescue or
sink the hypothesis, and it is recorded here rather than in the result so that it
cannot be discovered afterwards and used to explain away whichever verdict
arrives on 2026-08-04.

It also makes the Intervention section's claim that ``enforce_admins`` "stays on"
true of `biffo-template` and **false of the estate around it** — a sentence that
read as an estate-wide guarantee for three days.

**The first version of this metric was wrong in a way its tests could not see**,
and the correction is the reason the table above is worth anything. It anchored
staleness to a PR's *first* green, which counts every rebased-and-re-greened PR
as stale — exactly what `strict` forces raced PRs to do. It scored
`tabsii-platform` at **44.7%** under `strict: true`, a value the gate makes
impossible by construction, and it moved *with* `racedShare` rather than against
it. Three unit tests passed throughout. Running the collector on live data and
asking whether the numbers were possible is what caught it.

### Correction — 2026-07-31, the counter-metric was counting dead runners

**Most of `tabsii-platform`'s red was never a broken branch.** Diagnosing why it
kept `dev` red found that **all six** failures inspected had *zero failing steps*
and 3–21 steps left incomplete — runners killed mid-job, which GitHub concludes
`failure` rather than `cancelled` about half the time. Not one gate had rejected
a change.

`FAILING_CONCLUSIONS` already excluded `cancelled` for exactly this reason; it
simply did not cover the other label. Fixed in #982, validated against seven real
runs including a negative control.

What the counter-metric actually reads once dead runners are re-attributed:

| repo | before | after |
| --- | --- | --- |
| tabsii-platform, 24h | 8 failures / 111.7 min | **1 / 0** |
| tabsii-platform, 7d | 11 / 175.2 | **3 / 41.8** |
| biffo-template, 7d | 2 / 54.7 | **2 / 54.7 — unchanged** |

Three things this does *not* license, recorded so the Tuesday reading cannot
quietly help itself to them:

1. **It does not clear `tabsii-platform`.** Three genuine failures in 7 days is
   still above the `> 2` threshold. Only the red-minutes breach clears.
2. **It does not move the treatment repo.** `biffo-template`'s failures were
   real, so its 2 / 54.7 stands — still inside both thresholds and still close
   enough to either that one bad merge refutes. A correction that had rescued
   the author's own arm and nothing else would deserve much more suspicion than
   this one.
3. **It does not fix the deploys.** A killed deploy still leaves `dev` silently
   stale with no retry or alert — that is #973, unchanged. This stops the
   estate *mislabelling* it as a broken integration branch; it does not stop it
   happening.

## Falsification

**Refuted if `racedShare` is still above 8% on 2026-08-04** with at least 50
merged PRs in the window.

**Also refuted, independently of `racedShare`,** if `integration.failures` > 2 or
`integration.redMinutes` > 60. Declaring success on contention while `dev` starts
breaking is the failure this section exists to prevent.

**Also refuted** if more than one silent-content-loss incident occurs in the
window (see the amendment above). This is the condition the original
counter-metric could not see, and the one this intervention most plausibly
worsens.

**Inconclusive** if fewer than 50 PRs merge in the window.

**Most likely reason for refutation, stated in advance:** this estate runs many
concurrent agents editing overlapping files — this session alone had two PRs
(#747 and #748) touching the same functions in `core-migrations.ts`, one of which
needed a hand-resolved rebase. Textual conflicts are caught by git regardless of
`strict`, but *semantic* ones are not, and a repo with this much concurrent
editing of the same modules is where the gate is most likely to have been
earning its cost.

## Cost and reversibility

Minutes. **Fully reversible with one API call** —
`PATCH .../branches/dev/protection/required_status_checks {"strict": true}` — and
a full pre-change snapshot of the protection object is kept outside the repo for
the duration.

## Confounds acknowledged in advance

- **n=1, no control group.** Interrupted time series against a pre-registered
  prediction. Weaker than a controlled trial; say so when reporting.
- **`tabsii-crm` is a comparator, not a control.** It keeps `strict` and gets no
  change, deliberately. If its numbers move too, something estate-wide changed
  and this result is not attributable to the intervention.
- **The baseline window contains one day of auto-merge (H1's intervention).** Six
  of its seven days predate it. The effect is small and if anything flatters the
  baseline rather than the result.
- **Two interventions are now in force at once** — auto-merge from H1, and this.
  They are not separable in the 2026-08-04 reading. This is a real weakness and
  is the price of H1 having been abandoned rather than completed.
- **Volume is not stable.** All primary metrics are rates or per-PR.

## Interim observation — 2026-07-28, day 0

**Not a result.** The review date is 2026-08-04 and the prediction is on a 7-day
window; this is one day, most of which predates the intervention. It is recorded
because the numbers do **not** point the way the change's advocate (me) expected,
and an inconvenient early reading is exactly the thing that gets quietly dropped
if it is not written down when seen.

Measured with `node scripts/practices-metrics.mjs --windows 1`:

| repo | `strict` | `racedShare` | `repushRate` |
| --- | --- | --- | --- |
| **biffo-template** | **false** | **11.9%** | **26.9%** |
| biffo-platform | true | 13.3% | 26.7% |
| biffo-plugin-idea-scout | true | 12.5% | 12.5% |
| tabsii-platform | true | 30.0% | 36.7% |
| biffo-plugin-ideation | true | 0% | 14.3% |

Against the pre-registered targets for `biffo-template` (`racedShare` **<3%**,
`repushRate` **<25%**, from 16.0% / 43.6%):

- **`repushRate` has moved a long way** — 43.6% → 26.9%, just outside target.
- **`racedShare` has barely moved** — 16.0% → 11.9%, nowhere near <3%, and
  **statistically indistinguishable from two `strict: true` comparators**
  (biffo-platform 13.3%, idea-scout 12.5%).

If that holds for seven days it refutes the hypothesis as stated, and the
pre-registration already says what that means: *"the race had a cause nobody has
identified, which is itself worth knowing."* `tabsii-platform` at 30% is the one
repo behaving as the theory predicts a `strict: true` repo should, which is a
thread worth pulling — it is also the busiest instance.

### A correction to how this was nearly recorded

The first version of this observation was going to be an **anecdote**: on the day
`strict` came off, `biffo-template` took 44 merges and not one of my ~9 PRs there
went `BEHIND`, while the two instance PRs I merged both did. That reads as strong
support and it is worthless — a personal sample of nine, selected by which PRs I
happened to open, against a metric that says 11.9%.

Computing `racedShare` instead took one command and reversed the conclusion. The
lesson is not subtle and this page keeps relearning it: **a vivid sample is not a
measurement**, and the direction of the error was toward believing my own change
had worked.

### Caveats on these numbers specifically

- **One day, and `strict` came off partway through it.** The window contains PRs
  from both regimes; day 0 flatters neither side reliably.
- **`racedShare` counts "green >10 min *and* repushed".** A repush for any other
  reason — a review comment, a fix — counts identically. At small n that is noise.
- **The comparators are not controls.** Different repos, different workloads,
  different merge rates.

## Interim observation — 2026-07-29, day 1

Still not a result; the review date stands. Recorded because it points the same
way day 0 did, and because a second inconvenient reading is exactly the one that
gets dropped.

| `biffo-template` | baseline (2026-07-28) | prior 83d | 7d to 2026-07-29 | target |
| --- | ---: | ---: | ---: | ---: |
| **`racedShare`** | 16.0% | 16.7% | **13.8%** | **<3%** |
| `repushRate` | 43.6% | 45% | 39.2% | <25% |
| `ciFailureRate` | 12.7% | 11.6% | 10% | — |

Three points of movement against a prediction of thirteen, and the `prior 83d`
column — a window sharing no merge with the reading — confirms the baseline was
not a fluke.

**A competing explanation now exists and is pre-registered.**
[H4](./H4-shift-left-gates.md#amendment--2026-07-29-before-the-gate-merged-anywhere)
argues the race is driven by **repush volume**, not by `strict`: `racedShare`
counts PRs green over ten minutes *and repushed*, and `strict` never controlled
the repush. It predicts that a local pre-push gate moves `racedShare` below 8%
**with `strict` unchanged**.

If that happens, H3 is not merely refuted — it was measuring someone else's
mechanism. The operator called this before the data did, on 2026-07-29: *"it was
us treating the symptom not the root cause."*

Note the consequence for H3's rollback rule: if H4's amendment confirms, turning
`strict` back on is the *default* action for a refuted H3, and it should be done
rather than quietly skipped because the race improved for another reason.

## Interim observation — 2026-08-02, day 5

Two days before review. Recorded now, **before** the verdict, so the analysis
cannot be fitted to it — the same reason the 2026-07-28 amendment insists on.

| `biffo-template` | baseline (2026-07-28) | 7d to 2026-07-29 | **7d to 2026-08-02** | target |
| --- | ---: | ---: | ---: | ---: |
| **`racedShare`** | 16.0% | 13.8% | **7.8%** | **<3%** |
| `repushRate` | 43.6% | 39.2% | **23.8%** | <25% ✅ |
| green-but-unmerged | 17.8 min/PR | — | **11.0 min/PR** | <8 |
| merged PRs | 275 | — | **357** | — |
| **`integration.failures`** | 0 | — | **2** | refutes at **>2** |
| **`integration.redMinutes`** | 0 | — | **54.7** | refutes at **>60** |
| `runnerKills` / `failuresUnclassified` | — | — | **0 / 0** | — |

`racedShare` has more than halved under a **30% heavier merge load**, and
`repushRate` has **met** its target. The primary is still missing its <3%.

### The two `integration.failures` are attributed, and neither is a semantic conflict

The counter-metric exists to detect **untested combinations** — two changes that
each pass alone and break together, which is the only thing `strict` was buying.
Both failures were inspected at the log, not inferred:

1. **Run `30463621771`**, 2026-07-29, `CI` → *Terraform Validate & Security* →
   *Validate modules*. **Transient network.** `Failed to query available
   provider packages … could not connect to registry.terraform.io … read:
   connection reset by peer`, and the same against `releases.hashicorp.com` for
   the provider zip. Nothing to do with what merged; a docs-only commit could
   not have caused it.

2. **Run `30555489992`**, 2026-07-30, `Core Version Tag` → *Sync and audit
   core-v\<version\>*. **A release-pipeline ordering race.**
   `core-v0.190.1 points at a93bdbdc, which is not an ancestor of HEAD
   (387eae54)`. Verified after the fact: `a93bdbdc` is genuinely **not** an
   ancestor of `387eae54`, so the guard was right — and `a93bdbdc` **is** an
   ancestor of `dev` today, so the tag pointed at work that had not yet reached
   `dev` when the check ran. Adjacent to the `core.version` race class
   (#293/#294/#342/#423), not a code-level conflict.

**So the counter-metric stands at 2 of >2 and 54.7 of >60 — on two failures
`strict` could not have prevented.** That is the runner-kill trap
(`practices-metrics.mjs`, *"the experiment gets refuted for something it never
touched"*) recurring one level up: the classifier now excludes killed **runs**,
but nothing excludes failures whose **cause** is unrelated to the intervention.
Worth considering whether the counter-metric should require a failure to be
plausibly combination-shaped before it counts.

### The treatment arm is asymmetric, and pooling it would refute H3 on pre-intervention data

`tabsii-platform`, same 7-day window to 2026-08-02:

| | value |
| --- | ---: |
| merged PRs | 222 |
| `racedShare` | 27.9% |
| `repushRate` | 35.1% |
| green-but-unmerged | 46.4 min/PR |
| `integration.failures` | **16** (of which `runnerKills` **8**) |
| `integration.redMinutes` | **464.2** |

Read naively that refutes H3 7.7× over on red minutes alone. It should not be
read that way, for two independent reasons:

1. **The window is mostly pre-treatment for that repo.** `tabsii-platform`
   joined the arm on **2026-07-31**. A 7-day window ending 2026-08-02 is roughly
   **five days of `strict: true` and two of `strict: false`** — about 71% of it
   measures the regime H3 exists to replace, scored against H3.
2. **Half its failures are the class already excluded.** `runnerKills: 8` of 16.

Its 464 red minutes also include the 2026-08-02 deploy break — red at 10:43,
unnoticed for 1h53m, with four subsequent merges failing on damage they had not
caused (AGENTS.md §6). That is a **visibility** failure, not an untested
combination.

**Recommendation for the review:** judge H3 on `biffo-template` alone on
2026-08-04, and give `tabsii-platform` its own review on **2026-08-07**, seven
days after it actually joined. Scoring an intervention on days before it existed
is not a conservative reading, it is a wrong one.

### The partial-improvement case is undefined, and it is now the live case

The prediction is a bright line (`<3%`) on a continuous metric. The reading is
7.8% — from 16.0%, under heavier load, with one secondary target met and the
counter-metric intact. Nothing in this file says what to do with that, and the
rollback sentence in **Result** answers a different question: it governs a
**refuted** H3, and refutation here is defined **entirely on the counter-metric**
(*"regardless of what `racedShare` does"*).

So a missed prediction with an intact counter-metric is **not** refutation, and
reverting on it would discard a halved race for no measured safety gain. That
decision should be made explicitly on 2026-08-04 rather than by default.

One correction while here: the **8%** figure that circulates in the workflow
guidance as H3's failure threshold is **[H4](./H4-shift-left-gates.md)'s
prediction**, not H3's — H3 has no `racedShare` refutation clause at all. The
same guidance also carries the review date as 2026-08-11; it is **2026-08-04**.

> **This paragraph is wrong, and was corrected at review on 2026-08-04.** The
> [Falsification](#falsification) section *does* carry a `racedShare` clause —
> *"Refuted if `racedShare` is still above 8% on 2026-08-04 with at least 50
> merged PRs in the window"* — pre-registered on 2026-07-28, and H4 cites the
> same 8% as *"H3's own falsification threshold"*. Only the review-date half of
> the correction above was right.
>
> It changed no verdict: the reading came in at 4.4%, under 8% either way. But
> for four days this file contained two contradictory statements about its own
> refutation rule, and a result landing between 3% and 8% would have let a
> reviewer quote either one and appear to be citing the pre-registration. The
> pre-registered section governs; a later observation cannot amend it by
> asserting what it says.

## Result — 2026-08-04

**Verdict: `refuted`.**

Refuted on the **counter-metric**, on both of its conditions independently, exactly as
pre-registered: *"the counter-metric can refute it on its own, whatever the primary
metric says."*

### The reading — `keiranholloway/biffo-template`, 7d to 2026-08-04T04:35Z

`node scripts/practices-metrics.mjs --window 7 --repo keiranholloway/biffo-template`

| | baseline 2026-07-28 | day 5 | **2026-08-04** | target / line | |
| --- | ---: | ---: | ---: | ---: | :--- |
| merged PRs | 275 | 357 | **367** | >=50 | not inconclusive |
| **`racedShare`** | 16.0% | 7.8% | **4.4%** | <3% target / **>8% refutes** | missed target, **line not breached** |
| `repushRate` | 43.6% | 23.8% | **17.7%** | <25% | **met** |
| green-but-unmerged | 17.8 min/PR | 11.0 | **15.9 min/PR** | <8 | missed — see note |
| `staleMergeShare` | — | — | **6.3%** (23 merges) | exposure, not damage | rose from 1.9% |
| `ciFailureRate` | 12.7% | — | **9.0%** | — | |
| **`integration.failures`** | 0 | 2 | **3** | **>2 refutes** | **BREACHED** |
| **`integration.redMinutes`** | 0 | 54.7 | **99.5** | **>60 refutes** | **BREACHED** |
| `runnerKills` / `failuresUnclassified` | — | 0 / 0 | **0 / 0** | — | not a classification artefact |

**The comparator did not move, so the result is attributable.** `tabsii-crm`
(`strict: true`, untouched, the pre-registered control): 77 merged PRs,
`racedShare` **18.2%**, `repushRate` **46.8%**, `staleMergeShare` **0%**,
`integration.failures` **0**, `redMinutes` **0**. It sits almost exactly where
`biffo-template`'s own baseline was (16.0% / 43.6%), which is what the confounds
section asked for: *"If its numbers move too, something estate-wide changed and
this result is not attributable to the intervention."* It did not, so the
contention improvement is real and is the intervention's.

### Why it is refuted anyway, and why that is not being argued away

The three failures were each inspected at the log, not inferred:

1. **`30463621771`**, 2026-07-29, `CI` -> *Validate modules*. **Transient network** —
   `connection reset by peer` against `registry.terraform.io`.
2. **`30555489992`**, 2026-07-30, `Core Version Tag`. **Release-pipeline ordering race** —
   `core-v0.190.1` pointed at a commit not yet an ancestor of `dev`.
3. **`30847204581`**, 2026-08-03, `CI` -> *Dependency audit*. **Externally published
   advisories** (esbuild GHSA-g7r4-m6w7-qqqr, undici) landing mid-window; #1256
   records that nothing in the commit caused it.

**None is a semantic conflict.** The counter-metric exists to detect *untested
combinations* — two changes that pass alone and break together — which is the only
thing `strict` was buying. Zero of three are that shape. On the evidence, relaxing
`strict` did not cause a single integration failure in seven days.

**That does not rescue the hypothesis, and the reason is the point of this file.**
The day-5 observation raised exactly this — *"worth considering whether the
counter-metric should require a failure to be plausibly combination-shaped before
it counts"* — and **did not adopt it**. Adopting it now, after the numbers are
known, is indistinguishable from fitting the test to the answer. The 2026-07-28
amendment set the rule this file lives by: an amendment may only **add** ways to
refute, and must be made **before** the result is known. So the pre-registered
line stands, and H3 is refuted.

### Three defects in the instrument, recorded for the successor rather than used here

1. **The counter-metric is an absolute count on a repo whose volume grew 33%**
   (275 -> 367 merged PRs; 1,190 integration runs). "Confounds acknowledged in
   advance" states *"All primary metrics are rates or per-PR"* — the counter-metric
   is neither. A busier repo breaches `>2 failures` on ambient noise alone. The
   control's clean 0/0 came with **one fifth** the merge volume.
2. **It cannot distinguish integration risk from ambient CI noise.** Two of three
   failures were external events (a network reset, an upstream advisory
   publication) that no branch-protection setting can prevent.
3. **The tertiary metric is a mean dragged by outliers.** 15.9 min/PR against a
   `greenToMergeP50` of **0.3 minutes** and `P90` of **7.4 minutes** — the typical PR
   spends 18 seconds green-but-unmerged, and P90 is *inside* the <8 target. One PR
   sat 1,666 minutes. The pre-registration chose the mean, so the mean is scored;
   a successor should pre-register a percentile.

### A contradiction inside this document, found during the review

The **Falsification** section states: *"Refuted if `racedShare` is still above 8%
on 2026-08-04 with at least 50 merged PRs."* The day-5 observation states the
opposite: *"H3 has no `racedShare` refutation clause at all."* The Falsification
section is the pre-registered text and governs; H4 also cites 8% as *"H3's own
falsification threshold"*, so the day-5 sentence is simply wrong.

It changed nothing here — 4.4% is under 8% either way — but a review that had
landed between 3% and 8% would have had two contradictory rules in one file, and
whichever the reviewer quoted would have looked pre-registered. **The correction
is to the day-5 note, not to the Falsification section.**

### Rollback — DEFERRED by operator decision, 2026-08-04

> **`strict` remains `false` on `biffo-template`. The pre-registered rollback has
> NOT been executed.** Recorded here the same day, because the paragraphs below
> state that it was, and a result file that misdescribes the live configuration is
> worse than one with no result in it.
>
> **Verified live at the time of writing**, rather than assumed:
> `biffo-template` `strict = false` (5 required contexts intact),
> `tabsii-platform` `strict = false` (6 intact). Nothing else in either
> protection object was touched.
>
> **This is a deferral, not an override.** The decision is deliberately postponed
> to after **[H4](./H4-shift-left-gates.md)'s review on 2026-08-05**, because H4
> determines what the rollback costs:
>
> - **If H4 confirms** — the race is driven by repush volume and its local
>   pre-push gate holds `racedShare` under 8% with `strict` unchanged — then
>   restoring `strict` is close to free, and the pre-registered default should
>   simply be executed.
> - **If H4 refutes** — `strict` was genuinely suppressing the race — then
>   restoring it costs the full contention delta below for a benefit measured at
>   or near zero, and overriding the default becomes a real decision that must be
>   argued and recorded, not taken by silence.
>
> **The verdict is unchanged and is not reopened by this.** H3 is `refuted`. The
> counter-metric breached both lines, and no part of this deferral rewrites the
> rule after seeing the number — that remains the thing this file exists to
> prevent. What is deferred is the *action*, which the day-5 observation already
> said must be *"made explicitly on 2026-08-04 rather than by default"*.
>
> **The measured cost of rolling back**, from `biffo-template`'s own baseline
> rather than the comparator, so it is a within-repo comparison:
>
> | | now (`strict: false`) | baseline (`strict: true`) |
> | --- | ---: | ---: |
> | `racedShare` | 4.4% | 16.0% |
> | `repushRate` | 17.7% | 43.6% |
> | green-to-merge P90 | 7.4 min | 22.3 min |
>
> At the current rate of 367 merges/week that is roughly **43 more PRs hitting
> the race and ~95 more requiring a repush each week**.
>
> **A correction to this document's own attribution while deferring.** The Result
> above says none of the three failures is a semantic conflict. Two are
> unambiguous — a transient network reset and externally published advisories.
> The third, the `core-v0.190.1` tag ancestry failure, is a **merge-ordering**
> failure, and relaxing `strict` permits an ordering no PR was tested against, so
> it is at least plausibly connected. Day 5's attribution to the pre-existing
> `core.version` race class (#293/#294/#342/#423, all predating the experiment
> under `strict: true`) is retained, but the honest count is **two clearly
> unrelated and one arguable**, not zero of three. Stated because the deferral
> leans on that attribution, and a reason to hold should not be stronger than its
> evidence.
>
> **If no decision is recorded by the time H4's result lands, the pre-registered
> default stands and `strict` goes back on.** A deferral with no expiry is an
> override that never had to argue for itself.

#### The pre-registered rollback, for reference


Per the pre-registered rule — *"A refuted hypothesis gets the change rolled back,
not quietly kept because it felt better"* — `strict` returns to `true` on
`keiranholloway/biffo-template`:

```sh
gh api -X PATCH repos/keiranholloway/biffo-template/branches/dev/protection/required_status_checks \
  -f strict=true
```

**`tabsii-platform` is deliberately NOT rolled back today, and this supersedes the
Extension's "the rollback rule now covers two repos" only as to timing.** It joined
the arm on 2026-07-31; a 7-day window ending today is ~4 days pre-treatment. Day 5
already recorded the recommendation: *"give `tabsii-platform` its own review on
2026-08-07, seven days after it actually joined."* Rolling it back today would
destroy the only clean post-treatment window it has, on the strength of data
mostly collected before the treatment existed. Its 2026-08-04 reading, for the
record and **not as a verdict**: 220 merged PRs, `racedShare` 28.6%, `repushRate`
31.4%, `integration.failures` 16 (of which `runnerKills` **8**), `redMinutes` 517.2.

### What this leaves open

- **The race has a cause nobody has identified.** Pre-registration: *"If it does
  not, the race had a cause nobody has identified, which is itself worth knowing."*
  `racedShare` fell 16.0% -> 4.4% while the control stayed at 18.2%, so `strict`
  was clearly *a* cause — but the <3% prediction failed, and restoring `strict`
  predicts a return toward 16%. **H4 reviews 2026-08-05** and its amendment
  predicts `racedShare` below 8% from repush volume alone, with `strict`
  unchanged. If H4 confirms, this rollback is the correct default and H3 was
  measuring someone else's mechanism.
- **A successor needs a counter-metric that measures integration risk rather than
  CI weather** — combination-shaped failures only, expressed as a rate. That is a
  new pre-registration, not a retrofit of this one.
- **The cost that motivated #808 is unaddressed.** Restoring `strict` on the
  template restores a gate that, over seven days and 367 merges, prevented
  **zero** measured integration failures.
