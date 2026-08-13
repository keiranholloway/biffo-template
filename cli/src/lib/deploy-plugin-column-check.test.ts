/**
 * The deploy-time plugin column check must be wired into ALL THREE deploy
 * jobs, in the right place (biffo-template#1556).
 *
 * `deploy-app.yml` duplicates its database steps three times — `deploy-dev`,
 * `deploy-staging` and `deploy-prod` — so "wired in" is three separate edits
 * that nothing keeps in step. A guard wired into dev only would pass every
 * environment it was not watching, which is its own instance of the class the
 * check exists to catch. #1560 records being told there were two jobs, not
 * three, and having to correct it mid-task; this test is so nobody has to
 * count again.
 *
 * Position matters as much as presence, so it is asserted too:
 *
 * - after `Apply DDL imports` — every writer of schema has had its turn, so a
 *   complaint is about the finished state rather than a race;
 * - before `Check plugin baseline seed rows` — structure before content; a
 *   table missing `tenant_id` would otherwise surface there as an unreadable
 *   table rather than a named missing column;
 * - before the plugin Lambda / shared host / frontend steps — so a failure
 *   stops the plugin's user-visible surface being switched to a build the
 *   database cannot serve.
 *
 * This guard lives in the CLI package for the reason
 * `deploy-job-timeouts.test.ts` gives: **biffo-template never runs
 * `deploy-app.yml`**. The workflow is authored here and executed only in
 * instances, so a regression is otherwise invisible until it has already cost
 * an instance a bad deploy.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-app.yml'), 'utf8')

const DEPLOY_JOBS = ['deploy-dev', 'deploy-staging', 'deploy-prod'] as const

/**
 * The body of one job, by indentation: a job key sits at two spaces under
 * `jobs:` and its contents deeper. A text scan rather than a YAML parse, to
 * match every other workflow guard in this directory.
 */
const jobBody = (yaml: string, job: string): string => {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => l === `  ${job}:`)
  expect(start, `deploy-app.yml declares a ${job} job`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}[A-Za-z_][\w-]*:\s*$/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** Index of a step name inside a job body, or -1. */
const stepIndex = (body: string, name: string): number => body.indexOf(`      - name: ${name}`)

describe('deploy-app.yml wires the plugin column check into every environment', () => {
  it('found all three deploy jobs, so an empty scan cannot pass as agreement', () => {
    for (const job of DEPLOY_JOBS) {
      expect(jobBody(workflow, job).length, `${job} body is non-empty`).toBeGreaterThan(0)
    }
    // The count is asserted directly too: a fourth deploy job added later must
    // fail this test rather than quietly go unchecked.
    const deployJobs = [...workflow.matchAll(/^ {2}(deploy-[\w-]+):\s*$/gm)].map((m) => m[1])
    expect(deployJobs.sort()).toEqual([...DEPLOY_JOBS].sort())
  })

  it.each(DEPLOY_JOBS)('%s invokes biffo:plugin-column-check', (job) => {
    expect(jobBody(workflow, job)).toContain('"source":"biffo:plugin-column-check"')
  })

  it.each(DEPLOY_JOBS)('%s fails the job when the check reports a FunctionError', (job) => {
    const body = jobBody(workflow, job)
    const step = body.slice(stepIndex(body, 'Check plugin manifest columns exist'))
    // An invoke that does not inspect FunctionError "succeeds" on a Lambda
    // that raised — the deploy would go green on the exact failure this
    // check exists to produce.
    expect(step).toContain('grep -q FunctionError')
    expect(step).toContain('exit 1')
  })

  it.each(DEPLOY_JOBS)('%s names its environment in the failure annotation', (job) => {
    const env = job.replace('deploy-', '')
    const body = jobBody(workflow, job)
    const step = body.slice(stepIndex(body, 'Check plugin manifest columns exist'))
    // "check failed" in one of three environments costs more than it saves.
    expect(step).toContain(`::error::[${env}]`)
    expect(step).toContain(`the ${env} database`)
  })

  it.each(DEPLOY_JOBS)('%s runs the check after migrations and DDL imports', (job) => {
    const body = jobBody(workflow, job)
    const check = stepIndex(body, 'Check plugin manifest columns exist')
    expect(stepIndex(body, 'Initialise database schema')).toBeLessThan(check)
    expect(stepIndex(body, 'Apply DDL imports')).toBeLessThan(check)
  })

  it.each(DEPLOY_JOBS)('%s runs the column check before the baseline row check', (job) => {
    const body = jobBody(workflow, job)
    const check = stepIndex(body, 'Check plugin manifest columns exist')
    const baseline = stepIndex(body, 'Check plugin baseline seed rows')
    expect(baseline).toBeGreaterThan(-1)
    expect(check).toBeLessThan(baseline)
  })

  it.each(DEPLOY_JOBS)('%s runs the check before any plugin surface is shipped', (job) => {
    const body = jobBody(workflow, job)
    const check = stepIndex(body, 'Check plugin manifest columns exist')
    for (const later of [
      'Package and deploy plugin Lambdas',
      'Package and deploy the shared plugin host',
      'Build and deploy plugin frontends',
      'Invalidate CloudFront for plugin frontends',
    ]) {
      expect(stepIndex(body, later), `${later} exists in ${job}`).toBeGreaterThan(-1)
      expect(stepIndex(body, later)).toBeGreaterThan(check)
    }
  })
})
