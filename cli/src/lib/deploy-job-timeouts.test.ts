/**
 * Every job in `deploy-app.yml` must be bounded, and a failed deploy must say so.
 *
 * A job with no `timeout-minutes` inherits GitHub's 360-minute default. That is
 * not a theoretical cost here: on a self-hosted fleet a reclaimed runner does
 * not fail the job, it stops answering — the running step's conclusion comes
 * back `null`, which reads as "still going" for six hours and is
 * indistinguishable from success afterwards. tabsii-platform's core Lambda sat
 * ~21 hours behind `dev` that way while the PR was green, the issue was closed,
 * and CI was passing (#973). #980 bounded `ci.yml`'s jobs; this workflow got
 * nothing, and it is the one whose silent failure leaves a *deployed
 * environment* stale rather than just blocking one PR.
 *
 * The second assertion is the other half: the report job. It must be a separate
 * job rather than an `if: failure()` step, because the failure being reported is
 * the runner going away — no later step in a dead job ever runs, so a step-level
 * notifier is silent in exactly the case it was written for. And its condition
 * must survive `cancelled`, which is what a reclaimed self-hosted runner and a
 * timeout-killed job both report.
 *
 * This guard lives here because **biffo-template never runs `deploy-app.yml`** —
 * it is non-deployable and publishes to npm. The workflow is authored here and
 * exercised only in instances, so a regression is invisible until it has already
 * cost an instance a stale environment. Same reasoning as
 * `workflow-relative-paths.test.ts` and `workflow-variable-contract.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-app.yml'), 'utf8')

/** GitHub's default when `timeout-minutes` is absent. */
const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360

type Job = { name: string; timeout: number | null; body: string }

/**
 * Jobs, by indentation. A job key sits at two spaces under `jobs:`; its
 * settings at four. Deliberately a text scan and not a YAML parse: the repo has
 * no YAML dependency, and every other workflow guard here reads the file the
 * same way.
 */
const parseJobs = (yaml: string): Job[] => {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => l === 'jobs:')
  expect(start, 'deploy-app.yml has a jobs: block').toBeGreaterThanOrEqual(0)

  const jobs: Job[] = []
  let current: { name: string; lines: string[] } | null = null
  const flush = () => {
    if (!current) return
    const body = current.lines.join('\n')
    const timeout = /^ {4}timeout-minutes: (\d+)$/m.exec(body)
    jobs.push({ name: current.name, timeout: timeout ? Number(timeout[1]) : null, body })
  }

  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line)
    if (header) {
      flush()
      current = { name: header[1], lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  flush()
  return jobs
}

describe('deploy-app.yml bounds every job', () => {
  const jobs = parseJobs(workflow)

  it('found the jobs, so an empty scan cannot pass as agreement', () => {
    expect(jobs.map((j) => j.name)).toEqual(
      expect.arrayContaining([
        'build-dev',
        'deploy-dev',
        'build-staging',
        'deploy-staging',
        'build-prod',
        'deploy-prod',
      ]),
    )
  })

  it.each(parseJobs(workflow).map((j) => [j.name, j] as const))(
    '%s declares a job-level timeout-minutes',
    (_name, job) => {
      expect(job.timeout).not.toBeNull()
    },
  )

  it.each(parseJobs(workflow).map((j) => [j.name, j] as const))(
    '%s is bounded well below the 360-minute default',
    (_name, job) => {
      expect(job.timeout).toBeGreaterThan(0)
      // A timeout that only just undercuts the default is not a bound, it is a
      // rounding error: observed runtimes are 2–4 minutes per job.
      expect(job.timeout).toBeLessThan(GITHUB_DEFAULT_TIMEOUT_MINUTES / 4)
    },
  )

  it('does not mistake the step-level timeouts for job-level ones', () => {
    // The six `timeout-minutes: 3` on the CloudFront invalidation steps are
    // indented six spaces and carry `continue-on-error: true` — they were the
    // reason #973 read as "this file already has timeouts" for so long.
    expect(workflow).toMatch(/^ {8}timeout-minutes: 3$/m)
    expect(parseJobs(workflow).every((j) => j.timeout !== 3)).toBe(true)
  })

  it('rejects a workflow whose jobs are unbounded (negative control)', () => {
    const unbounded = ['jobs:', '  build-dev:', '    runs-on: ubuntu-latest', '    steps: []'].join(
      '\n',
    )
    expect(parseJobs(unbounded)[0].timeout).toBeNull()
  })
})

describe('deploy-app.yml reports a failed deploy', () => {
  const jobs = parseJobs(workflow)
  const reporter = jobs.find((j) => /needs:\s*\n?\s*\[/.test(j.body) && j.body.includes('always()'))

  it('has a reporting job that waits on every build and deploy job', () => {
    expect(reporter, 'a job with needs: [...] and an always() condition').toBeDefined()
    for (const name of [
      'build-dev',
      'deploy-dev',
      'build-staging',
      'deploy-staging',
      'build-prod',
      'deploy-prod',
    ]) {
      expect(reporter?.body).toContain(name)
    }
  })

  it('fires on cancelled as well as failure, since a reclaimed runner reports cancelled', () => {
    expect(reporter?.body).toContain("contains(needs.*.result, 'failure')")
    expect(reporter?.body).toContain("contains(needs.*.result, 'cancelled')")
  })

  it('makes the failure visible in the run itself, not only in a side channel', () => {
    // `::error::` annotates the run and the commit; the step summary carries the
    // recovery command. Both land before the issue-filing step, which is
    // continue-on-error and may legitimately no-op.
    expect(reporter?.body).toContain('::error title=')
    expect(reporter?.body).toContain('GITHUB_STEP_SUMMARY')
  })

  it('grants itself the permission it needs without inheriting the deploy role', () => {
    const block = /^ {4}permissions:\n((?: {6}[\w-]+: \w+\n)+)/m.exec(reporter?.body ?? '')
    expect(block, 'the reporting job declares its own permissions block').not.toBeNull()
    expect(block?.[1]).toContain('issues: write')
    // Job-level permissions replace the workflow-level block outright; an
    // id-token here would hand an AWS-assuming credential to a job that has no
    // reason to hold one. Asserted against the block, not the whole job — the
    // surrounding comment says the word too.
    expect(block?.[1]).not.toContain('id-token')
  })
})
