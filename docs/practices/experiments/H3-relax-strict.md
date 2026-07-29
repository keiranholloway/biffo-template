# H3 — relaxing `strict` removes the race without breaking `dev`

**Status:** `running`
**Pre-registered:** 2026-07-28, **before** `strict` was turned off
**Amended:** 2026-07-28 — counter-metric extended to cover silent content loss,
which the original could not see. Adds a way to refute; removes none. See
[Amendment](#amendment--2026-07-28-hours-after-pre-registration).
**Review on:** 2026-08-11 (14 days)

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

By **2026-08-11**, on a 7-day window, for `keiranholloway/biffo-template`:

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

## Falsification

**Refuted if `racedShare` is still above 8% on 2026-08-11** with at least 50
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
  They are not separable in the 2026-08-11 reading. This is a real weakness and
  is the price of H1 having been abandoned rather than completed.
- **Volume is not stable.** All primary metrics are rates or per-PR.

## Interim observation — 2026-07-28, day 0

**Not a result.** The review date is 2026-08-11 and the prediction is on a 7-day
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

_To be completed on 2026-08-11. Verdict: `confirmed` / `refuted` /
`inconclusive` / `abandoned`. A refuted hypothesis gets the change rolled back,
not quietly kept because it felt better — and the counter-metric can refute it on
its own, whatever the primary metric says._
