# Practices metrics — what is measured, and what each number cannot tell you

Companion to `docs/guides/development-practices.md`. That page records *what
broke*; this one records *how we know whether it is getting better*.

Every number here is produced by `scripts/practices-metrics.mjs` from git and the
GitHub API. Nothing is self-reported. That is deliberate: the agents doing the
work are the agents being measured, and a metric that depends on one of them
remembering to write it down measures diligence rather than the thing it names.

Run it:

```bash
node scripts/practices-metrics.mjs --window 90 --out docs/practices/data
```

Snapshots land in `docs/practices/data/<date>.json` and are committed. The time
series is version-controlled so it cannot be quietly revised after an experiment
disappoints.

---

## The one rule

**"Could not measure" is never reported as zero.**

This is the corpus's own dominant lesson applied to the instrument. A gate that
passes when it cannot run makes "green" and "checked" different things; a
collector that scores an unreadable repo 0% failures makes "clean" and "unknown"
different things in exactly the same way — and the unknown repo then drags every
aggregate toward looking healthy.

So every metric is either a number or `null`. `null` means *unmeasured* and is
excluded from aggregates rather than averaged in as a good result. Each repo
carries a `coverage` block giving the denominator its rates were computed on, so
a flattering number computed from three pull requests is visibly that.

---

## The headline triad

No single number is the target. These three move against each other, and an
improvement in one bought with a regression in another is not an improvement:

| Axis | Metric | Direction |
| --- | --- | --- |
| **Consistency** | `ciFailureRate` + `revisionsP50` | down |
| **Speed** | `cycleTimeP50Minutes` | down |
| **Contention** | `contention.greenButUnmergedHours` + `racedShare` | down |
| **Anti-goal** | `rework.medianHoursToRework` | **up** |

Speed alone is trivially gamed by merging faster and fixing later — the rework
lag is what catches that. Consistency alone is trivially gamed by taking longer
over everything — cycle time is what catches that. Report all three or none.

**Note the direction on the anti-goal: up is better.** A short lag means code is
being corrected almost as soon as it lands, which is churn. A long lag means the
defects being fixed are ones that genuinely took time to surface. It is the one
metric here where a rising number is the goal, and it is stated this way
deliberately — a dashboard where every arrow points down invites optimising the
set rather than the work.

---

## Consistency

### `ciFailureRate`

Percentage of merged PRs where at least one workflow run concluded `failure`,
`timed_out` or `startup_failure`.

**Cancelled runs are excluded** and counted separately. Almost every
cancellation here is a newer push superseding an in-flight run — ordinary
iteration, not a gate finding a defect. Folding them in would inflate the rate
every time someone pushes twice quickly, which the revisions metric already
measures properly.

*Does not capture:* failures on a branch that was never merged. Abandoned work is
invisible to every metric on this page.

*Gaming vector:* push less often and batch more per push. That would show up as
`revisionsP50` falling while PR size grows, so watch them together.

### `revisionsP50` / `revisionsP90` / `landedFirstPushRate`

Distinct head SHAs that received a CI run during the PR's lifetime, minus one.
`0` means the branch landed exactly as first pushed.

**This is separate from `ciFailureRate` on purpose, and the separation was forced
by the data.** biffo-template#691 pushed three SHAs and every run on all three
was green. A single "first-pass green" metric scores that PR a perfect 100%
while hiding three revisions and 29 minutes of churn. *Gates rejecting work* and
*humans guessing* are different problems with different fixes, and one number
cannot tell them apart.

*Does not capture:* revisions pushed before CI existed on the branch, or amended
commits that never ran.

*Matching caveat:* runs are attached to a PR by branch name, bounded by the PR's
own lifetime plus 24 hours. Branch names are reused in this project, so the time
window is what prevents one PR inheriting another's runs. A PR with no matching
runs reports `null`, not a clean score.

---

## Speed

### `cycleTimeP50Minutes` / `cycleTimeP90Minutes`

Minutes from PR open to PR merge.

*Does not capture:* everything before the PR existed. A change that took three
hours to write and two minutes to merge reads as two minutes. **This measures
the landing, not the work** — which is the correct scope for the process
questions this programme asks, but it means cycle time falling is not by itself
evidence that anything got faster overall.

*Gaming vector:* open the PR later. If cycle time falls while PR size or
revisions rise, that is what happened.

**Percentiles are nearest-rank**, not interpolated: an even-sized sample takes
the lower value. This matters for repos with very few PRs in the window — read
their `coverage.prsMeasured` before drawing anything from the number.

---

## The anti-goal

Two numbers, because one of them is robust and coarse and the other is precise
and conditional.

### `rework.fixShare`

Percentage of first-parent merges on the integration branch whose subject is a
`fix:` or `revert:`. No attribution required, so it cannot be *wrong*, only
coarse. It exists as a stable denominator to check the lag against.

*Known to under-count:* a correction merged as `refactor:` or `chore:` is
invisible.

### `rework.medianHoursToRework` / `p90HoursToRework` / `correctedWithin1hShare`

**The discriminating metric, and the one an experiment should move.** For each
`fix:`/`revert:` commit, `git blame` the exact pre-image lines it changed and
take the most recent prior authorship. That is the change being corrected, and
the gap is how long the defect survived.

A fix correcting code written an hour ago is a guess that shipped. A fix
correcting code from last week is ordinary defect discovery. **The rates cannot
tell those apart; the lag can.**

*Why not file-level overlap.* The first implementation counted a fix as rework
when it touched any file another commit had touched in the previous 7 days.
Measured against real history that filter removed **4 of 195** commits — on a
repo merging every ~12 minutes essentially every file is recently touched, so the
metric was `fixShare` in a disguise and its "lag" tracked merge cadence. The
spot-check was unambiguous: `fix(networking): sweep the VPC flow-logs group`
"correcting" `security(deps): override brace-expansion`, two unrelated changes
that shared a file. Moving to line-level attribution shifted the median from
**0.8h to 2.4h** and p90 from **18.2h to 63.6h** — the file-level version
understated lag roughly threefold.

*Deliberate exclusions, each of which would otherwise pull every lag toward the
last merge:*

- **Lockfiles** (`pnpm-lock.yaml`, `uv.lock`, …) are never blamed through. They
  are rewritten by nearly every change, so blame on one answers "who last touched
  the lockfile".
- **Pure insertions** are unattributable by construction — a hunk that only adds
  lines corrects no existing line. These lower `attributed` rather than counting
  as long-lag, which would flatter the number.
- **Diffs are taken at `-U0`.** With context lines the blamed range spills into
  untouched code and attributes the fix to whoever last edited the neighbourhood.

*Read `attributed` before the lag.* It is always below `fixMerges`, and that is
not a defect — but a lag computed from a handful of attributions is noise.

*Requires a local clone.* A repo without one reports `reworkSource:
"unavailable"` and every rework field `null` — never `0`.

---

## Contention — correct work that could not land

**Churn means the code was wrong. Contention means the code was right and lost
the race.** They need opposite fixes — one is about verifying before merging,
the other about how merges are sequenced — so they are never collapsed into one
number.

### `contention.greenButUnmergedHours`

Total time merged PRs spent green and unmerged. The headline, because it is the
only figure that expresses the cost as time rather than a ratio.

Baseline: **163 hours across 453 PRs** in biffo-template over 90 days.

### `contention.racedShare` / `repushRate`

`racedShare` — the share of PRs that were green for more than 10 minutes **and**
were repushed. Both conditions matter: a long wait alone is a PR nobody got to,
and a repush alone is ordinary iteration. Together they are the up-to-date race.

`repushRate` — share of PRs needing at least one repush.

### `greenToMergeP90Minutes` / `MaxMinutes` — and why no median

**Read the tail, never the median.** The first attempt to measure contention
used runner pickup latency (`run_started_at - created_at`), reported ~0, and
concluded there was none. It was wrong, and the median green-to-merge lag would
have been wrong the same way: it is **1.0 minute**, while p90 is **25.8m**, the
max is **15.7 hours**, and the total is 163 hours.

The ground truth that exposed it — recorded as a regression test — is PR #659:
opened 08:40:58, green at 08:41, merged 09:29:47 across **five head SHAs**. Four
rebases lost to the race, and the runner-queue metric scored it zero.

*What it does not capture:* PRs still open, and PRs closed without merging.
Both are excluded, so every figure here is a **lower bound**.

*Gaming vector:* merge red, or disable branch protection. Watch `ciFailureRate`
and the integration-branch health together with this.

*Interpretation.* Contention scales with merge rate into a shared branch, not
with the workflow itself. tabsii-crm scores **0%** raced against
biffo-template's **13.9%** — same rules, a quarter of the traffic.

## Trust in the gates

### `flakes`

Runs of the same workflow reaching two different verdicts on the **identical
commit**. A workflow that both passed and failed one SHA cannot have been
reacting to the code.

This number decides whether every other number on the page means anything: a
green check from a flaky gate is not evidence, and a `ciFailureRate` built from
flaky gates measures weather.

### `integration`

Health of the integration branch (`dev`), from `push`-event runs only — the ones
that block everybody.

- `failures` — red runs on the integration branch
- `redMinutes` — summed gap between a red run and the next green run of the same
  workflow
- `unresolvedFailures` — red runs never followed by a green one

**An unresolved failure is reported, not closed.** Silently treating a
never-recovered failure as instant recovery would make the worst case look like
the best case.

*Multiply by concurrency.* A red `dev` blocks every agent at once, so its cost is
not one agent's time — it is however many were working.

---

## Measured elsewhere

Two metrics from the Phase 0 plan are deliberately **not** in the collector:

- **Surfaced-in vs fixed-in gap** — which repo pays for a defect reported
  against another. GitHub does not know this; it comes from the Phase 1 evidence
  corpus, where each row already records both.
- **Repos touched per feature** — no reliable machine signal exists. Issue
  cross-references miss the cases that matter most, and time-clustering
  hallucinates connections. Recorded per-feature by hand instead.

Neither is estimated. A plausible number nobody can trace is worse than an
absent one — the corpus already has a row about confidently wrong diagnostics
costing more than absent ones.

---

## Cadence and cost

The programme is meta-work, and meta-work can eat the throughput it exists to
protect. So:

- Collection is a script on a schedule, never a ritual.
- Review is weekly, under a hard time cap.
- The programme's own cost is tracked like any other. If it exceeds what it
  saves, that is a finding, and the correct response is to cut it.

## Adding a metric

1. It must be derivable from git or the API without anyone remembering anything.
2. It must return `null` when it cannot be computed. If you cannot distinguish
   "zero" from "unknown", it is not ready.
3. Write down what it does **not** capture, and its gaming vector, here — before
   it is collected.
4. Add it to `cli/src/lib/practices-metrics.test.ts`, including a test that it
   reports `null` on an empty input.

A metric without a stated gaming vector will be gamed, and nobody will notice
because the number will look excellent while it happens.
