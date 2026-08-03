import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type WorkflowJob, parseWorkflowJobs } from './workflow-toolchain.js'

/**
 * Any job that runs `terraform apply` must run the destructive-plan guard first.
 *
 * ## Why
 *
 * The guard (#387) is only as good as the set of applies it stands in front of,
 * and that set was never asserted. It was wired into `deploy-infra.yml` and
 * therefore protected **instances**; `deploy-global.yml` applied unguarded in
 * the template and both instances (#1130), and the sibling skeleton's
 * `deploy.yml` had no plan stage at all — so five sibling repos applied
 * `-auto-approve` with nothing in the way and every sibling scaffolded
 * afterwards was born the same (#1123).
 *
 * Each of those was fixed by hand, one workflow at a time, which is the shape
 * that guarantees a sixth. This asserts the property over every workflow the
 * template authors — its own and both skeletons' — so a new deploy job cannot
 * merge without a guard, and an existing one cannot quietly lose it.
 *
 * ## Why `terraform destroy` is not covered
 *
 * A destroy workflow destroys by definition; a guard there would fire on every
 * run and be acknowledged by reflex, which is how a guard stops meaning
 * anything (`destructive-plan.mjs` makes the same argument for keeping its
 * resource list short). `destroy-infra.yml` and `destroy-global.yml` run
 * `terraform destroy`, never `apply`, so the distinction is already structural
 * rather than a list this test has to maintain.
 *
 * ## What it cannot see
 *
 * The satellite repos themselves. This repo authors the skeleton, not the five
 * siblings already scaffolded from the old one — their `deploy.yml` is
 * repo-owned (runner label, `working-directory`), so it is reached by a PR per
 * repo rather than by a one-way overwrite. `shared-files.json` carries the
 * scripts; nothing but this test carries the wiring, and it only reaches repos
 * born after it. #1123 tracks the existing five.
 */

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

const APPLIES = /\bterraform\s+apply\b/
const GUARD = 'check-destructive-plan'

function workflowFiles(): string[] {
  const roots = [
    join(repoRoot, '.github/workflows'),
    ...readdirSync(join(repoRoot, '_skeletons'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, '_skeletons', entry.name, '.github/workflows')),
  ]

  return roots
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => join(dir, name)),
    )
}

interface UnguardedApply {
  file: string
  job: string
  line: number
  command: string
}

function unguardedApplies(file: string): UnguardedApply[] {
  const found: UnguardedApply[] = []
  const jobs = parseWorkflowJobs(readFileSync(file, 'utf8'))
  const byId = new Map(jobs.map((job) => [job.id, job]))

  const runsGuard = (job: WorkflowJob): boolean =>
    job.steps.some((step) => step.runLines.some((line) => line.includes(GUARD)))

  /**
   * True when the guard runs in any job this one transitively depends on.
   *
   * `deploy-infra.yml` splits the phases — `plan-dev` guards, `apply-dev`
   * `needs: plan-dev` — and that is a correct arrangement, so the rule has to
   * follow the dependency edges rather than stopping at the job boundary.
   *
   * On its own this proves only that a guard ran *somewhere upstream*, which is
   * necessary and not sufficient: the apply must also execute the very plan
   * that guard inspected. That second half is asserted separately below
   * ("applies the plan the guard inspected"), and it was a real defect rather
   * than a theoretical one — see #1148.
   */
  const guardedUpstream = (job: WorkflowJob, seen = new Set<string>()): boolean => {
    for (const id of job.needs) {
      if (seen.has(id)) continue
      seen.add(id)
      const parent = byId.get(id)
      if (parent === undefined) continue
      if (runsGuard(parent) || guardedUpstream(parent, seen)) return true
    }
    return false
  }

  for (const job of jobs) {
    if (job.reusable) continue

    let guarded = guardedUpstream(job)
    for (const step of job.steps) {
      for (const line of step.runLines) {
        if (line.includes(GUARD)) {
          guarded = true
          continue
        }
        if (APPLIES.test(line) && !guarded) {
          found.push({
            file: relative(repoRoot, file),
            job: job.id,
            line: step.line,
            command: line,
          })
        }
      }
    }
  }

  return found
}

describe('every terraform apply is preceded by the destructive-plan guard', () => {
  const files = workflowFiles()

  /**
   * A sweep reporting zero because it read nothing is this estate's most
   * repeated defect — and it is exactly how this guard would decay, since the
   * files it reads are ones nobody edits often. Pin that it found real applies.
   */
  it('is actually reading workflows that apply Terraform', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)

    const applying = files.filter((file) =>
      parseWorkflowJobs(readFileSync(file, 'utf8')).some((job) =>
        job.steps.some((step) => step.runLines.some((line) => APPLIES.test(line))),
      ),
    )

    // deploy-infra.yml, deploy-global.yml, and the sibling skeleton's deploy.yml.
    expect(
      applying.map((f) => relative(repoRoot, f)).sort(),
      'no workflow appears to run `terraform apply` — has the parser stopped reading?',
    ).toEqual([
      '.github/workflows/deploy-global.yml',
      '.github/workflows/deploy-infra.yml',
      '_skeletons/sibling-template/.github/workflows/deploy.yml',
    ])
  })

  it.each(files.map((file) => [relative(repoRoot, file), file]))(
    'guards every apply it runs: %s',
    (_label, file) => {
      const findings = unguardedApplies(file)

      const report = findings
        .map(
          (f) =>
            `  job "${f.job}" line ${f.line}: \`${f.command}\`\n` +
            '    no `check-destructive-plan.mjs` runs earlier in this job.\n' +
            '    fix: plan to a file, `terraform show -json` it, run the guard on the\n' +
            '         JSON, then apply the SAVED plan — see deploy-infra.yml.',
        )
        .join('\n')

      expect(findings, findings.length === 0 ? '' : `\n${report}\n`).toEqual([])
    },
  )
})

/**
 * Every `terraform apply` must execute a **saved plan file**, and where the
 * guard runs in a different job the plan must be transported to it.
 *
 * ## Why the guard above is not enough on its own
 *
 * `terraform apply` with no plan-file argument **recomputes a plan** and
 * applies that. In `deploy-infra.yml` the phases were split across jobs on
 * separate runners with `tfplan` never uploaded, so the file did not even exist
 * where the apply ran. `check-destructive-plan.mjs` inspected plan P1; plan P2
 * was applied. The guard could not gate what shipped — not as a race window,
 * but by construction, in all three environments at once (#1148).
 *
 * The previous assertion was fully green throughout, because "a guard ran
 * upstream" was true. That is the shape worth remembering: a gate can be
 * correctly wired and still stand in front of nothing.
 *
 * ## Why this enumerates rather than pinning the three known sites
 *
 * `deploy-global.yml` and the sibling skeleton's `deploy.yml` already applied
 * saved plans correctly, so a test written against the broken file alone would
 * have encoded the bug as the norm. Sweeping every workflow the template
 * authors means the next environment block — or the next skeleton — cannot
 * introduce the same gap.
 */
describe('every terraform apply executes the plan the guard inspected', () => {
  const files = workflowFiles()

  /** Tokens after `terraform apply`, minus flags. A saved plan is a bare argument. */
  function planFileArgument(command: string): string | null {
    const match = /\bterraform\s+apply\b(.*)$/.exec(command)
    if (match === null) return null
    const rest = (match[1] ?? '').split('#')[0] ?? ''
    const bare = rest
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith('-'))
    return bare[0] ?? null
  }

  it.each(files.map((file) => [relative(repoRoot, file), file]))(
    'passes a saved plan to every apply: %s',
    (_label, file) => {
      const jobs = parseWorkflowJobs(readFileSync(file, 'utf8'))
      const naked: string[] = []

      for (const job of jobs) {
        if (job.reusable) continue
        for (const step of job.steps) {
          for (const line of step.runLines) {
            if (!APPLIES.test(line)) continue
            if (planFileArgument(line) === null) {
              naked.push(
                `  job "${job.id}" line ${step.line}: \`${line.trim()}\`\n` +
                  '    no plan file argument, so this RECOMPUTES a plan and applies that —\n' +
                  '    whatever the destructive-plan guard inspected is discarded (#1148).\n' +
                  '    fix: `terraform apply -input=false -auto-approve tfplan`',
              )
            }
          }
        }
      }

      expect(naked, naked.length === 0 ? '' : `\n${naked.join('\n')}\n`).toEqual([])
    },
  )

  /**
   * A saved plan is only the plan the guard saw if it survived the trip between
   * jobs. When the guard is upstream rather than in the applying job, require
   * an explicit hand-off: the guarding job uploads an artifact, the applying
   * job downloads one. Without it the apply job's `tfplan` is either absent or,
   * worse, a stale file from its own checkout.
   */
  it.each(files.map((file) => [relative(repoRoot, file), file]))(
    'transports the plan when the guard runs in another job: %s',
    (_label, file) => {
      const jobs = parseWorkflowJobs(readFileSync(file, 'utf8'))
      const byId = new Map(jobs.map((job) => [job.id, job]))
      const runsGuard = (job: WorkflowJob): boolean =>
        job.steps.some((step) => step.runLines.some((line) => line.includes(GUARD)))
      const usesAction = (job: WorkflowJob, action: string): boolean =>
        job.steps.some((step) => step.uses?.includes(action) === true)

      const broken: string[] = []

      for (const job of jobs) {
        if (job.reusable) continue
        const applies = job.steps.some((step) => step.runLines.some((line) => APPLIES.test(line)))
        if (!applies || runsGuard(job)) continue

        const guardians = job.needs.map((id) => byId.get(id)).filter((j) => j !== undefined)
        if (!guardians.some((j) => runsGuard(j))) continue // the other test owns this case

        if (!usesAction(job, 'download-artifact')) {
          broken.push(
            `  job "${job.id}" applies a plan guarded in ${job.needs.join(', ')},\n` +
              '    but downloads no artifact — the plan cannot have reached this runner (#1148).',
          )
        }
        for (const guardian of guardians.filter((j) => runsGuard(j))) {
          if (!usesAction(guardian, 'upload-artifact')) {
            broken.push(
              `  job "${guardian.id}" guards a plan that "${job.id}" applies,\n` +
                '    but uploads no artifact — nothing carries the plan across (#1148).',
            )
          }
        }
      }

      expect(broken, broken.length === 0 ? '' : `\n${broken.join('\n')}\n`).toEqual([])
    },
  )
})
