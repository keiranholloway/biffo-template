/**
 * CI/ad-hoc entrypoint for the branch-protection guard (#715).
 *
 * `configureBranchProtection` applies protection **once**, at scaffold time,
 * and returns quietly on a 403 — the answer GitHub gives for a private
 * org-owned repo on a plan below Team. Nothing re-attempts and nothing audits,
 * so a repo scaffolded during a 403 window stays unprotected indefinitely even
 * after the plan is upgraded. Three `tabsii-com` repos did exactly that for
 * three weeks, including the live core platform.
 *
 * This is the audit that closes it. Run it against any managed repo:
 *
 *     biffo check branch-protection
 *     biffo check branch-protection --repo tabsii-com/tabsii-crm
 *
 * Only branches that **exist** are audited — repos legitimately differ here
 * (`tabsii-runners` and `tabsii-map` have no `dev` at all, being pre-#559),
 * and failing on an absent branch would report a migration gap as a protection
 * gap.
 */
import { Octokit } from '@octokit/rest'
import { execa } from 'execa'
import {
  type ObservedCheck,
  formatPlans,
  planProtection,
  protectionParamsFor,
} from '../lib/branch-protection-apply.js'
import {
  type BranchProtectionFinding,
  auditBranch,
  formatFindings,
} from '../lib/branch-protection-audit.js'

const BRANCHES = ['dev', 'staging', 'main']

function tokenFromEnv(): string {
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? ''
  if (!token) {
    console.error(
      '✗ branch-protection guard: no GitHub token.\n' +
        '  Set GITHUB_TOKEN or GH_TOKEN. Reading protection needs admin on the repo,\n' +
        '  so a default read-only CI token is not enough — this guard is meant to be\n' +
        '  run deliberately, not on every PR.',
    )
    process.exit(2)
  }
  return token
}

/** `owner/repo` from `--repo`, else the current checkout's `origin` remote. */
async function resolveRepo(explicit?: string): Promise<{ owner: string; repo: string }> {
  if (explicit) {
    const [owner, repo] = explicit.split('/')
    if (!owner || !repo) {
      console.error(`✗ branch-protection guard: --repo must be "owner/name", got "${explicit}"`)
      process.exit(2)
    }
    return { owner, repo }
  }
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'])
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(stdout.trim())
  if (!m?.[1] || !m[2]) {
    console.error(
      `✗ branch-protection guard: cannot parse a GitHub repo from origin "${stdout.trim()}"`,
    )
    process.exit(2)
  }
  return { owner: m[1], repo: m[2] }
}

/**
 * Recent check runs on the repo, newest first, as `deriveRequiredContexts` wants
 * them. Read from the default branch: that is where the checks a PR must satisfy
 * actually report.
 */
async function observedChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<ObservedCheck[]> {
  const { data } = await octokit.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    branch,
    per_page: 60,
  })
  return data.workflow_runs
    .filter((r) => r.status === 'completed')
    .map((r) => ({ name: r.name ?? '', headSha: r.head_sha }))
    .filter((c) => c.name !== '')
}

export async function runBranchProtectionCheck(
  explicitRepo?: string,
  options: { fix?: boolean | undefined } = {},
): Promise<void> {
  const { owner, repo } = await resolveRepo(explicitRepo)
  // 404 is control flow here — "this branch has no protection" is the finding,
  // not an error — so silence Octokit's default request log, which would print
  // a stack-ish line per absent branch and bury the actual report.
  const octokit = new Octokit({
    auth: tokenFromEnv(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: console.error },
  })

  const findings: BranchProtectionFinding[] = []
  const audited: string[] = []
  /** Branch → the `strict` already in force, for branches that ARE protected (#808). */
  const observedStrict = new Map<string, boolean>()
  /** Branch → the `enforce_admins` already in force, same reasoning (#1052). */
  const observedEnforceAdmins = new Map<string, boolean>()

  for (const branch of BRANCHES) {
    // Skip branches this repo does not have, rather than reporting them.
    try {
      await octokit.repos.getBranch({ owner, repo, branch })
    } catch (err) {
      if ((err as { status?: number }).status === 404) continue
      throw err
    }
    audited.push(branch)

    try {
      const { data } = await octokit.repos.getBranchProtection({ owner, repo, branch })
      findings.push(...auditBranch(branch, data))
      // Remember a deliberately-relaxed `strict` so --fix cannot revert it (#808).
      // Absent protection leaves this unset, which is what makes the backfill
      // still apply the full policy.
      observedStrict.set(branch, data.required_status_checks?.strict ?? false)
      observedEnforceAdmins.set(branch, data.enforce_admins?.enabled ?? false)
    } catch (err) {
      // 404 here means "branch exists, protection does not" — the state the
      // 403 skip leaves behind, and the whole reason this guard exists.
      if ((err as { status?: number }).status === 404) {
        findings.push(...auditBranch(branch, null))
        continue
      }
      if ((err as { status?: number }).status === 403) {
        console.error(
          `✗ branch-protection guard: GitHub returned 403 reading ${owner}/${repo}.\n` +
            '  Either the token lacks admin, or this org/plan cannot protect private repos.\n' +
            '  The latter is the condition that caused #715 — protection was skipped at\n' +
            '  scaffold time and never revisited. It is a finding, not a reason to pass.',
        )
        process.exit(1)
      }
      throw err
    }
  }

  if (audited.length === 0) {
    console.error(
      `✗ branch-protection guard: ${owner}/${repo} has none of ${BRANCHES.join('/')}.\n` +
        '  A repo with no dev branch has not been migrated (biffo-template#559).',
    )
    process.exit(1)
  }

  if (findings.length > 0 && options.fix) {
    // Backfill. Both #714 (repos the CLI never created, so protection was never
    // attempted) and #715 (protection attempted, 403'd, never revisited) end in
    // the same state, and this is the only path that gets them out of it.
    const defaultBranch = (await octokit.repos.get({ owner, repo })).data.default_branch
    const observed = await observedChecks(octokit, owner, repo, defaultBranch)
    const plans = audited.map((branch) => planProtection(branch, true, observed))

    console.log(`Backfilling protection on ${owner}/${repo}:\n`)
    console.log(formatPlans(plans))

    let applied = 0
    let preservedStrict = 0
    let preservedAdmins = 0
    for (const plan of plans.filter((p) => p.action === 'apply')) {
      // Preserve a `strict: false` that is ALREADY in force (#808). An absent
      // protection leaves `observedStrict` unset and gets the full policy, which
      // is the gap this command exists to close; a present-but-relaxed setting is
      // somebody's decision — H3 has exactly this on biffo-template's dev until
      // 2026-08-11 — and backfilling a gap must not overwrite a decision.
      const existing = observedStrict.get(plan.branch)
      const strict = existing ?? true
      if (existing === false) {
        preservedStrict += 1
        console.log(
          `  ${plan.branch}: keeping strict=false — already set on this branch, so it is a\n` +
            '      decision rather than a gap. Change it deliberately with `gh api`, not here.',
        )
      }
      // Same split for enforce_admins (#1052). Absent protection gets the full
      // policy, which now BINDS — this function used to write `false` here and
      // re-open the bypass over a branch somebody had just bound by hand.
      const existingAdmins = observedEnforceAdmins.get(plan.branch)
      const enforceAdmins = existingAdmins ?? true
      if (existingAdmins === false) {
        preservedAdmins += 1
        console.log(
          `  ${plan.branch}: keeping enforce_admins=false — already set on this branch, so it\n` +
            '      is a decision rather than a gap. Note that protection which does not bind an\n' +
            '      admin is advisory for whoever merges; scripts/protection-audit.sh fails on it.',
        )
      }
      await octokit.repos.updateBranchProtection({
        owner,
        repo,
        branch: plan.branch,
        ...protectionParamsFor(plan.contexts, { strict, enforceAdmins }),
      })
      applied += 1
    }

    if (applied === 0) {
      console.error(
        '\n✗ nothing applied — no branch had a check reporting consistently enough to require.\n' +
          '  Protection with an empty context list is worse than none: a PR reads CLEAN before\n' +
          '  any run registers. Get CI reporting on this repo first.',
      )
      process.exit(1)
    }

    console.log(
      `\n✓ protection applied to ${applied} branch(es)` +
        (preservedStrict > 0 ? `, ${preservedStrict} keeping an existing strict=false` : '') +
        (preservedAdmins > 0
          ? `, ${preservedAdmins} keeping an existing enforce_admins=false`
          : '') +
        '. Re-run without --fix to verify.',
    )
    return
  }

  if (findings.length > 0) {
    console.error(`✗ branch-protection guard: ${owner}/${repo}\n`)
    console.error(formatFindings(findings))
    console.error(
      '\n  Protection is applied once at scaffold time and skipped silently on a 403 (#715),\n' +
        '  and standalone plugin repos are created outside the CLI so it never runs at all\n' +
        '  (#714). Re-run with --fix to backfill it from the checks this repo actually reports.',
    )
    process.exit(1)
  }

  console.log(`✓ branch-protection guard: ${owner}/${repo} (${audited.join(', ')}) OK`)
}
