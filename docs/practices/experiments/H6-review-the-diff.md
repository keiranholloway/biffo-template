# H6 — a review step in `biffo-workflow` raises review coverage above zero

**Status:** `running`
**Pre-registered:** 2026-07-30, **before** the step is used even once
**Review on:** 2026-08-06 (7 days — the estate's review cadence)

> Written and committed before the intervention, like H1–H5. A prediction written
> afterwards is a description, and it will always fit.

---

## Why there is an H6

`build-plugin-feature` has a read-your-own-diff step, and the scoreboard records
it earning its keep: **four defects in one milestone, all found by reading the
change, none by a suite that was green at 26, 28 and 30 tests.**

`biffo-workflow` — the skill that lands every *ad-hoc* change — had no such step.
Its sequence went make → commit → push → PR → merge.

On 2026-07-30 a single session shipped roughly twenty PRs through that path. Two
carried reasoning that was internally consistent and externally false:

1. `anthropic/claude-opus-4-8` was declared "not a model OpenRouter serves" from
   its absence in a published catalogue. The estate's own agent-run ledger showed
   **26 runs on that slug, $3.74 charged, 24 completed**. A fix, a DDL correction
   and two guard tests shipped on the false premise.
2. Startup seeding was built on *"there is no deploy step to hang seeding on"* —
   true of the plugin repo, irrelevant, because the seed belongs to the instance,
   which had run exactly that step three times. **cost 1h 20m.**

**Neither is reachable by a test.** In both cases the code did what it claimed and
the tests passed; the *premise* was wrong. The only gate that reads premises is a
second pass over the diff and its stated reasoning.

## The intervention

A `Step 4.5 — Read your own diff before you open the PR` in `biffo-workflow`,
placed after the push and before the PR, invoking `/code-review` for anything
beyond a one-liner or any change whose justification rests on a claim about the
outside world.

## The metric

`review.reviewedShare` per repo, added to the collector in the same change
(#952). It counts a merged PR as reviewed on **any** review event — APPROVED,
CHANGES_REQUESTED or COMMENTED.

The bar is deliberately *"someone looked"*, not *"someone approved"*: on a
solo-operator estate an approval requirement would block every merge, so
requiring one would measure the policy rather than the practice.

**Baseline, 2026-07-30: effectively 0%.** Nothing recorded a review because
nothing asked for one.

## Prediction

Within 7 days, `reviewedShare` across `biffo-template`, `biffo-platform` and the
two plugin repos rises **above 25%**, and at least one merged PR carries a review
event that changed the change.

## Refuted if

- `reviewedShare` stays **below 10%** at review — the prose did not take, and
  something structural is needed (a `PreToolUse` hook on `gh pr merge` is the
  next candidate, deliberately not tried first because it is intrusive and would
  interfere with `clear_queue` and parallel sessions).
- **or** coverage rises while the defect class continues: another merged PR whose
  stated justification is false in a way a reader would have caught. That would
  mean reviews are happening and not reading premises, which is a different and
  worse problem than not reviewing.

## Counter-metric

Time-to-merge must not blow out. If `contention.greenToMergeP50Minutes` more than
doubles against the 7-day baseline, the step is costing more than it saves and
should be scoped to changes above some size rather than applied to every PR.

## What would make this measurement lie

`reviewedShare` sees only **recorded** reviews. An author reading their own
combined diff — which `build-plugin-feature` requires, and which demonstrably
works — leaves no trace. So this is a **floor**, not the truth, and a low number
is consistent with careful self-review that simply is not logged.

That is acceptable because the property that matters is preserved: the number
**can fall**, and it did read zero on a day when review demonstrably did not
happen. A metric that cannot get worse is not measuring anything — the failure
already recorded on this page when hook-arming hit 100% across the estate while
six repos ran one check in eight.
