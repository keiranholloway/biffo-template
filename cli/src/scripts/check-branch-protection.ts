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

export async function runBranchProtectionCheck(explicitRepo?: string): Promise<void> {
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

  if (findings.length > 0) {
    console.error(`✗ branch-protection guard: ${owner}/${repo}\n`)
    console.error(formatFindings(findings))
    console.error(
      '\n  Protection is applied once at scaffold time and skipped silently on a 403 (#715).\n' +
        '  Fix with the repo settings API, matching the policy — not the exact required\n' +
        '  checks, which legitimately differ per repo.',
    )
    process.exit(1)
  }

  console.log(`✓ branch-protection guard: ${owner}/${repo} (${audited.join(', ')}) OK`)
}
