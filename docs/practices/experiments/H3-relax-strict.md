# H3 — relaxing `strict` removes the race without breaking `dev`

**Status:** `running`
**Pre-registered:** 2026-07-28, **before** `strict` was turned off
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

## Falsification

**Refuted if `racedShare` is still above 8% on 2026-08-11** with at least 50
merged PRs in the window.

**Also refuted, independently of `racedShare`,** if `integration.failures` > 2 or
`integration.redMinutes` > 60. Declaring success on contention while `dev` starts
breaking is the failure this section exists to prevent.

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

## Result

_To be completed on 2026-08-11. Verdict: `confirmed` / `refuted` /
`inconclusive` / `abandoned`. A refuted hypothesis gets the change rolled back,
not quietly kept because it felt better — and the counter-metric can refute it on
its own, whatever the primary metric says._
