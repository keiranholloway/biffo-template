import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CONSISTENCY_THRESHOLD,
  RECENT_COMMIT_WINDOW,
  deriveRequiredContexts,
  formatPlans,
  planProtection,
  protectionParamsFor,
} from './branch-protection-apply.js'

/** Check runs for one commit, newest first when concatenated. */
const on = (sha: string, ...names: string[]) => names.map((name) => ({ name, headSha: sha }))

describe('deriveRequiredContexts', () => {
  it('requires a check that reports on every recent commit', () => {
    const observed = [
      ...on('c3', 'CI', 'Secret Scan'),
      ...on('c2', 'CI', 'Secret Scan'),
      ...on('c1', 'CI', 'Secret Scan'),
    ]
    expect(deriveRequiredContexts(observed)).toEqual(['CI', 'Secret Scan'])
  })

  /**
   * The failure this function exists to avoid. A required context that never
   * reports blocks every merge on the branch permanently — strictly worse than
   * the missing protection being fixed.
   */
  it('does not require a one-off run', () => {
    const observed = [
      ...on('c3', 'CI'),
      ...on('c2', 'CI'),
      ...on('c1', 'CI', 'Manual Dispatch Only'),
    ]
    expect(deriveRequiredContexts(observed)).toEqual(['CI'])
  })

  /**
   * A genuinely required check can miss a single commit — a cancelled run, a
   * `paths:` filter, or GitHub creating no run at all (which has happened in
   * this project). Demanding 100% would drop real checks.
   */
  it('tolerates a check missing one commit out of three', () => {
    const observed = [
      ...on('c3', 'CI', 'Terraform'),
      ...on('c2', 'CI'),
      ...on('c1', 'CI', 'Terraform'),
    ]
    expect(deriveRequiredContexts(observed)).toEqual(['CI', 'Terraform'])
  })

  it('looks back only over the recent window', () => {
    const old = Array.from({ length: RECENT_COMMIT_WINDOW + 3 }, (_, i) => on(`old${i}`, 'Retired'))
    const recent = Array.from({ length: RECENT_COMMIT_WINDOW }, (_, i) => on(`new${i}`, 'CI'))
    const observed = [...recent.flat(), ...old.flat()]
    expect(deriveRequiredContexts(observed)).toEqual(['CI'])
  })

  it('returns nothing when no checks have been observed', () => {
    expect(deriveRequiredContexts([])).toEqual([])
  })

  it('is sorted, so the result is stable and diffable', () => {
    const observed = [...on('c2', 'Zeta', 'Alpha'), ...on('c1', 'Zeta', 'Alpha')]
    expect(deriveRequiredContexts(observed)).toEqual(['Alpha', 'Zeta'])
  })

  it('uses a two-thirds threshold', () => {
    expect(CONTEXT_CONSISTENCY_THRESHOLD).toBeCloseTo(2 / 3)
  })
})

describe('protectionParamsFor', () => {
  /**
   * Backfilled protection must be indistinguishable from protection applied at
   * scaffold time, or the repo ends up on a second policy that drifts from the
   * first.
   */
  it('matches what configureBranchProtection applies at scaffold time', () => {
    const params = protectionParamsFor(['CI'])
    expect(params).toEqual({
      required_status_checks: { strict: true, contexts: ['CI'] },
      enforce_admins: false,
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        dismiss_stale_reviews: false,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
    })
  })

  /** Without strict, a green branch can merge against code it never saw. */
  it('defaults to requiring branches to be up to date', () => {
    // Renamed from "always requires" when strict became a parameter (#808). The
    // default is unchanged and is still the right one for a backfill; "always" was
    // the property that silently fought a running experiment.
    expect(protectionParamsFor(['CI']).required_status_checks.strict).toBe(true)
  })

  it('can preserve a deliberately relaxed strict (#808)', () => {
    // Experiment H3 has strict:false on biffo-template's dev until 2026-08-11. The
    // audit reports that as a `not-strict` finding, any finding makes --fix
    // eligible, and --fix used to force strict:true back on with no message — so
    // running the estate's own protection guard reverted the experiment.
    expect(protectionParamsFor(['CI'], { strict: false }).required_status_checks.strict).toBe(false)
  })

  it('changes nothing else when strict is relaxed', () => {
    // The relaxation must be surgical. If passing strict:false also dropped
    // required_linear_history or re-enabled force pushes, this would be a much
    // worse bug than the one being fixed.
    const withoutChecks = (contexts: string[], options?: { strict?: boolean }) => {
      const params: Record<string, unknown> = { ...protectionParamsFor(contexts, options) }
      delete params.required_status_checks
      return params
    }
    expect(withoutChecks(['CI'], { strict: false })).toEqual(withoutChecks(['CI']))
  })
})

describe('planProtection', () => {
  const solid = [...on('c3', 'CI'), ...on('c2', 'CI'), ...on('c1', 'CI')]

  it('applies protection to an existing branch with consistent checks', () => {
    const plan = planProtection('dev', true, solid)
    expect(plan.action).toBe('apply')
    expect(plan.contexts).toEqual(['CI'])
  })

  /**
   * Repos legitimately differ — `tabsii-runners` and `tabsii-map` have no `dev`
   * at all (pre-#559). Failing on an absent branch would report a migration gap
   * as a protection gap.
   */
  it('skips a branch that does not exist', () => {
    const plan = planProtection('staging', false, solid)
    expect(plan.action).toBe('skip')
    expect(plan.reason).toContain('does not exist')
  })

  /**
   * The trap that makes this whole area worth guarding: protection requiring no
   * checks reports CLEAN the instant a PR opens, so "checks passed" and "no
   * checks required" are indistinguishable to `gh pr merge --auto`. Applying it
   * would silence the audit while changing nothing.
   */
  it('refuses to apply protection with an empty context list', () => {
    const plan = planProtection('dev', true, [])
    expect(plan.action).toBe('skip')
    expect(plan.reason).toContain('admitting any PR')
  })
})

describe('formatPlans', () => {
  it('names each required context on an apply', () => {
    const text = formatPlans([planProtection('dev', true, [...on('c2', 'CI'), ...on('c1', 'CI')])])
    expect(text).toContain('dev: apply')
    expect(text).toContain('• CI')
  })

  it('gives the reason on a skip', () => {
    const text = formatPlans([planProtection('main', false, [])])
    expect(text).toContain('main: skip')
    expect(text).toContain('does not exist')
  })
})
