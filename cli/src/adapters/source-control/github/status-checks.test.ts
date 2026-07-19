/**
 * Drift guard (issue #189).
 *
 * `DEFAULT_STATUS_CHECKS` is the list of *required status check contexts* that
 * `configureBranchProtection` writes onto `dev`/`staging`/`main` of every repo
 * created by `biffo init` and `biffo sibling create`. GitHub matches those
 * contexts against the `name:` of the jobs that actually report — so if the
 * constant lists a context no job emits, every PR in the new repo is
 * permanently `BLOCKED` even with all real checks green, with no signal at
 * creation time.
 *
 * The constant and the workflows are two independently-editable sources of
 * truth. These tests couple them: edit one without the other and CI fails here
 * instead of wedging someone's freshly-scaffolded repo.
 *
 * Both scaffolded repo shapes are covered:
 *   - `biffo init`          → ships the core `.github/workflows/ci.yml`
 *   - `biffo sibling create` → ships `_skeletons/sibling-template/.github/workflows/ci.yml`
 * Neither caller passes a `statusChecks` argument, so both get the same
 * constant and both workflows must agree with it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUS_CHECKS } from './index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const CORE_CI = join(repoRoot, '.github/workflows/ci.yml')
const SKELETON_CI = join(repoRoot, '_skeletons/sibling-template/.github/workflows/ci.yml')

/**
 * Jobs that deliberately are NOT required status checks. Every entry must still
 * exist as a job (asserted below) so this list cannot rot into a silent excuse.
 *
 * - `Core Version Guard`: template-only (ADR-0006). It runs in instances but
 *   short-circuits to a pass as soon as it sees `biffo.core.json`, so making it
 *   a required context in a scaffolded repo would gate merges on a check that
 *   is meaningless there.
 */
const NOT_REQUIRED = new Set(['Core Version Guard'])

/**
 * Extract the `name:` of every top-level job in a GitHub Actions workflow.
 *
 * Deliberately narrow rather than a general YAML parser: it only accepts the
 * canonical 2-space-indented `jobs:` shape these two workflows use, and throws
 * if a job has no explicit `name:`. A job without `name:` reports under its job
 * *id* instead, which would silently not match any context here.
 */
function jobNames(workflowPath: string): string[] {
  const lines = readFileSync(workflowPath, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (start === -1) throw new Error(`No top-level 'jobs:' block in ${workflowPath}`)

  const names: string[] = []
  let currentId: string | null = null
  let currentName: string | null = null

  const flush = (): void => {
    if (currentId === null) return
    if (currentName === null) {
      throw new Error(`Job '${currentId}' in ${workflowPath} has no explicit 'name:'`)
    }
    names.push(currentName)
  }

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // dedented back to a top-level key — jobs block over
    const jobId = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (jobId) {
      flush()
      currentId = jobId[1] as string
      currentName = null
      continue
    }
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line)
    if (name && currentName === null && currentId !== null) {
      currentName = (name[1] as string).replace(/^['"]|['"]$/g, '')
    }
  }
  flush()

  if (names.length === 0) throw new Error(`Parsed no jobs from ${workflowPath}`)
  return names
}

describe('DEFAULT_STATUS_CHECKS vs. the workflows that must report them', () => {
  it('matches the required job names in the core ci.yml (biffo init)', () => {
    const required = jobNames(CORE_CI).filter((n) => !NOT_REQUIRED.has(n))
    expect([...required].sort()).toEqual([...DEFAULT_STATUS_CHECKS].sort())
  })

  it('matches the required job names in the sibling skeleton ci.yml (biffo sibling create)', () => {
    const required = jobNames(SKELETON_CI).filter((n) => !NOT_REQUIRED.has(n))
    expect([...required].sort()).toEqual([...DEFAULT_STATUS_CHECKS].sort())
  })

  it('only excludes jobs that actually exist', () => {
    const all = new Set([...jobNames(CORE_CI), ...jobNames(SKELETON_CI)])
    for (const excluded of NOT_REQUIRED) {
      expect(all, `'${excluded}' is excluded but no such job exists`).toContain(excluded)
    }
  })

  it('has no duplicate contexts', () => {
    expect(new Set(DEFAULT_STATUS_CHECKS).size).toBe(DEFAULT_STATUS_CHECKS.length)
  })

  it('requires no context whose job name is a template expression', () => {
    // A `name:` containing `${{ ... }}` (e.g. `Analyze (${{ matrix.language }})`
    // in the CodeQL workflow) resolves per-run, so it can never be written as a
    // static required context. Neither of these workflows may grow one.
    for (const path of [CORE_CI, SKELETON_CI]) {
      for (const name of jobNames(path)) {
        expect(name, `${path}: job name '${name}' is not a static string`).not.toContain('${{')
      }
    }
  })
})
