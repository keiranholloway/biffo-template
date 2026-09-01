# H7 — asking the fail-open question at authoring time reduces newly-created fail-open entries

**Status:** `running`
**Pre-registered:** 2026-09-01, before the sentence is added
**Review on:** 2026-09-08 (7 days — the estate's review cadence)

---

## Why this restarts rather than continues

Issue #1083 proposed this sentence on 2026-08-01 with a 2026-09-01 review
date, but the prose was never actually added. Checked exhaustively before
concluding that (`git log --all -S"would anything look different"` and
`-S"could not see its input"`) across every ref in `biffo-template` **and**
across the separate `~/code/.claude` repo the `biffo-workflow` skill actually
lives in: zero hits in either, and no close paraphrase anywhere in `AGENTS.md`
or the skill's `SKILL.md`. The mechanical half of the issue's proposal (a
commitlint rule rejecting CI-skip tokens, #1082) shipped and is a different
tactic, already confirmed separately.

So the 2026-09-01 review found nothing to confirm or refute — the experiment's
prose arm had never launched, and closing it as "refuted" would have been
measuring an intervention that was never applied. This document restarts it
for real, from today, rather than treating the elapsed month as data.

The window is also shortened from the issue's original ~30 days to this
register's current 7-day cadence (adopted 2026-07-29, after #1083 was filed),
for the same reason every other row here uses 7 days: a 30-day loop offers too
few chances a year to learn something, and this estate merges fast enough that
7 days already carries a real sample (roughly 90 PRs at the current merge
rate).

## Hypothesis

Asking the fail-open question at authoring time (the new AGENTS.md paragraph)
reduces *newly created* `fail-open` corpus entries per merged PR, relative to
the pre-intervention rate below.

## The intervention

A new paragraph in `AGENTS.md` §4 ("Read your own diff for the fail-open
shape"), sibling to `biffo-workflow`'s Step 4.5:

> If this reported success, or reported zero, because it could not see its
> input — would anything look different?

## Baseline

Read directly via `readCorpus()` (`scripts/practices-corpus.mjs`) at this PR's
own HEAD, 2026-09-01: **118 primary `fail-open` + 44 secondary (`alsoClass`)**
entries, out of 490 total corpus rows.

Pre-intervention rate, over the four weeks the sentence *should* have been
running had it shipped on 2026-08-01 (2026-08-02T15:51:35Z merge of #1085 →
2026-09-01): 19 new primary + 11 new secondary = 30 fail-open-related entries
across 387 merged PRs ≈ **0.078 per merged PR**. Every one of those 30 has a
`surfacedIn` value describing discovery during a backlog groom, an
estate-wide sweep, a walkthrough, or work on something unrelated —
debugging/review-time discovery, not authoring-time. None describe an
authoring-time self-check catching it, which is unsurprising: there was no
self-check to catch it with. That is the honest pre-intervention number, not
a post-hoc justification for adding the sentence — it is what the corpus
already showed before this paragraph existed, and it is the number this
experiment's 2026-09-08 review compares against.

## Refuted if

- The post-intervention rate does not fall below 0.078 fail-open-related
  entries per merged PR at review, **or**
- entries keep arriving whose `surfacedIn` shows they escaped authoring rather
  than debugging — i.e. the question demonstrably was not being asked at the
  point it would have mattered, even though the sentence existed.

If refuted, the AGENTS.md paragraph comes back out rather than accumulating,
per the issue's own rule ("If refuted, the prose comes back out").

## Counter-metric

Review time per PR. The issue names this, but no metric in
`practices-metrics.mjs` measures authoring or review time specifically —
`cycleTimeP50Minutes` (PR open → merge) is the closest available proxy and its
own doc (`docs/practices/metrics.md`) states it does not capture anything
before the PR existed. Recorded here so the gap stays visible rather than
silently substituted: a sharp move in `cycleTimeP50Minutes` against its
pre-intervention value (6 minutes p50 / 95.2 minutes p90 over the 30 days to
2026-09-01, per `node scripts/practices-metrics.mjs --window 30`) is
suggestive, not proof the sentence is the cause.

## What would make this measurement lie

`surfacedIn` is free text, not a controlled vocabulary — reading it for
"caught at authoring vs. caught at debugging" is a qualitative judgement, not
a tag count. A future reviewer should re-read the actual entries rather than
trust a keyword search of the field.

Related: #1083, #956 (fail-open inventory), [H6](H6-review-the-diff.md) (the
sibling authoring-gate experiment for justification-checking generally, which
this paragraph is deliberately worded to sit beside rather than duplicate).
