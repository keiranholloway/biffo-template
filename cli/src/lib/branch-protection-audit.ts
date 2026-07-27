/**
 * Is a branch's protection actually doing its job? (#715)
 *
 * `configureBranchProtection` sets protection once, at scaffold time, and
 * **skips it entirely on a 403** — which is what GitHub returns for a private
 * org-owned repo on a plan below Team. The skip logs a warning and lets the
 * scaffold report success, so the repo is created without governance and
 * nothing ever says so again.
 *
 * That is not hypothetical: three `tabsii-com` repos, including the live core
 * platform, ran with `dev`, `staging` and `main` all unprotected for three
 * weeks. The org had upgraded its plan days after they were created, so the
 * 403 no longer applied — but nothing re-attempts, and nothing audits, so the
 * state persisted silently. Eight PRs merged into an unprotected default
 * branch in a single session.
 *
 * This module is the missing audit. It is deliberately **policy-shaped, not
 * config-shaped**: it asserts the properties protection must have, and does
 * not compare against a fixed list of required checks.
 *
 * That distinction matters and was learned the hard way. Repos legitimately
 * run different jobs — at the time of writing `tabsii-platform` requires 5
 * contexts, `tabsii-crm` 5 different ones (no `Release Guards`, plus
 * `E2E (Playwright)`), and `tabsii-intake` 11 from an older CI generation.
 * Asserting a canonical list would either force every repo onto identical CI
 * or, worse, require a context that never reports — which blocks every merge
 * on that branch permanently.
 */

/** The subset of GitHub's branch-protection response this audit reads. */
export interface BranchProtection {
  required_status_checks?: { strict?: boolean; contexts?: string[] } | null
  allow_force_pushes?: { enabled?: boolean } | null
  allow_deletions?: { enabled?: boolean } | null
}

export interface BranchProtectionFinding {
  branch: string
  /** Machine-readable so callers can treat "absent" differently from "weak". */
  kind:
    'unprotected' | 'no-required-checks' | 'not-strict' | 'force-push-allowed' | 'deletion-allowed'
  detail: string
}

/**
 * Audit one branch. `protection` is `null` when GitHub answered 404, which is
 * how it reports "this branch has no protection at all" — the state the 403
 * skip leaves behind.
 */
export function auditBranch(
  branch: string,
  protection: BranchProtection | null,
): BranchProtectionFinding[] {
  if (protection === null) {
    return [
      {
        branch,
        kind: 'unprotected',
        detail:
          'no branch protection at all — direct pushes, force-pushes and merges with red or absent checks are all permitted',
      },
    ]
  }

  const findings: BranchProtectionFinding[] = []
  const checks = protection.required_status_checks

  // An empty context list is the trap that makes this worth auditing at all: a
  // PR reports `CLEAN` the instant it opens, before any run has registered, so
  // "checks passed" and "no checks are required" are indistinguishable to
  // anything reading merge state — including `gh pr merge --auto`.
  if (!checks || (checks.contexts ?? []).length === 0) {
    findings.push({
      branch,
      kind: 'no-required-checks',
      detail:
        'protection exists but requires no status checks, so a PR is mergeable before any check has run',
    })
  } else if (checks.strict !== true) {
    // Only meaningful once something is required.
    findings.push({
      branch,
      kind: 'not-strict',
      detail:
        'required checks are not strict, so a branch can merge without being up to date with the base',
    })
  }

  if (protection.allow_force_pushes?.enabled === true) {
    findings.push({ branch, kind: 'force-push-allowed', detail: 'force-pushes are permitted' })
  }
  if (protection.allow_deletions?.enabled === true) {
    findings.push({ branch, kind: 'deletion-allowed', detail: 'branch deletion is permitted' })
  }

  return findings
}

/** Render findings for a terminal, grouped by branch in the order given. */
export function formatFindings(findings: BranchProtectionFinding[]): string {
  return findings.map((f) => `  ${f.branch}: ${f.detail}`).join('\n')
}
