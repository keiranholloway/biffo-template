/**
 * What actually happened when scaffolding tried to protect a repo (#715, #737 item 2).
 *
 * `configureBranchProtection` used to return `void`. On a 403 — GitHub's answer
 * when a private org repo's plan does not include branch protection — it logged
 * two warnings and returned, and the scaffold carried on and reported success.
 * Two properties made that expensive:
 *
 * - **The caller could not tell success from a skip.** A `Promise<void>` that
 *   resolves means "no exception", not "protected". Nothing downstream could
 *   branch on the difference even if it wanted to.
 * - **The only trace was a log line.** It scrolled past mid-run, in the middle
 *   of a long provisioning transcript, and was never referred to again. Three
 *   `tabsii-com` repos — including the live core platform — ran with `dev`,
 *   `staging` and `main` completely unprotected for about three weeks before
 *   anyone noticed.
 *
 * Backfill is no longer the missing half: `biffo check branch-protection`
 * (#718), its `--fix` (#740), the daily audit (#880) and the `--fix` guard
 * (#934) all exist. What was still missing is that the skip is **structurally
 * invisible at the moment it happens**. This module is that structure: the
 * adapter records a typed outcome per repo, and the scaffolding run prints an
 * explicit end-of-run summary naming every repo it left unprotected.
 *
 * ## Why a run-scoped collector rather than a return value threaded upward
 *
 * `biffo init` creates two repos, and it creates the second one by calling
 * `runSiblingCreate` — through `createAppSibling`, `configureSiblingGithub` and
 * two more frames. Threading an outcome back up would mean changing the
 * signature of every function on both paths, and the summary would still have
 * to be reassembled at the top. A collector the adapter writes to keeps the
 * call sites unchanged and makes the summary cover *every* repo a run touched,
 * whichever entry point created it.
 *
 * The CLI is a one-shot process, so "run-scoped" and "process-scoped" coincide;
 * `resetBranchProtectionOutcomes` exists for tests, which are not.
 */

import { log } from './logger.js'

/**
 * - `applied` — every branch is protected.
 * - `skipped-403` — GitHub refused (plan limitation). Non-fatal by design;
 *   retrying the same call would hit the identical 403. This is the case that
 *   must never again be silent.
 * - `skipped-no-contexts` — the caller could not work out which status checks to
 *   require, so it declined to protect at all. Declining is correct: protection
 *   with an empty context list reads as configured while gating on nothing, and
 *   a PR against it reports CLEAN before any run registers. But the end state is
 *   the same unprotected branch as a 403, reached for a different reason and
 *   with a different remedy — name/fix the CI jobs, not upgrade the plan — so it
 *   gets its own status rather than being folded into `failed` (#1001).
 * - `failed` — anything else went wrong. The adapter still throws, so the run
 *   aborts loudly; the outcome is recorded so the summary can say *which*
 *   branches were left behind when it did.
 */
/**
 * `unsealed` is protection that exists and binds nobody (#1058).
 *
 * It is a distinct status rather than a flavour of `applied` because the repo
 * genuinely IS protected — every required check is listed, the GitHub UI shows a
 * gated branch — and `enforce_admins: false` makes all of it advisory for a repo
 * admin. On an estate where every merge is made by an admin, that is
 * indistinguishable in effect from no protection, which is why `isUnprotected`
 * counts it. 26 of 27 estate branches sat in exactly this state and every audit
 * reported them fine.
 */
export type BranchProtectionStatus =
  'applied' | 'skipped-403' | 'skipped-no-contexts' | 'failed' | 'unsealed'

export interface BranchProtectionOutcome {
  status: BranchProtectionStatus
  org: string
  repo: string
  /** Branches this run confirmed protected. */
  protectedBranches: string[]
  /**
   * Branches this run left unprotected. Non-empty for a partial application:
   * protection is applied branch by branch, so a 403 on `staging` leaves `dev`
   * protected and `staging`/`main` not.
   */
  unprotectedBranches: string[]
  /** The API's own message. Present for anything other than `applied`. */
  reason?: string
}

const pending: BranchProtectionOutcome[] = []

/** Record an outcome for the end-of-run summary. Returns it, for the caller to return on. */
export function recordBranchProtectionOutcome(
  outcome: BranchProtectionOutcome,
): BranchProtectionOutcome {
  pending.push(outcome)
  return outcome
}

/** Outcomes recorded so far and not yet reported. Read-only; use for assertions. */
export function pendingBranchProtectionOutcomes(): readonly BranchProtectionOutcome[] {
  return pending
}

/** Discard everything recorded. For tests — a real run is one process. */
export function resetBranchProtectionOutcomes(): void {
  pending.length = 0
}

/** Did this repo end the run with at least one branch unprotected? */
export function isUnprotected(outcome: BranchProtectionOutcome): boolean {
  return outcome.status !== 'applied' || outcome.unprotectedBranches.length > 0
}

/**
 * The summary lines, as plain strings, so they can be asserted on without
 * capturing console output. Empty when nothing was attempted.
 */
export function formatBranchProtectionSummary(
  outcomes: readonly BranchProtectionOutcome[],
): string[] {
  if (outcomes.length === 0) return []

  const unprotected = outcomes.filter(isUnprotected)
  if (unprotected.length === 0) {
    return [
      `Branch protection applied to ${outcomes
        .map((o) => `${o.org}/${o.repo}`)
        .sort()
        .join(', ')}`,
    ]
  }

  const lines = [
    `Branch protection was NOT fully applied — ${unprotected.length} of ${outcomes.length} ` +
      `repositor${outcomes.length === 1 ? 'y' : 'ies'} created by this run ` +
      `${unprotected.length === 1 ? 'is' : 'are'} unprotected:`,
  ]

  for (const outcome of unprotected) {
    const left = outcome.unprotectedBranches.join(', ') || 'unknown'
    lines.push(
      `  ${outcome.org}/${outcome.repo} — unprotected: ${left} (${whyUnprotected(outcome)})`,
    )
    if (outcome.reason) lines.push(`      ${outcome.reason}`)
  }

  lines.push(
    '  Direct pushes, force-pushes and merges with red or missing checks are all allowed on ' +
      'those branches right now.',
  )

  // An unsealed branch is the one case where that sentence needs qualifying:
  // the rules exist and hold for everyone EXCEPT an admin. Saying "unprotected"
  // without that would misdescribe it, and the misdescription is the whole
  // reason it went unnoticed for weeks (#1052).
  if (unprotected.some((o) => o.status === 'unsealed')) {
    lines.push(
      '  An unsealed branch enforces its rules on everyone except a repo admin — which, on a ' +
        'solo or agent-driven estate, is everyone who merges.',
    )
  }

  // The remedy is not the same for every cause, and saying so is the point of
  // having a fourth status at all (#1001). A 403 is fixed by the plan; an
  // undeterminable context list is fixed by the repo's CI reporting job names
  // that can be required — `--fix` derives them from observed runs, so it only
  // helps once at least one run has completed.
  if (unprotected.some((o) => o.status === 'skipped-no-contexts')) {
    lines.push(
      '  Where the required checks could not be determined, the fix is the CI job names, not ' +
        'the plan: make the workflow report named jobs, let one run complete, then backfill.',
    )
  }
  const has403 = unprotected.some((o) => o.status === 'skipped-403')
  lines.push(
    '  Fix it with:  biffo check branch-protection --fix   ' +
      (has403
        ? '(after upgrading the plan, or making the repo public)'
        : '(it derives the required checks from the runs the repo has actually reported)'),
  )
  return lines
}

/** One clause explaining why a repo ended the run unprotected. */
function whyUnprotected(outcome: BranchProtectionOutcome): string {
  switch (outcome.status) {
    case 'skipped-403':
      return "GitHub returned 403 — the org's plan does not allow branch protection on this repo"
    case 'skipped-no-contexts':
      return (
        'the required status checks could not be determined, and protection requiring ' +
        'nothing reads as configured while gating on nothing'
      )
    case 'failed':
      return 'branch protection failed'
    case 'unsealed':
      return (
        'protection was applied but does not bind admins, so every required check on it ' +
        'is advisory for whoever merges'
      )
    default:
      return 'branch protection incomplete'
  }
}

/**
 * Print the summary and clear what was reported.
 *
 * **Draining is deliberate.** `biffo init` reports at the end of its own run
 * *and* nests a full `runSiblingCreate`, which reports at the end of its. The
 * nested call is the last thing `init` does, so it drains both repos into one
 * summary and the outer call then finds nothing and stays quiet — one summary,
 * covering both repos, instead of two overlapping ones.
 *
 * Silent when nothing was attempted: a resumed run whose GitHub step is already
 * checkpointed never calls the adapter, and inventing a summary for work this
 * run did not do would be its own kind of lie.
 */
export function reportBranchProtectionSummary(): BranchProtectionOutcome[] {
  const outcomes = pending.splice(0, pending.length)
  const lines = formatBranchProtectionSummary(outcomes)
  if (lines.length === 0) return outcomes

  if (outcomes.some(isUnprotected)) {
    // error, not warn: the run succeeded but the repo is missing the governance
    // every later reader assumes is there. #715 is what a warning buys.
    log.error(lines[0]!)
    for (const line of lines.slice(1)) log.error(line)
  } else {
    log.success(lines[0]!)
  }
  return outcomes
}
