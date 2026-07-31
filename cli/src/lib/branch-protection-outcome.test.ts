/**
 * The end-of-run branch-protection summary (#715, #737 item 2).
 *
 * The property under test is not "protection gets applied" — that was never the
 * bug. It is that a run which did **not** apply protection cannot end quietly.
 * Every assertion here is about visibility: the outcome is typed, the skip is
 * distinguishable from success, and the summary names the repo and the branches
 * that are still open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatBranchProtectionSummary,
  isUnprotected,
  pendingBranchProtectionOutcomes,
  recordBranchProtectionOutcome,
  reportBranchProtectionSummary,
  resetBranchProtectionOutcomes,
  type BranchProtectionOutcome,
} from './branch-protection-outcome.js'
import { log } from './logger.js'

vi.mock('./logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function outcome(overrides: Partial<BranchProtectionOutcome> = {}): BranchProtectionOutcome {
  return {
    status: 'applied',
    org: 'acme',
    repo: 'my-app',
    protectedBranches: ['dev', 'staging', 'main'],
    unprotectedBranches: [],
    ...overrides,
  }
}

const skipped403 = outcome({
  status: 'skipped-403',
  protectedBranches: [],
  unprotectedBranches: ['dev', 'staging', 'main'],
  reason: 'Upgrade to GitHub Team or make this repository public to enable this feature.',
})

/**
 * The plugin path's second gap (#1001): `biffo plugin create` could not derive
 * the CI job contexts, so it declined to protect at all. Declining is right —
 * see `planProtection` — but the end state is the same unprotected branch, for
 * a reason that is neither a 403 nor a failure.
 */
const skippedNoContexts = outcome({
  status: 'skipped-no-contexts',
  repo: 'biffo-plugin-ideation',
  protectedBranches: [],
  unprotectedBranches: ['dev'],
  reason: 'No status-check contexts could be derived from .github/workflows/ci.yml.',
})

beforeEach(() => {
  vi.clearAllMocks()
  resetBranchProtectionOutcomes()
})

describe('isUnprotected', () => {
  it('is false only when every branch was protected', () => {
    expect(isUnprotected(outcome())).toBe(false)
  })

  it('is true for a 403 skip', () => {
    expect(isUnprotected(skipped403)).toBe(true)
  })

  it('is true for a hard failure', () => {
    expect(isUnprotected(outcome({ status: 'failed', unprotectedBranches: ['main'] }))).toBe(true)
  })

  it('is true when the contexts could not be determined', () => {
    expect(isUnprotected(skippedNoContexts)).toBe(true)
  })

  it('is true for a PARTIAL application — the 403 arrived after dev was protected', () => {
    // Protection is applied branch by branch, so "the call did not throw" and
    // "the repo is protected" are different claims even on the success status.
    expect(
      isUnprotected(
        outcome({ protectedBranches: ['dev'], unprotectedBranches: ['staging', 'main'] }),
      ),
    ).toBe(true)
  })
})

describe('formatBranchProtectionSummary', () => {
  it('says nothing when the run attempted nothing', () => {
    // A resumed run whose GitHub step is already checkpointed never calls the
    // adapter. Printing a summary for work this run did not do would be a lie
    // in the opposite direction.
    expect(formatBranchProtectionSummary([])).toEqual([])
  })

  it('names every repo it left unprotected, and the branches', () => {
    const lines = formatBranchProtectionSummary([outcome({ repo: 'my-app-app' }), skipped403]).join(
      '\n',
    )

    expect(lines).toContain('acme/my-app')
    expect(lines).toContain('dev, staging, main')
    expect(lines).toContain('1 of 2')
    // The remediation is the backfill that now exists (#718/#740), not "add it
    // later via the GitHub UI" — the advice #715 was actually given.
    expect(lines).toContain('biffo check branch-protection --fix')
  })

  it('surfaces the API’s own 403 message rather than paraphrasing it', () => {
    expect(formatBranchProtectionSummary([skipped403]).join('\n')).toContain(
      'Upgrade to GitHub Team or make this repository public',
    )
  })

  it('does not name a repo that IS protected in the unprotected list', () => {
    const lines = formatBranchProtectionSummary([outcome({ repo: 'fine' }), skipped403])
    const named = lines.filter((l) => l.includes('acme/fine'))
    expect(named).toEqual([])
  })

  it('reports a clean run as applied', () => {
    expect(formatBranchProtectionSummary([outcome()])).toEqual([
      'Branch protection applied to acme/my-app',
    ])
  })

  // ─── #1001: the two causes must not read the same ─────────────────────────

  it('names the undeterminable-contexts repo and says the contexts were the problem', () => {
    const lines = formatBranchProtectionSummary([skippedNoContexts]).join('\n')

    expect(lines).toContain('acme/biffo-plugin-ideation')
    expect(lines).toContain('unprotected: dev')
    expect(lines).toContain('could not be determined')
  })

  it('gives the CI-job remedy, not the upgrade-the-plan one, when contexts were the cause', () => {
    // Two causes, two remedies. Telling someone to upgrade their plan when the
    // problem is an unnamed CI job sends them somewhere that cannot help.
    const lines = formatBranchProtectionSummary([skippedNoContexts]).join('\n')

    expect(lines).toContain('the fix is the CI job names, not the plan')
    expect(lines).not.toContain('after upgrading the plan')
  })

  it('gives the plan remedy for a 403, and both when a run hit both causes', () => {
    expect(formatBranchProtectionSummary([skipped403]).join('\n')).toContain(
      'after upgrading the plan',
    )

    const both = formatBranchProtectionSummary([skipped403, skippedNoContexts]).join('\n')
    expect(both).toContain('the fix is the CI job names, not the plan')
    expect(both).toContain('after upgrading the plan')
    expect(both).toContain('2 of 2')
  })
})

describe('reportBranchProtectionSummary', () => {
  it('logs an UNPROTECTED run at error level, not as a warning', () => {
    // The whole defect was that a warning is indistinguishable from noise in a
    // long provisioning transcript. Downgrading this to `warn` reinstates #715.
    recordBranchProtectionOutcome(skipped403)

    reportBranchProtectionSummary()

    expect(log.error).toHaveBeenCalled()
    expect(vi.mocked(log.error).mock.calls.flat().join('\n')).toContain('acme/my-app')
    expect(log.success).not.toHaveBeenCalled()
  })

  it('stays silent when nothing was attempted', () => {
    reportBranchProtectionSummary()

    expect(log.error).not.toHaveBeenCalled()
    expect(log.success).not.toHaveBeenCalled()
  })

  it('drains, so `biffo init`’s two nested reports print one summary between them', () => {
    // `runInit` reports at the end of its own run AND nests a full
    // `runSiblingCreate` that reports at the end of its. Without draining the
    // core repo would be named twice.
    recordBranchProtectionOutcome(skipped403)
    recordBranchProtectionOutcome(outcome({ repo: 'my-app-app' }))

    const first = reportBranchProtectionSummary()
    const second = reportBranchProtectionSummary()

    expect(first).toHaveLength(2)
    expect(second).toEqual([])
    expect(pendingBranchProtectionOutcomes()).toEqual([])
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(
      formatBranchProtectionSummary([skipped403, outcome({ repo: 'my-app-app' })]).length,
    )
  })
})
