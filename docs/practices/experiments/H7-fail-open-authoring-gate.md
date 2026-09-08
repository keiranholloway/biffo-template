# H7 — asking the fail-open question at authoring time reduces newly-created fail-open entries

**Status:** `inconclusive` — reviewed 2026-09-08, corpus instrument dark for the
whole window; see "2026-09-08 review" below. Paragraph stays in place: neither
confirmed nor refuted, and the doc's own rollback rule only fires on refutation.
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

## 2026-09-08 review

**`readCorpus()` at today's HEAD returns exactly the baseline numbers: 118
primary + 44 secondary `fail-open` entries out of 490 total rows — byte-for-byte
identical to the 2026-09-01 reading.** Zero rows of *any* class have been added
to the corpus (`docs/practices/evidence.jsonl` + `docs/practices/evidence/`)
since the last commit that touched either, `2026-08-10 06:56:11 +0100`. That
predates this experiment's own intervention commit
(`c2a08178`, 2026-09-01T10:01:37Z, PR #1848) by three weeks.

**59 PRs merged in `biffo-template` since the intervention landed**
(`gh pr list --state merged --search "merged:>=2026-09-01"`, filtered to
`mergedAt` strictly after `2026-09-01T10:01:37Z`; 63 merged on-or-after
2026-09-01 by calendar date, 59 after the actual cutoff timestamp). That is
comfortably enough PRs to say something, *if* the corpus were still being
written to.

**It is not, and that is not evidence the intervention worked.** Real
fail-open-class defects kept being found and filed as GitHub issues
(`class:fail-open`) well after 2026-09-01 — e.g. #1911 and #1912 (found and
closed 2026-09-06, an ownership-guard prefix-match disagreement and a
descriptive-not-prescriptive test) and #1947 (closed 2026-09-07, a fail-closed
config gate shipped with zero regression coverage for the enforcement path
itself). None of these three ever became a `docs/practices/evidence/*.json`
row. Reading their bodies for how they were caught: all three were found by
**independent prosecution against a merged PR** — #1947's own text opens "PR
#1946 ... I proved this independently with a scratch vitest test exercising
`runPluginInstall` directly (not the PR's own tests)" and confirms "Fail-first
confirmed: the identical test against the PR's merge-base ... fails all three
assertions" — which is debugging/review-time discovery of exactly the same
shape the pre-intervention baseline was built from, not the authoring-time
self-check catching anything. So the defect class has not visibly gone away;
only the corpus's visibility into it has.

**So there is no post-intervention `surfacedIn` text to read.** Step 2 of this
review's brief was to read every new fail-open-related entry's `surfacedIn`
field and judge authoring vs. debugging discovery. There are zero new entries
to read — that absence is itself the finding, not a shortcut around the
qualitative judgement the doc asked for. For contrast, three pre-intervention
`surfacedIn` values from inside the 0.078 baseline window (2026-08-02, from
`evidence.jsonl`), which *do* read as debugging/review-time the way the
baseline paragraph describes:

- `"biffo-template daily practices cron (04:30 2026-08-02) - all 15 repos,
  FATAL, no snapshot written"` — found by a scheduled job failing, not by
  anyone authoring the code that later turned out to fail open.
- `"estate-wide, concentrated in tabsii-platform (found ranking the
  2026-08-02 standup)"` — found during the practices standup ritual, i.e. a
  review-time sweep.
- `"agent tooling — ad-hoc \`until\` loops around \`gh pr checks\`, while
  clearing the 13-repo shared-sync queue"` — found doing unrelated queue-
  clearing work, not while writing the offending loop.

### Applying the pre-registered "Refuted if" criteria

- *"The post-intervention rate does not fall below 0.078 ... at review"* — the
  literal computed rate is 0 new entries / 59 PRs = 0.0, which numerically
  clears the bar. **This is not treated as confirmation.** A rate computed from
  an instrument that recorded nothing at all, for a class or any other, across
  the entire window is not a measurement of the fail-open rate; it is a
  measurement of whether anyone wrote a corpus entry, and the answer is no for
  reasons that have nothing to do with this experiment (see above — the corpus
  went dark three weeks before the intervention even shipped).
- *"entries keep arriving whose `surfacedIn` shows they escaped authoring
  rather than debugging"* — cannot be evaluated on corpus entries, because
  none arrived. The **closest available signal**, the three `class:fail-open`
  GitHub issues filed after 2026-09-01 and read above, all show
  debugging/review-time discovery (independent prosecution against an already-
  merged PR), the same shape as every pre-intervention entry. That leans
  against the hypothesis without being the pre-registered measurement.

Neither criterion can be honestly applied on real corpus data, so this is not
called refuted — and it is equally not called confirmed, because the one
number that nominally clears the bar is an artifact of a broken measurement
instrument, not evidence of the mechanism working. **Verdict: inconclusive.**
The AGENTS.md paragraph stays in place — the doc's rollback rule is keyed to
refutation, and refutation was not established.

### Counter-metric, for context only

`node scripts/practices-metrics.mjs --window 7` (today, 2026-09-08):
`cycleTimeP50Minutes` **48.1** / `cycleTimeP90Minutes` **426.3** for
`keiranholloway/biffo-template` (59 merged PRs), against the pre-intervention
6-minute p50 / 95.2-minute p90 recorded in this doc's Baseline section. Both
figures rose sharply (~8x at p50, ~4.5x at p90). As the doc already cautions,
this is suggestive at most, not proof of cause: the window, sample, and
mechanism differ too much from the baseline reading to attribute the move to
one paragraph, and a 7-day window this soon after a quiet three-week corpus
stretch is a weak instrument for authoring-time friction specifically.

### What this actually blocks, and the concrete next step

The corpus stopped receiving new rows around 2026-08-09/10 — three weeks
*before* this experiment's intervention — and has stayed silent through the
entire post-intervention window, despite the estate continuing to find and
file real fail-open-class defects (#1911, #1912, #1947 and others) through
GitHub issues instead. That is a `docs/practices/evidence/` recording-practice
stall, not a fact about this experiment, but it makes H7 — and any other
corpus-rate-based experiment reviewed in this window — impossible to judge
honestly on the pre-registered metric.

Proposed next step: get the corpus-writing practice running again (the
`biffo-practices-standup` ritual, or a deliberate backfill of the
`class:fail-open` issues filed since 2026-08-10 into
`docs/practices/evidence/`), then re-run this review over a fresh window that
starts *after* the corpus is confirmed live again — extending the window
blindly without fixing the instrument would just produce a second inconclusive
reading. Not done as part of this review: fixing the recording practice is a
separate, larger piece of work outside this review's scope, and is flagged
here rather than done silently.
