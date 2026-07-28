# H1 — the merge race is unwinnable by hand

**Status:** `abandoned` on 2026-07-28 — superseded by
[H2](./H2-merge-queue.md), which tests this file's own pre-registered next move.
See [Result](#result).
**Pre-registered:** 2026-07-27, **before** the intervention landed
**Review on:** ~~2026-08-10~~ — never reached; see Result

> This file was written and committed before the change it predicts. That
> ordering is the entire point: a prediction written afterwards is a
> description, and it will always fit.

---

## Claim

Correct, green work cannot land because `dev` moves faster than a PR's own CI
cycle. Branch protection has `strict: true` (branches must be up to date), and
in the last seven days `dev` took **257 merges** — roughly 37 a day — against a
~2.5 minute CI cycle. A branch is therefore frequently `BEHIND` before its own
checks finish, and the merge is retried by hand.

This is a **contention** failure, not a churn one: the code was right and could
not land. It needs a different remedy from anything aimed at code quality.

## Baseline — measured, not estimated

From `docs/practices/data/2026-07-27.json`, `keiranholloway/biffo-template`:

| Window | racedShare | repushRate | green-but-unmerged | merged PRs |
| --- | --- | --- | --- | --- |
| 90d | **13.8%** | 35.7% | 163.1h | 456 |
| 7d | **13.2%** | 40.5% | 72.4h | 257 |
| 24h | 22.9% | 43.8% | 21.3h | 48 |

`racedShare` is the primary metric: the share of merged PRs that were green for
more than ten minutes **and** were repushed. Both conditions matter — a long
wait alone is a PR nobody got to, a repush alone is ordinary iteration.

It is chosen over the raw hours because it is already normalised per PR. Volume
is not stable here: 257 of the quarter's 456 merges landed in the last week, so
absolute hours would move for reasons that have nothing to do with the
intervention.

Secondary: `repushRate`. Tertiary: green-but-unmerged **per PR** (90d: 21.5
min/PR; 7d: 16.9 min/PR).

## Intervention

`biffo-workflow` step 7 changes from

```bash
gh pr merge <N> --squash --delete-branch
```

to enabling auto-merge, so GitHub lands the PR when its requirements are met
instead of the agent racing for a window in which they all hold at once.

`allow_auto_merge` is **already enabled** on the repo and simply was not being
used — six PRs were merged by hand on 2026-07-27, one of which (#705) went
`BEHIND` mid-CI and cost a rebase plus a full extra CI cycle for a docs-only
change that was already green.

## Prediction

By **2026-08-10**, measured on a 7-day window:

- **`racedShare` below 5%** (from 13.2%)
- `repushRate` below 30% (from 40.5%)
- green-but-unmerged below 12 min/PR (from 16.9)

## Falsification

**The hypothesis is refuted if `racedShare` is still above 10% on 2026-08-10**
with at least 50 merged PRs in the window. That would mean auto-merge did not
remove the race, and the retries had another cause.

**The most likely reason for refutation, stated in advance:** it is *not
established* that GitHub's auto-merge automatically updates a head branch that
falls behind while `strict: true` is in force. If it does not, auto-merge only
removes the manual retry loop — the PR still waits for someone to update the
branch — and `racedShare` will barely move.

That uncertainty is deliberately left in rather than resolved by assertion. If
it is the cause, the next interventions are a **GitHub merge queue** (the
purpose-built fix) or **relaxing `strict`** (cheaper, weaker). Refutation here
therefore still buys information.

**Inconclusive** if fewer than 50 PRs merge in the review window — the estate's
volume is spiky, and a quiet fortnight cannot distinguish a working fix from an
absent problem.

## Cost and reversibility

~1 hour to change the skill. Fully reversible: the old command is one line.

## Confounds acknowledged in advance

- **Volume is not stable.** 257 merges in 7 days against 456 in 90 days. All
  primary metrics are rates or per-PR, for this reason.
- **This is n=1 with no control group.** The design is an interrupted time
  series against a pre-registered prediction; that is the strongest available
  here, and it is weaker than a controlled trial. Say so when reporting.
- **`tabsii-crm` is a natural comparator, not a control.** Same rules, a quarter
  the traffic, 8.8% repush and **0%** raced. If crm's numbers move over the same
  period, something estate-wide changed and this result is not attributable to
  the intervention.

## Interim observation — 2026-07-27, the predicted failure mode occurred

The pre-registration named one specific reason this might be refuted:

> It is *not established* that GitHub's auto-merge automatically updates a head
> branch that falls behind while `strict: true` is in force. If it does not,
> auto-merge only removes the manual retry loop — the PR still waits for someone
> to update the branch — and `racedShare` will barely move.

**That is exactly what happened**, on biffo-platform#84, hours after the
intervention landed:

- auto-merge armed, `mergeable: MERGEABLE`, all five checks green
- head branch **1 commit behind** `dev`
- PR sat `OPEN` with `mergeStateStatus: UNKNOWN` for over ten minutes
- it merged only after a human ran `gh pr update-branch`, which triggered a full
  re-run of CI

So auto-merge **does not** update a behind branch under `strict`. It removes the
*retry loop* — you no longer sit refreshing and re-merging — but the branch still
has to be updated by someone, and that still costs a full CI cycle.

This does not settle the experiment. `racedShare` counts PRs that were green for
over ten minutes *and* were repushed, and a `gh pr update-branch` **is** a
repush, so this PR will score as raced. The prediction may therefore still be
refuted on 2026-08-10, and the pre-registered next moves stand: a **merge queue**
(which does own the update) or **relaxing `strict`**.

Recorded now rather than at review, so the observation cannot be reconstructed
favourably after seeing the number.

### Corroboration — two more, in different repos, same day

The observation above was a single PR in one repo, which is weak evidence. Two
further instances occurred later on 2026-07-27, in **different repositories**:

| PR | State | Behind by | Resolution |
| --- | --- | --- | --- |
| [biffo-plugin-idea-scout#21](https://github.com/keiranholloway/biffo-plugin-idea-scout/pull/21) | auto-merge armed, all 7 checks green, `mergeStateStatus: BEHIND` | 1 | hand `rebase` + `--force-with-lease`, then a full CI re-run |
| [biffo-template#731](https://github.com/keiranholloway/biffo-template/pull/731) | auto-merge armed, all 5 checks green, `mergeable: MERGEABLE`, `BEHIND` | 2 | same |

Both sat green-and-blocked for over ten minutes before anyone intervened. So the
behaviour is **not repo-specific and not a one-off**: across three repos and three
PRs, auto-merge under `strict: true` never once updated a behind branch.

Note this raises the expected `racedShare` rather than lowering it — each of
these is a green-for-over-ten-minutes PR that was then repushed, which is the
metric's definition of raced. The prediction (`racedShare` below 5%) now looks
**unlikely to hold**, and recording that before the review date is the point of
writing it down here.

### Three more on 2026-07-28, one of them twice in the same PR

| PR | Occurrence |
| --- | --- |
| [#747](https://github.com/keiranholloway/biffo-template/pull/747) | auto-merge armed, all five checks green, `mergeStateStatus: BEHIND`; merged only after a hand `gh pr update-branch` and a full CI re-run |
| [#750](https://github.com/keiranholloway/biffo-template/pull/750) | the same, **twice** — knocked `BEHIND` again by the merge that landed while its second CI cycle ran |

That brings it to **six occurrences across four repositories, with zero cases
where auto-merge updated a behind branch.** The mechanism is no longer in doubt.

A seventh followed immediately, and is worth recording for what it says about how
routine this is: **[#754](https://github.com/keiranholloway/biffo-template/pull/754)
— the PR carrying this very verdict — was itself knocked `BEHIND`** and needed a
hand `gh pr update-branch` plus a full CI re-run before it could land.

## Result

**Verdict: `abandoned`** — 2026-07-28, thirteen days before the review date.

**Not `refuted`.** The prediction (`racedShare` below 5% by 2026-08-10) was never
tested and now cannot be: enabling a merge queue changes the intervention before
the review date, so a 2026-08-10 reading would measure two changes at once and be
attributable to whichever the reader preferred. Calling that "refuted" would
claim a measurement that was not taken.

**Why stop early rather than wait.** The pre-registration named one specific
reason it might fail — that auto-merge may not update a behind branch under
`strict: true` — and that is exactly what happened, six times across four repos
within two days. Twelve more days of watching the same mechanism recur buys a
number, not an insight. The pre-registered next move (a merge queue) is now
[H2](./H2-merge-queue.md), pre-registered 2026-07-28 before the queue was
enabled.

**What H1 nonetheless established**, and it is the useful part:

- Auto-merge under `strict: true` **does not** update a behind head branch. Not
  repo-specific, not a one-off, not a race in the observation.
- Therefore auto-merge removes the *manual retry loop* but not the *cost* — the
  branch still has to be updated by someone, and that still costs a full CI
  cycle. The distinction was hypothesised in the pre-registration and is now
  observed.

**The intervention is kept, not rolled back.** This file's rule is that a
*refuted* hypothesis gets its change reverted. An abandoned one has no such
verdict to act on, and auto-merge is in any case a prerequisite for H2 rather
than a competitor to it — `gh pr merge --auto` is how a PR enters a merge queue.

A reading was taken on 2026-07-28 (`racedShare` 16.0%, up from 13.2%). It is
recorded in H2 as *that* experiment's baseline and explicitly **not** as evidence
about H1: six of its seven days predate the intervention, so the window cannot
show its effect.
