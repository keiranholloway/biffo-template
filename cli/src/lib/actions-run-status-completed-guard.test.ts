import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflowsDir = join(repoRoot, '.github', 'workflows')

/**
 * GitHub's Actions API uses `status` for lifecycle ("has this run finished
 * executing at all") and `conclusion` for outcome ("did it finish
 * successfully"). `status=completed` matches `cancelled`, `timed_out`,
 * `skipped` and `failure` runs exactly as readily as `success` ones — it is
 * NOT a synonym for "succeeded".
 *
 * #1462 (class #1363, instance 11 of a fail-open/fail-red shape that keeps
 * recurring across this estate): `error-branch-coverage-gate.yml` filtered
 * `repos/$REPO/actions/runs?...&status=completed&...` and treated whatever it
 * found as a finished, trustworthy run — including a run CANCELLED by the
 * ordinary supersession of two merges landing close together, which reds
 * `dev` for a commit whose code was never actually broken. #1363 records this
 * has happened enough times (`tabsii-platform` carried the identical lines)
 * that the individual instance is not the thing worth guarding — the next
 * workflow that reaches for the Actions "list runs" API and filters on
 * `status` alone, without also constraining `conclusion`, is.
 *
 * This guard is deliberately grep-shaped and enumerable: every `.yml` under
 * `.github/workflows/` is scanned for a `repos/.../actions/runs` query whose
 * query string constrains `status=completed` without `conclusion` appearing
 * anywhere in the same shell step. It does not assert this one workflow's
 * fix; it asserts the SHAPE is absent estate-wide, which is what would have
 * caught both known instances before either shipped.
 */

/** One CI step's `run:` block, as GitHub Actions would execute it. */
function extractRunBlocks(workflowYaml: string): string[] {
  const blocks: string[] = []
  const lines = workflowYaml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line?.match(/^(\s*)(?:-\s*)?run:\s*\|/)
    if (!match) continue
    const indent = match[1]?.length ?? 0
    const block: string[] = []
    let j = i + 1
    while (j < lines.length) {
      const candidate = lines[j]
      if (candidate === undefined) break
      if (candidate.trim() !== '' && (candidate.match(/^(\s*)/)?.[1]?.length ?? 0) <= indent) break
      block.push(candidate)
      j++
    }
    blocks.push(block.join('\n'))
  }
  return blocks
}

/**
 * Flags a `repos/.../actions/runs` query that filters on `status=completed`
 * (or any `status=` value) without the same run block also constraining on
 * `conclusion`. A block that filters on `conclusion` — via the query string
 * OR a `--jq 'select(.conclusion == ...)'` — is fine even if `status` is
 * present too; `status=completed` is a legitimate pre-filter to narrow the
 * API response as long as `conclusion` is what the code actually branches on.
 */
function findStatusOnlyRunQueries(workflowYaml: string): string[] {
  const offenders: string[] = []
  for (const block of extractRunBlocks(workflowYaml)) {
    if (!/actions\/runs\?[^\n"']*status=/.test(block)) continue
    if (/conclusion/.test(block)) continue
    offenders.push(block)
  }
  return offenders
}

describe('the detector catches the real failure', () => {
  it('flags a runs query filtered only on status=completed', () => {
    const bad = `
      - run: |
          gh api "repos/$REPO/actions/runs?head_sha=$SHA&status=completed&per_page=50" \\
            --jq '[.workflow_runs[] | select(.name == "CI")] | first | .id // empty'
    `
    expect(findStatusOnlyRunQueries(bad)).toHaveLength(1)
  })

  it('is exactly the shape that shipped in error-branch-coverage-gate.yml before the fix', () => {
    // The literal line from #1462, reproduced from git history rather than
    // invented — a cancelled run for a superseded merge matched this filter
    // and was treated as a trustworthy, finished baseline.
    const shipped =
      'gh api "repos/$REPO/actions/runs?head_sha=$SHA&status=completed&per_page=50" --jq \'[.workflow_runs[] | select(.name == "RLS Tests")] | first | .id // empty\''
    expect(findStatusOnlyRunQueries(`- run: |\n    ${shipped}`)).toHaveLength(1)
  })
})

describe('the detector does not fire on the fixed shape or unrelated API calls', () => {
  it('allows a query that also filters on conclusion in the jq', () => {
    const good = `
      - run: |
          gh api "repos/$REPO/actions/runs?head_sha=$SHA&status=completed&per_page=50" \\
            --jq '[.workflow_runs[] | select(.name == "CI") | select(.conclusion == "success")] | first | .id // empty'
    `
    expect(findStatusOnlyRunQueries(good)).toEqual([])
  })

  it('ignores calls to other API endpoints entirely', () => {
    expect(
      findStatusOnlyRunQueries('- run: |\n    gh api "repos/$REPO/contents/foo?ref=$SHA"'),
    ).toEqual([])
  })

  it('ignores a runs query with no status filter at all', () => {
    expect(
      findStatusOnlyRunQueries(
        '- run: |\n    gh api "repos/$REPO/actions/runs?head_sha=$SHA&per_page=50"',
      ),
    ).toEqual([])
  })
})

describe('every real workflow in this repo', () => {
  const workflowFiles = readdirSync(workflowsDir).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  )

  it('found at least one workflow file to check', () => {
    expect(workflowFiles.length).toBeGreaterThan(0)
  })

  for (const file of workflowFiles) {
    it(`${file} does not filter an actions/runs query on status without conclusion`, () => {
      const content = readFileSync(join(workflowsDir, file), 'utf8')
      expect(findStatusOnlyRunQueries(content)).toEqual([])
    })
  }
})
