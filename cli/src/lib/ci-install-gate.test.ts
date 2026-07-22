import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guard for the install-gate invariant in `.github/workflows/ci.yml` (#393).
 *
 * Check steps run on `!cancelled() && steps.install.outcome == 'success'` so
 * that a failed dependency install produces one honest error instead of a pile
 * of misleading `tsx: not found`s in its wake.
 *
 * The trap is that GitHub resolves `steps.install.outcome` to an **empty
 * string** in a job that has no step with `id: install` — so the condition is
 * false and every gated step silently *skips*. A job would go green having run
 * none of its checks, which is the worst possible failure for a CI guard: it
 * looks like success.
 *
 * I nearly shipped exactly that by applying the gate with a global
 * find-and-replace across the file, which caught jobs that install nothing.
 *
 * `.github/` is template-owned, so this file — and this assertion — reach every
 * instance, where the same invariant applies to the same workflow.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CI = join(repoRoot, '.github/workflows/ci.yml')

interface Job {
  name: string
  hasInstallStep: boolean
  gatedSteps: number
}

/**
 * Line-based, matching how `status-checks.test.ts` reads the same file — the
 * repo has no YAML parser dependency, and adding one to assert two properties
 * is not worth it. Comment lines are skipped, so the explanatory comment above
 * the jobs (which names the expression) is not mistaken for a usage.
 */
function parseJobs(source: string): Job[] {
  const jobs: Job[] = []
  let inJobs = false
  let current: Job | undefined

  for (const raw of source.split('\n')) {
    if (raw.trimStart().startsWith('#')) continue
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue

    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(raw)
    if (header?.[1]) {
      current = { name: header[1], hasInstallStep: false, gatedSteps: 0 }
      jobs.push(current)
      continue
    }
    if (!current) continue
    if (/\bid:\s*install\b/.test(raw)) current.hasInstallStep = true
    if (raw.includes('steps.install.outcome')) current.gatedSteps++
  }
  return jobs
}

describe('ci.yml install gate', () => {
  const jobs = parseJobs(readFileSync(CI, 'utf8'))

  it('finds the jobs at all', () => {
    // Non-vacuity: a parser that silently matches nothing would pass every
    // assertion below while checking nothing.
    expect(jobs.length).toBeGreaterThan(3)
    expect(jobs.map((j) => j.name)).toContain('js')
    expect(jobs.map((j) => j.name)).toContain('python')
  })

  it('gates the check steps of every job that installs dependencies', () => {
    for (const job of jobs.filter((j) => j.hasInstallStep)) {
      expect(job.gatedSteps, `${job.name} installs deps but gates no steps`).toBeGreaterThan(0)
    }
  })

  it('never gates on an install step the job does not have', () => {
    // The silent-skip trap: `steps.install.outcome` is '' in such a job, so
    // every gated step is skipped and the job goes green having run nothing.
    const broken = jobs.filter((j) => j.gatedSteps > 0 && !j.hasInstallStep).map((j) => j.name)
    expect(broken).toEqual([])
  })

  it('negative control: the parser can actually detect the broken shape', () => {
    // Otherwise the assertion above proves nothing.
    const broken = parseJobs(
      [
        'jobs:',
        '  lonely:',
        '    steps:',
        "      - if: ${{ steps.install.outcome == 'success' }}",
      ].join('\n'),
    )
    expect(broken).toHaveLength(1)
    expect(broken[0]?.gatedSteps).toBe(1)
    expect(broken[0]?.hasInstallStep).toBe(false)
  })

  it('negative control: a comment mentioning the expression is not a usage', () => {
    const commented = parseJobs(
      [
        'jobs:',
        '  documented:',
        "    # uses steps.install.outcome == 'success'",
        '    steps: []',
      ].join('\n'),
    )
    expect(commented[0]?.gatedSteps).toBe(0)
  })
})
