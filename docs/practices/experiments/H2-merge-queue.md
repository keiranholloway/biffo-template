# H2 — a merge queue removes the race that auto-merge could not

**Status:** `abandoned` on 2026-07-28, **hours after pre-registration and before
the intervention was ever applied** — GitHub does not offer a merge queue on this
account. The experiment never ran. Superseded by [H3](./H3-relax-strict.md).
See [Result](#result).
**Pre-registered:** 2026-07-28, before the queue was enabled
**Review on:** ~~2026-08-11~~ — never reached; see Result

> Written and committed before the intervention, like [H1](./H1-merge-race.md).
> The ordering is the point: a prediction written afterwards is a description,
> and it will always fit.

---

## Why there is an H2 at all

H1 tested whether **auto-merge** removes the merge race. It named one specific
reason it might fail:

> It is *not established* that GitHub's auto-merge automatically updates a head
> branch that falls behind while `strict: true` is in force.

That reason turned out to be the actual behaviour, and H1's own file records
three instances across three repos on the day it landed. Three more occurred on
2026-07-28 — `biffo-template#747` once, and `biffo-template#750` **twice in the
same PR**, each needing a hand `gh pr update-branch` and a full CI re-run.

**Six occurrences, four repositories, zero cases where auto-merge updated a
behind branch.** That is no longer an open question about the mechanism.

H1 pre-registered exactly two next moves for this situation: a **merge queue**
(the purpose-built fix) or **relaxing `strict`** (cheaper, weaker). This is the
first.

## What happens to H1

**Verdict: `abandoned`, not `refuted`.** The distinction matters and is recorded
here so it cannot be softened later.

H1's prediction was `racedShare` below 5% by 2026-08-10. That prediction has
**not been tested**, and cannot now be, because enabling a merge queue changes
the intervention before the review date — the 2026-08-10 reading would measure a
mixture of two changes and attribute the result to whichever one the reader
preferred.

Abandoning it costs the evidence H1 was meant to produce. That is accepted
deliberately: the mechanism H1 warned about is confirmed six times over, and a
further twelve days of watching it recur would buy a number, not an insight.

**Auto-merge is kept, not rolled back.** H1's rule is that a refuted hypothesis
gets its change reverted; an abandoned one has no such verdict to act on.
Auto-merge is also a *prerequisite* here rather than a competing treatment —
`gh pr merge --auto` is how a PR enters a merge queue.

## The reading taken today, and why it proves nothing about H1

Measured 2026-07-28 with `scripts/practices-metrics.mjs --window 7`:

| | `keiranholloway/biffo-template` | H1's 7d baseline (2026-07-27) |
| --- | --- | --- |
| merged PRs | 275 | 257 |
| **racedShare** | **16.0%** | 13.2% |
| repushRate | 43.6% | 40.5% |
| green-but-unmerged | 81.5h (17.8 min/PR) | 72.4h (16.9 min/PR) |

**This is not a measurement of auto-merge's effect and must not be read as one.**
Auto-merge landed on 2026-07-27; six of this window's seven days predate it. The
window is contaminated, so these figures are essentially the baseline re-read one
day later. They are recorded because they are what H2's own baseline has to be,
not as evidence against H1.

The comparator is unchanged, which matters:

| `tabsii-com/tabsii-crm` (7d) | |
| --- | --- |
| merged PRs | 13 |
| racedShare | **0%** |
| repushRate | 7.7% |
| green-but-unmerged | 0.8h |

Same rules, a fraction of the traffic, and no race. Its stability across the same
period is what lets biffo-template's numbers be attributed to biffo-template
rather than to something estate-wide.

## Intervention

A **GitHub merge queue** on `biffo-template`'s `dev`.

A queue owns the thing auto-merge would not do: it builds each entry on top of
the current base, runs the required checks against *that*, and merges only if
they pass. A PR can no longer be `BEHIND` at merge time, because the queue
rebuilds it rather than asking a human to.

Two supporting changes, both already landed:

- **#752** — `ci.yml` reports the required checks for the `merge_group` event. A
  queue counts only checks reported for that event and does not inherit the PR's
  results, so without this the first queued PR would wait forever and block the
  repo behind it.
- **`strict: true` is turned off** on the branch protection when the queue is
  enabled. It is what forced the update-or-wait behaviour in the first place, and
  the queue subsumes it — every entry is tested against the current base by
  construction. Leaving both on would reintroduce H1's failure mode inside the
  queue.

## Prediction

By **2026-08-11**, on a 7-day window, for `keiranholloway/biffo-template`:

- **`racedShare` below 3%** (from 16.0%) — primary
- `repushRate` below 25% (from 43.6%) — secondary
- green-but-unmerged below 8 min/PR (from 17.8) — tertiary

`racedShare` stays the primary metric for the same reason H1 chose it: it is
normalised per PR, and this estate's volume is not stable enough for absolute
hours to mean anything.

## Counter-metric — the way this intervention could make things worse

A merge queue **serialises merges**. At ~37 merges a day against a ~2.5 minute
CI cycle, the queue itself can become the bottleneck: `racedShare` would fall to
near zero *by construction* — nothing is ever behind — while PRs simply wait
longer in a different place.

So this experiment is **not** judged on `racedShare` alone. It also tracks:

- **`greenToMergeP90Minutes`** — currently 22.3. If this rises above **35** while
  `racedShare` falls, the queue has moved the delay rather than removed it, and
  that counts as a **failure**, not a mixed result.
- **merged PRs in the window** — currently 275. A collapse below ~150 with
  unchanged activity means throughput was traded away.

Declaring success on the primary metric while the counter-metric worsened is the
exact failure this section exists to prevent. Recorded before the numbers exist.

## Falsification

**Refuted if `racedShare` is still above 8% on 2026-08-11** with at least 50
merged PRs in the window.

**Also refuted — regardless of `racedShare`** — if `greenToMergeP90Minutes`
exceeds 35, per the counter-metric above.

**Inconclusive** if fewer than 50 PRs merge in the window. The estate's volume is
spiky and a quiet fortnight cannot distinguish a working fix from an absent
problem.

**Stated in advance as the most likely reason for refutation:** GitHub's merge
queue batches entries, and a batch that fails is dissolved and retried
individually. If the failure rate inside the queue is non-trivial — flaky tests,
a genuinely conflicting pair — the queue spends its time re-testing and both the
primary and counter metrics suffer. This estate's CI failure rate is the thing
to watch if that happens.

## Cost and reversibility

Roughly two hours: the `merge_group` prerequisite (#752), the queue
configuration, and this file. **Fully reversible** — deleting the ruleset removes
the queue and restores the previous behaviour immediately; `strict: true` is one
API call to put back. Nothing about the repo's history or contents changes.

## Confounds acknowledged in advance

- **n=1, no control group.** Interrupted time series against a pre-registered
  prediction. It is the strongest design available here and it is weaker than a
  controlled trial. Say so when reporting.
- **`tabsii-crm` is a comparator, not a control.** It gets no queue, deliberately
  — treating the whole estate at once would destroy the only baseline there is.
  If crm's numbers move over the same period, something estate-wide changed and
  this result is not attributable to the queue.
- **The baseline window is itself contaminated by H1's intervention.** One of its
  seven days had auto-merge in force. The effect is small and, if anything, makes
  the baseline flattering to H2 rather than the reverse.
- **Volume is not stable.** All primary metrics are rates or per-PR, for this
  reason.

## Result

**Verdict: `abandoned`** — 2026-07-28, the same day it was pre-registered, before
the intervention was applied. **The experiment never ran and produced no data
about merge queues.**

**GitHub does not offer a merge queue on this account.** Established, not
assumed:

| Check | Result |
| --- | --- |
| `merge_queue` ruleset rule on `keiranholloway/biffo-template` (public, personal account) | HTTP 422 `Invalid rule 'merge_queue'` |
| The same rule on `tabsii-com/tabsii-geo` (private, org, Team plan) | HTTP 422, identical |
| A `non_fast_forward` rule on the same repo | created successfully |
| The `dev` branch protection UI | lists every other option — approvals, status checks, up-to-date, conversation resolution, signed commits, linear history, deployments, lock branch, force pushes, deletions — and **no merge queue option at all** |

So it is the feature, not the payload, not permissions, and not the ruleset API.
The most likely eligibility rule — inferred, not verified — is that GitHub gates
merge queue to organization-owned public repositories and to Enterprise Cloud for
private ones. Neither repo qualifies: `biffo-template` is public but
personally owned; `tabsii-geo` is org-owned but private on Team.

Both capability probes were deleted immediately; no ruleset survives, and no
branch protection was modified. `#752` — which taught CI to report required
checks for `merge_group` — is kept: it is inert without a queue, costs nothing,
and is exactly the prerequisite that would be needed if this ever becomes
available.

**What this cost, and what it bought.** It cost the `merge_group` prerequisite
and this file. It bought a hard constraint that was not previously written down
anywhere: **the purpose-built fix for the merge race is unavailable to this
estate.** H1 named two next moves; this eliminates one of them permanently. That
narrowing is the result.

**Next move: the other one.** H1's remaining pre-registered alternative is
relaxing `strict`, described there as "cheaper, weaker". That is
[H3](./H3-relax-strict.md), pre-registered before it was applied.

> Recorded in full rather than deleted. An experiment that could not run is
> evidence about the environment, and a file that quietly disappeared would take
> that finding with it — leaving the next person to rediscover the 422 themselves.
