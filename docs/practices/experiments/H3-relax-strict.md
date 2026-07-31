# H3 — relaxing `strict` removes the race without breaking `dev`

**Status:** `running`
**Pre-registered:** 2026-07-28, **before** `strict` was turned off
**Amended:** 2026-07-28 — counter-metric extended to cover silent content loss,
which the original could not see. Adds a way to refute; removes none. See
[Amendment](#amendment--2026-07-28-hours-after-pre-registration).
**Extended:** 2026-07-31 — `tabsii-platform` joins the treatment arm, and the
content-loss counter-metric becomes measurable rather than anecdotal (#973).
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

`contention.staleMergeShare` (#973) now counts merges whose base moved between
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

**The one exception is a finding, not noise.** `tabsii-intake` has
`enforce_admins: false`, so branch protection does not bind the estate's only
admin: the gate is advisory there, and the metric caught a merge that genuinely
was not up to date. A counter-metric that only ever confirms the setting would
be worth little; this one disagreed with the setting and was right.

**The first version of this metric was wrong in a way its tests could not see**,
and the correction is the reason the table above is worth anything. It anchored
staleness to a PR's *first* green, which counts every rebased-and-re-greened PR
as stale — exactly what `strict` forces raced PRs to do. It scored
`tabsii-platform` at **44.7%** under `strict: true`, a value the gate makes
impossible by construction, and it moved *with* `racedShare` rather than against
it. Three unit tests passed throughout. Running the collector on live data and
asking whether the numbers were possible is what caught it.

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

## Result

_To be completed on 2026-08-04. Verdict: `confirmed` / `refuted` /
`inconclusive` / `abandoned`. A refuted hypothesis gets the change rolled back,
not quietly kept because it felt better — and the counter-metric can refute it on
its own, whatever the primary metric says._
