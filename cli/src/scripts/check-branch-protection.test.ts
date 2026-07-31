/**
 * `biffo check branch-protection` against a **plugin** repo (#1001).
 *
 * The end-of-run summary the scaffold now prints points every unprotected repo
 * at `biffo check branch-protection --fix`. Plugin repos are non-deployable and
 * have `dev` only (AGENTS.md §2), whereas this audit was written for the
 * deployable shape and iterates `dev`/`staging`/`main`. #1001 flagged that as
 * something to verify rather than assume — recommending a remediation that
 * cannot run is worse than recommending none.
 *
 * These tests are that verification, exercised through `runBranchProtectionCheck`
 * itself rather than reasoned about from the source.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runBranchProtectionCheck } from './check-branch-protection.js'

const octokitMock = {
  repos: {
    get: vi.fn(),
    getBranch: vi.fn(),
    getBranchProtection: vi.fn(),
    updateBranchProtection: vi.fn(),
  },
  actions: {
    listWorkflowRunsForRepo: vi.fn(),
  },
}

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function () {
    return octokitMock
  }),
}))

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: 'https://github.com/acme/biffo-plugin-x.git' }),
}))

function notFound() {
  return Object.assign(new Error('Branch not found'), { status: 404 })
}

/** A plugin repo: `dev` exists, `staging`/`main` do not, and nothing is protected. */
function devOnlyRepo(): void {
  octokitMock.repos.getBranch.mockImplementation(async ({ branch }: { branch: string }) => {
    if (branch === 'dev') return { data: {} }
    throw notFound()
  })
  octokitMock.repos.getBranchProtection.mockRejectedValue(notFound())
  octokitMock.repos.get.mockResolvedValue({ data: { default_branch: 'dev' } })
  octokitMock.repos.updateBranchProtection.mockResolvedValue({})
  // Six commits, each with the plugin CI's own job names reporting — enough for
  // `deriveRequiredContexts` to treat them as consistently required.
  octokitMock.actions.listWorkflowRunsForRepo.mockResolvedValue({
    data: {
      workflow_runs: ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((sha) =>
        ['Lint', 'Test'].map((name) => ({ name, head_sha: sha, status: 'completed' })),
      ),
    },
  })
}

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  process.env['GITHUB_TOKEN'] = 'gh-token'
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // `process.exit` is `never`-typed and really does end the process, so it has
  // to become a throw for the assertions after it to be reachable.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

describe('a dev-only plugin repo', () => {
  it('audits dev and does NOT report the absent staging/main as unprotected', async () => {
    devOnlyRepo()

    await expect(runBranchProtectionCheck('acme/biffo-plugin-x')).rejects.toThrow('process.exit(1)')

    // Exit 1 because `dev` genuinely has no protection — that is the finding.
    // What must not appear is a finding for a branch the repo is right not to
    // have: that would report a repo shape as a governance gap.
    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('dev:')
    expect(reported).not.toContain('staging:')
    expect(reported).not.toContain('main:')
  })

  it('does not mistake a plugin repo for an unmigrated one', async () => {
    // The `audited.length === 0` bail says "has not been migrated (#559)". A
    // repo with dev and nothing else is the *correct* plugin shape, not that.
    devOnlyRepo()

    await expect(runBranchProtectionCheck('acme/biffo-plugin-x')).rejects.toThrow('process.exit(1)')

    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('has none of')
  })

  it('--fix backfills dev alone, with the contexts the plugin CI actually reports', async () => {
    devOnlyRepo()

    await runBranchProtectionCheck('acme/biffo-plugin-x', { fix: true })

    expect(octokitMock.repos.updateBranchProtection).toHaveBeenCalledTimes(1)
    const call = octokitMock.repos.updateBranchProtection.mock.calls[0]?.[0] as {
      branch: string
      required_status_checks: { strict: boolean; contexts: string[] }
    }
    expect(call.branch).toBe('dev')
    expect(call.required_status_checks.contexts).toEqual(['Lint', 'Test'])
    expect(call.required_status_checks.strict).toBe(true)
  })

  it('--fix reads the observed runs from dev, the repo’s own default branch', async () => {
    // Not a hardcoded `main`: a plugin repo has none, so a wrong default here
    // would return no runs, derive no contexts, and refuse to apply anything.
    devOnlyRepo()

    await runBranchProtectionCheck('acme/biffo-plugin-x', { fix: true })

    expect(octokitMock.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'dev' }),
    )
  })

  it('--fix refuses rather than applying an empty context list when CI has never reported', async () => {
    devOnlyRepo()
    octokitMock.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } })

    await expect(runBranchProtectionCheck('acme/biffo-plugin-x', { fix: true })).rejects.toThrow(
      'process.exit(1)',
    )

    expect(octokitMock.repos.updateBranchProtection).not.toHaveBeenCalled()
  })
})
