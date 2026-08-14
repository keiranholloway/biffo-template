import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  checkSharedFileReduction,
  classifyTarget,
  extractTestTitles,
  formatReductionReport,
} from './shared-file-reduction-guard.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * #1577's guard, tested against the shape of the incident it exists for.
 *
 * The near-miss: `shared-files.json` maps `biffo-plugin-ideation`'s
 * `web/src/lib/auth.test.ts` onto the plugin skeleton's copy through
 * `filesIfPresent` — a one-way `cp`. #1546 added the mapping in the same
 * commit that created the canonical file, and the two were disjoint: 5
 * `getCurrentSession` tests upstream, 4 `getFreshIdToken` tests in ideation
 * including the regression guard for a stale-JWT bug. Syncing would have
 * deleted four assertions from the estate's weakest-covered repo, and nothing
 * in the pipeline would have said a word.
 *
 * `INCIDENT_CANONICAL` and `INCIDENT_SATELLITE` below are reduced to the
 * titles, which is the unit this guard compares — the full files are 219 and
 * 96 lines of Cognito mocking that would prove nothing extra here. The real
 * files are exercised end-to-end in the last block.
 */

const INCIDENT_CANONICAL = `
import { describe, expect, it } from 'vitest'

describe('getCurrentSession', () => {
  it('returns null when there is no signed-in user', async () => { expect(1).toBe(1) })
  it('returns the session for a signed-in user', async () => { expect(1).toBe(1) })
  it('builds the pool from the runtime identity document', async () => { expect(1).toBe(1) })
  it('memoises the in-flight pool resolution, not the settled value', async () => { expect(1).toBe(1) })
  it('re-resolves the pool after a failed resolution', async () => { expect(1).toBe(1) })
})
`

const INCIDENT_SATELLITE = `
import { describe, expect, it } from 'vitest'

describe('getFreshIdToken', () => {
  it('re-resolves through the pool on every call, so a refreshed token replaces a lapsed one', async () => { expect(1).toBe(1) })
  it('is null when there is no session, rather than throwing', async () => { expect(1).toBe(1) })
  it('is null when the pool cannot be resolved (identity document unreachable)', async () => { expect(1).toBe(1) })
  it('only ever asks the pool built from the runtime identity document', async () => { expect(1).toBe(1) })
})
`

describe('the #1577 incident', () => {
  it('refuses the sync that would have deleted ideation four tests', async () => {
    const report = await checkSharedFileReduction([
      {
        target: 'web/src/lib/auth.test.ts',
        existing: INCIDENT_SATELLITE,
        incoming: INCIDENT_CANONICAL,
      },
    ])

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.lost).toEqual([
      're-resolves through the pool on every call, so a refreshed token replaces a lapsed one',
      'is null when there is no session, rather than throwing',
      'is null when the pool cannot be resolved (identity document unreachable)',
      'only ever asks the pool built from the runtime identity document',
    ])
  })

  /**
   * The fix that was actually applied (#1575): fold the satellite's tests
   * into the canonical copy, THEN sync. The same guard must pass over it, or
   * it forbids the remedy it recommends.
   */
  it('passes once the canonical copy is folded into a superset', async () => {
    const folded = INCIDENT_CANONICAL + INCIDENT_SATELLITE
    const report = await checkSharedFileReduction([
      { target: 'web/src/lib/auth.test.ts', existing: INCIDENT_SATELLITE, incoming: folded },
    ])
    expect(report.findings).toEqual([])
    expect(report.analysed).toEqual(['web/src/lib/auth.test.ts'])
  })

  it('names the lost tests in the failure, so the author can fold rather than guess', async () => {
    const report = await checkSharedFileReduction([
      {
        target: 'web/src/lib/auth.test.ts',
        existing: INCIDENT_SATELLITE,
        incoming: INCIDENT_CANONICAL,
      },
    ])
    const text = formatReductionReport(report)
    expect(text).toContain('REFUSING TO OVERWRITE web/src/lib/auth.test.ts')
    expect(text).toContain('is null when there is no session, rather than throwing')
    expect(text).toContain('getFreshIdToken')
  })
})

describe('what counts as a reduction', () => {
  const withTests = (...titles: string[]) =>
    `describe('s', () => {\n${titles.map((t) => `  it(${JSON.stringify(t)}, () => {})`).join('\n')}\n})\n`

  it('adding tests upstream is never a reduction — adding is always safe', async () => {
    const report = await checkSharedFileReduction([
      { target: 'a.test.ts', existing: withTests('a'), incoming: withTests('a', 'b', 'c') },
    ])
    expect(report.findings).toEqual([])
  })

  it('reordering is not a reduction — the unit compared is a set', async () => {
    const report = await checkSharedFileReduction([
      { target: 'a.test.ts', existing: withTests('a', 'b'), incoming: withTests('b', 'a') },
    ])
    expect(report.findings).toEqual([])
  })

  /**
   * Renaming a `describe` while keeping every test under it deletes nothing,
   * which is why suite titles are collected for the report and never
   * compared. Comparing fully-qualified names would turn a harmless rename
   * into a finding, and a guard that fires on harmless changes is one people
   * learn to bypass.
   */
  it('renaming a describe is not a reduction', async () => {
    const before = `describe('old name', () => { it('a', () => {}) })`
    const after = `describe('new name', () => { it('a', () => {}) })`
    const report = await checkSharedFileReduction([
      { target: 'a.test.ts', existing: before, incoming: after },
    ])
    expect(report.findings).toEqual([])
  })

  it('renaming a test IS a reduction, because a reader of the satellite cannot tell the two apart', async () => {
    const report = await checkSharedFileReduction([
      { target: 'a.test.ts', existing: withTests('a'), incoming: withTests('a renamed') },
    ])
    expect(report.findings[0]?.lost).toEqual(['a'])
  })

  it('finds it.only / test.skip / it.each, not just bare it()', async () => {
    const before = [
      "describe('s', () => {",
      "  it.only('only', () => {})",
      "  test.skip('skipped', () => {})",
      "  it.each([1, 2])('each %i', () => {})",
      '})',
    ].join('\n')
    const report = await checkSharedFileReduction([
      { target: 'a.test.ts', existing: before, incoming: withTests('unrelated') },
    ])
    expect(report.findings[0]?.lost).toEqual(['only', 'skipped', 'each %i'])
  })

  /**
   * AST, never a regex over source text (#956). A commented-out test and a
   * string that merely contains `it(` must not manufacture a title — if they
   * did, deleting a comment would read as deleting a test and the guard
   * would fire on nothing.
   */
  it('does not count a commented-out test or a string that looks like one', async () => {
    const before = [
      "describe('s', () => {",
      "  // it('a ghost', () => {})",
      "  it('real', () => { expect(\"it('another ghost', () => {})\").toBeTruthy() })",
      '})',
    ].join('\n')
    expect((await extractTestTitles(before)).tests).toEqual(['real'])
  })
})

describe('scope — stated, not implied', () => {
  it('analyses TS/JS test files', () => {
    for (const path of ['a.test.ts', 'a.test.tsx', 'web/src/lib/auth.spec.js']) {
      expect(classifyTarget(path).analysable).toBe(true)
    }
  })

  /**
   * The honest half. Every one of these is a path a `filesIfPresent`
   * overwrite can delete satellite-only content from, and this guard passes
   * all of them. It must SAY so rather than counting them as clean: a check
   * that silently drops the inputs it cannot evaluate reports the remainder
   * as the whole, which is `protection-audit.sh`'s #1145 defect.
   */
  it('reports every other mapping as not analysable, with a reason', async () => {
    const report = await checkSharedFileReduction([
      { target: 'AGENTS.md', existing: 'a\nb\n', incoming: 'a\n' },
      { target: 'scripts/routing-smoke-test.test.sh', existing: 'a\nb\n', incoming: 'a\n' },
      { target: 'web/src/lib/auth.ts', existing: 'export const a = 1\n', incoming: '' },
    ])
    expect(report.findings).toEqual([])
    expect(report.analysed).toEqual([])
    expect(report.skipped.map((s) => s.target)).toEqual([
      'AGENTS.md',
      'scripts/routing-smoke-test.test.sh',
      'web/src/lib/auth.ts',
    ])
    for (const skipped of report.skipped) expect(skipped.reason).toMatch(/test file/)
  })

  it('prints the unanalysable count in the report, so the denominator is never hidden', async () => {
    const report = await checkSharedFileReduction([
      { target: 'AGENTS.md', existing: 'a\n', incoming: 'b\n' },
    ])
    expect(formatReductionReport(report)).toContain('1 not analysable')
    expect(formatReductionReport(report)).toContain('skipped AGENTS.md')
  })

  /**
   * Named in the guard's own docstring as a limit: same titles, fewer
   * assertions inside them, and the guard passes. Pinned as a test so the
   * limit is demonstrated rather than merely claimed.
   */
  it('does NOT catch assertions deleted inside a test that survives by name', async () => {
    const before = `it('a', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3) })`
    const after = `it('a', () => { expect(1).toBe(1) })`
    const report = await checkSharedFileReduction([
      { target: 'a.test.ts', existing: before, incoming: after },
    ])
    expect(report.findings).toEqual([])
  })
})

describe('the accepted-reductions escape hatch', () => {
  const pairs = [
    { target: 'web/src/lib/auth.test.ts', existing: `it('gone', () => {})`, incoming: '' },
  ]

  it('fails when the loss is not declared', async () => {
    expect((await checkSharedFileReduction(pairs)).findings).toHaveLength(1)
  })

  it('passes when every lost title is declared intended, with a reason', async () => {
    const report = await checkSharedFileReduction(pairs, {
      'web/src/lib/auth.test.ts': { gone: 'superseded by the pool-race test upstream' },
    })
    expect(report.findings).toEqual([])
    expect(report.acceptedOnly).toHaveLength(1)
  })

  it('still fails when only SOME of the losses are declared', async () => {
    const twoLost = [
      {
        target: 'web/src/lib/auth.test.ts',
        existing: `it('gone', () => {}); it('also gone', () => {})`,
        incoming: '',
      },
    ]
    const report = await checkSharedFileReduction(twoLost, {
      'web/src/lib/auth.test.ts': { gone: 'superseded' },
    })
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.lost).toEqual(['gone', 'also gone'])
  })

  it('keeps an accepted loss visible in the report rather than silently clean', async () => {
    const report = await checkSharedFileReduction(pairs, {
      'web/src/lib/auth.test.ts': { gone: 'superseded' },
    })
    expect(formatReductionReport(report)).toContain('accepted loss in web/src/lib/auth.test.ts')
  })

  it('a declaration on a different target does not apply', async () => {
    const report = await checkSharedFileReduction(pairs, {
      'other.test.ts': { gone: 'superseded' },
    })
    expect(report.findings).toHaveLength(1)
  })
})

/**
 * The incident, pinned against the real tree.
 *
 * #1575 folded ideation's four `getFreshIdToken` tests into the canonical
 * copy so the satellite would receive a superset. Nothing until now stopped a
 * later edit here from dropping them again — which is the same deletion, just
 * arriving through the template instead of through the mapping. These titles
 * are ideation's, copied deliberately: they are the assertions the estate
 * nearly lost.
 */
describe('the canonical plugin-skeleton auth.test.ts stays a superset (#1575)', () => {
  const canonical = readFileSync(
    join(repoRoot, '_skeletons/plugin-template/web-admin/src/lib/auth.test.ts'),
    'utf8',
  )
  let titles: string[]
  beforeAll(async () => {
    titles = (await extractTestTitles(canonical)).tests
  })

  it.each([
    're-resolves through the pool on every call, so a refreshed token replaces a lapsed one',
    'is null when there is no session, rather than throwing',
    'is null when the pool cannot be resolved (identity document unreachable)',
    'only ever asks the pool built from the runtime identity document',
  ])('still declares ideation’s test: %s', (title) => {
    expect(titles).toContain(title)
  })
})
