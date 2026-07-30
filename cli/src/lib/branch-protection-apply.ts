/**
 * Applying branch protection to a repo that never got it (#714, #715).
 *
 * Two different holes lead to the same place, and both are live:
 *
 * - **#715** — `configureBranchProtection` returns quietly on a 403 (GitHub's
 *   answer for a private org repo below Team). Nothing re-attempts, so a repo
 *   scaffolded during a 403 window stays unprotected even after the plan is
 *   upgraded. Three `tabsii-com` repos, including the live core platform, ran
 *   that way for three weeks.
 * - **#714** — standalone plugin repos are not created by the CLI at all. They
 *   are made by hand, so `configureBranchProtection` never runs for them and
 *   protection is never even attempted. `biffo-plugin-ideation#54` was merged
 *   with both CI jobs still in flight because of it.
 *
 * `branch-protection-audit.ts` detects both. This module is the other half:
 * deciding what protection to apply, and to which branches.
 *
 * ## Why the required contexts are derived, not declared
 *
 * The audit is deliberately policy-shaped — it asserts protection has the right
 * *properties* rather than comparing against a canonical check list, because
 * repos legitimately run different jobs (5 contexts here, 11 of an older
 * generation there). Applying protection has to make the opposite kind of
 * decision: it must name specific contexts.
 *
 * Naming the wrong one is not a cosmetic error. **A required context that never
 * reports blocks every merge on that branch, permanently** — a worse outcome
 * than the missing protection this is fixing. So contexts are derived from what
 * the repo's CI has actually been observed to report, and only checks that
 * report *consistently* qualify.
 */

/** One observed check run: the context name, and the commit it ran against. */
export interface ObservedCheck {
  name: string
  headSha: string
}

/**
 * How many of the recent commits a context must appear on to be required.
 *
 * Two-thirds, not all: a genuinely required check can legitimately miss one
 * commit (a cancelled run, a `paths:` filter, GitHub occasionally creating no
 * run at all — which has happened here). Requiring 100% would drop real checks.
 * Requiring one appearance would promote a one-off manual dispatch into a
 * permanent merge blocker.
 */
export const CONTEXT_CONSISTENCY_THRESHOLD = 2 / 3

/** Commits to look back over. Enough to smooth a flake, few enough to stay current. */
export const RECENT_COMMIT_WINDOW = 6

/**
 * The contexts that should be required on a branch, derived from what its CI
 * has actually reported.
 *
 * Returns them sorted, so the result is stable and diffable.
 *
 * @param observed check runs seen recently, newest first
 */
export function deriveRequiredContexts(observed: ObservedCheck[]): string[] {
  const shasNewestFirst: string[] = []
  for (const { headSha } of observed) {
    if (!shasNewestFirst.includes(headSha)) shasNewestFirst.push(headSha)
  }
  const window = shasNewestFirst.slice(0, RECENT_COMMIT_WINDOW)
  if (window.length === 0) return []

  const seenOn = new Map<string, Set<string>>()
  for (const { name, headSha } of observed) {
    if (!window.includes(headSha)) continue
    const set = seenOn.get(name) ?? new Set<string>()
    set.add(headSha)
    seenOn.set(name, set)
  }

  const required = Math.ceil(window.length * CONTEXT_CONSISTENCY_THRESHOLD)
  return [...seenOn.entries()]
    .filter(([, shas]) => shas.size >= required)
    .map(([name]) => name)
    .sort()
}

/** The protection payload, matching what `configureBranchProtection` applies. */
export interface ProtectionParams {
  required_status_checks: { strict: boolean; contexts: string[] }
  enforce_admins: boolean
  required_pull_request_reviews: {
    required_approving_review_count: number
    dismiss_stale_reviews: boolean
  }
  restrictions: null
  required_linear_history: boolean
  allow_force_pushes: boolean
  allow_deletions: boolean
}

/**
 * Build the protection payload for a branch.
 *
 * Deliberately identical in shape to what `configureBranchProtection` applies at
 * scaffold time, so a backfilled repo is indistinguishable from one that was
 * protected correctly on day one — rather than a second, subtly different
 * policy that then drifts from the first.
 *
 * `strict: true` is the default and the right one for a **backfill**: without it a
 * branch can merge while behind its base, which is the state that lets an
 * already-green PR land against code it was never tested with.
 *
 * It is a parameter rather than a literal because it used to be neither, and that
 * silently fought a running experiment (#808). Experiment H3 has `strict: false`
 * on `biffo-template`'s `dev` deliberately, until 2026-08-11. The audit reports
 * that as a `not-strict` finding — correctly, it is worth knowing — and any
 * finding makes `--fix` eligible, at which point this function forced
 * `strict: true` back on and **reverted the experiment with no message saying so**.
 *
 * The caller now distinguishes the two cases, because they are different claims:
 *
 *   - protection **absent** → apply the full policy, `strict: true` included. That
 *     is #714/#715, the gap this command exists to close.
 *   - protection **present** with `strict: false` → somebody set that. Report it;
 *     do not silently overwrite a decision while claiming to backfill a gap.
 */
export function protectionParamsFor(
  contexts: string[],
  options: { strict?: boolean } = {},
): ProtectionParams {
  return {
    required_status_checks: { strict: options.strict ?? true, contexts: [...contexts].sort() },
    enforce_admins: false,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
  }
}

/** What `planProtection` decided for one branch, and why. */
export interface ProtectionPlan {
  branch: string
  action: 'apply' | 'skip'
  reason: string
  contexts: string[]
}

/**
 * Decide what to do for one branch.
 *
 * Refuses to apply protection with **no** required contexts. That state is worse
 * than it looks: a PR against such a branch reports `CLEAN` the instant it
 * opens, before any run has registered, so "checks passed" and "no checks are
 * required" become indistinguishable to anything reading merge state —
 * including `gh pr merge --auto`. Protection that admits everything is not
 * protection, and applying it would silence the audit while changing nothing.
 *
 * @param branch branch name
 * @param exists whether the branch exists at all
 * @param observed recent check runs for the repo
 */
export function planProtection(
  branch: string,
  exists: boolean,
  observed: ObservedCheck[],
): ProtectionPlan {
  if (!exists) {
    return {
      branch,
      action: 'skip',
      reason: 'branch does not exist',
      contexts: [],
    }
  }

  const contexts = deriveRequiredContexts(observed)
  if (contexts.length === 0) {
    return {
      branch,
      action: 'skip',
      reason:
        'no check has reported consistently enough to require — applying protection with an empty ' +
        'context list would make the branch look protected while admitting any PR',
      contexts: [],
    }
  }

  return {
    branch,
    action: 'apply',
    reason: `requiring ${contexts.length} context(s) observed on recent commits`,
    contexts,
  }
}

/** Human-readable summary of a set of plans. */
export function formatPlans(plans: ProtectionPlan[]): string {
  return plans
    .map((p) =>
      p.action === 'apply'
        ? `  ${p.branch}: apply — ${p.reason}\n${p.contexts.map((c) => `      • ${c}`).join('\n')}`
        : `  ${p.branch}: skip — ${p.reason}`,
    )
    .join('\n')
}
