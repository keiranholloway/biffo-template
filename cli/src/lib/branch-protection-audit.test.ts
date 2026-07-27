import { describe, expect, it } from 'vitest'
import { auditBranch, formatFindings } from './branch-protection-audit.js'

const healthy = {
  required_status_checks: { strict: true, contexts: ['CI'] },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
}

describe('auditBranch', () => {
  it('passes a branch protected the way the scaffolding intends', () => {
    expect(auditBranch('dev', healthy)).toEqual([])
  })

  it('reports the 403-skip state: no protection at all', () => {
    // GitHub answers 404 for an unprotected branch; the caller maps that to
    // null. This is exactly what three tabsii repos looked like for 3 weeks.
    const [finding, ...rest] = auditBranch('dev', null)
    expect(rest).toEqual([])
    expect(finding?.kind).toBe('unprotected')
    expect(finding?.branch).toBe('dev')
  })

  it('reports protection that requires no checks', () => {
    const findings = auditBranch('dev', {
      ...healthy,
      required_status_checks: { strict: true, contexts: [] },
    })
    expect(findings.map((f) => f.kind)).toEqual(['no-required-checks'])
  })

  it('treats a missing required_status_checks block as requiring no checks', () => {
    const findings = auditBranch('dev', { ...healthy, required_status_checks: null })
    expect(findings.map((f) => f.kind)).toEqual(['no-required-checks'])
  })

  it('does not also report not-strict when nothing is required', () => {
    // Otherwise one misconfiguration reads as two, and the fix for the second
    // ("set strict") does not address the first.
    const findings = auditBranch('dev', { required_status_checks: { strict: false, contexts: [] } })
    expect(findings.map((f) => f.kind)).toEqual(['no-required-checks'])
  })

  it('reports non-strict checks once something is required', () => {
    const findings = auditBranch('dev', {
      ...healthy,
      required_status_checks: { strict: false, contexts: ['CI'] },
    })
    expect(findings.map((f) => f.kind)).toEqual(['not-strict'])
  })

  it('reports force-push and deletion independently', () => {
    const findings = auditBranch('dev', {
      ...healthy,
      allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: true },
    })
    expect(findings.map((f) => f.kind)).toEqual(['force-push-allowed', 'deletion-allowed'])
  })

  it('accepts any non-empty context list, whatever the repo actually runs', () => {
    // The policy is deliberately not a canonical context list: tabsii-platform
    // requires 5, tabsii-crm 5 different ones, tabsii-intake 11 from an older
    // CI generation. Asserting a fixed list would force identical CI, or
    // require a context that never reports — which blocks every merge forever.
    const eleven = Array.from({ length: 11 }, (_, i) => `Job ${i}`)
    expect(
      auditBranch('dev', {
        ...healthy,
        required_status_checks: { strict: true, contexts: eleven },
      }),
    ).toEqual([])
    expect(
      auditBranch('dev', {
        ...healthy,
        required_status_checks: { strict: true, contexts: ['E2E (Playwright)'] },
      }),
    ).toEqual([])
  })
})

describe('formatFindings', () => {
  it('names the branch on every line so multi-branch output is readable', () => {
    const out = formatFindings([...auditBranch('dev', null), ...auditBranch('main', null)])
    expect(out).toContain('dev:')
    expect(out).toContain('main:')
  })
})
