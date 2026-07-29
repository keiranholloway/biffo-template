# Experiments — what we changed, what we predicted, what happened

The register. One row per hypothesis, and the honest outcome of each.

**Review windows are 7 days.** Set 2026-07-29 (#850), replacing a mix of 14 and
30. This estate merged 616 PRs in seven days; a 30-day loop offers four chances
a year to learn something, and its reference window is mostly history. Checked
before adopting: the last 7 days carry 144 failed CI runs and 199 failing steps
estate-wide, and the headline metric reads 66% on 7 days against 62% on 30 — so
the shorter window keeps the signal and costs no comparability. Baselines are
the **equal-length period immediately before** the reading: last week against
this week, matched in length and sharing no data.

Three rules, all of which exist because the alternative is self-congratulation:

1. **Pre-register before intervening.** The prediction — metric, direction,
   magnitude, review date — is written and committed *before* the change lands.
   A prediction written afterwards is a description, and it always fits.
2. **A refuted hypothesis gets rolled back**, not quietly kept because it felt
   better. This is the rule that makes the register worth reading.
3. **Discounted ideas keep their reason and a re-open trigger**, so they are not
   silently re-litigated every quarter.

| # | Hypothesis | Metric | Status | Pre-registered | Review |
| --- | --- | --- | --- | --- | --- |
| [H1](H1-merge-race.md) | The merge race is unwinnable by hand; auto-merge removes it | `racedShare` 13.2% → <5% | `abandoned` | 2026-07-27 | superseded by H3 |
| [H2](H2-merge-queue.md) | A merge queue removes the race without relaxing `strict` | — | `abandoned` | 2026-07-28 | never ran — GitHub offers no merge queue on this account |
| [H3](H3-relax-strict.md) | Relaxing `strict` removes the race without breaking `dev` | `racedShare` 16.0% → <3% | **running** | 2026-07-28 | 2026-08-04 |
| [H4](H4-shift-left-gates.md) | A local gate that actually runs removes most of what CI catches | **gate coverage 45% → 100% on day 0**; locally-catchable share of failing CI steps 66% (7d) → <20% | **running** | 2026-07-29 | 2026-08-05 |

> H2 and H3 were pre-registered on 2026-07-28 and never added here, so for a day
> this register listed one of three live experiments. An index that is not
> maintained is not a register — it is a claim that nothing else was tried.
> Adding a row is part of pre-registering, not a follow-up.

## Open, not yet pre-registered

Ranked by what the evidence currently supports, not by appeal. **Ranking by
cost is still blocked**: 1 of 41 corpus rows carries a cost figure, so these are
ordered by frequency and measured magnitude only.

| Candidate | What the data says | Why not yet |
| --- | --- | --- |
| **Fix-on-fix churn in `biffo-template`** | 33.5% of attributed fixes correct a prior fix; chains to depth 5. tabsii-platform is 11.8% and depth 2, so this is template-specific | No cheap intervention identified. Cycle-time p50 is 3.7 min against a 37.5% fix share — the shape is "merges faster than it verifies" — but the remedy is a judgement call, not a switch |
| **The platform/product seam is blurred** | `tabsii-platform` is both the product backend *and* a Biffo instance; 30 of its 230 merges were core upgrades. Platform churn structurally lands in product repos | Architectural. Needs a design proposal before anything is testable |
| **Visibility is the dominant failure class** | 13 of 41 corpus rows — more than drift (12), boundary (7), fail-open (6) | A design principle, not an intervention. Needs decomposing into something falsifiable |
| **Product delivery is a rounding error** | 13.9% of merges are product features over 90d; 3.2% over the last 7 days | A strategic allocation question, not a process experiment. Belongs to the operator, not the register |

## Discounted

_Nothing discounted yet. Entries here keep the reason **and** the condition
under which they would be worth revisiting._

## Refuted along the way

Two hypotheses were tested and refuted during Phase 0, before this register
existed. Recorded because a refuted idea that goes unrecorded gets proposed
again:

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| CI/CD pipeline contention is a major cost | **refuted** | Runner pickup latency median **0.00m**, p90 0.00m; 0.6–0.8% of runs queue over 2 minutes. The one big queueing incident (biffo-runners#2, 1h 44m) was a missing App grant, not capacity |
| Cross-repo cascade inflates the cost of a change | **refuted** | Cost per merge is flat across cascade width (10.0 / 8.65 / 8.88 / 9.19 min per merge for 1–4 repos). Core upgrades do not raise the fix rate: lift **0.78–0.89×** baseline in tabsii-platform |

The second is worth reading twice. *"63% of tabsii's fixes landed within 24h of
a core upgrade"* looks damning and means nothing — with 31 upgrades across 230
merges, those windows cover 76% of all merges, so 63% is **under**-representation.
The lift against baseline is the honest statistic, and it says no effect.
