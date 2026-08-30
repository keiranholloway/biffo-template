import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { readDivergenceConfig } from './core-ownership-guard.js'
import {
  checkOrphanRatchet,
  type MergeFileFn,
  pathHasDivergenceTrailerInHistory,
  planCoreUpgrade,
} from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Fix for #1718: `checkCoreOwnership` (core-ownership-guard.ts) has always
 * accepted a template-owned path via TWO independent routes — a
 * `biffo.divergence.json` `warnOnly` entry, OR a bare `Core-Divergence: <reason>`
 * commit trailer — and its own printed guidance names the trailer as a way
 * past. #1602/#1717 unified only the FIRST route into the #1026 orphan ratchet
 * (`planCoreUpgrade`'s `isDeclaredDivergent`); the trailer route was never
 * consulted there, so an operator who followed the guard's own suggestion still
 * hit the #1602 outcome: green at commit time, refused later at
 * `biffo core upgrade`, in front of whoever else was mid upgrade.
 *
 * This file is deliberately separate from
 * `core-upgrade-orphan-ratchet-divergence.test.ts` (the #1602 fix for the
 * config-file route) for the same reason that file is separate from
 * `core-ownership-orphan-disagreement.test.ts`: each pins one, distinct,
 * previously-open gap, and conflating them would blur which fix closed which
 * gap.
 */

const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['.github/workflows/'],
  userOwned: [],
}

const neverMerges: MergeFileFn = async () => {
  throw new Error('classify() reached the merge step for a path with no base and no theirs')
}

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function initRepo(repo: string): void {
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
}

/** Commit whatever is currently staged/on disk with a message that may carry a
 * `Core-Divergence:` trailer. Written via `-F <file>` rather than `-m`, the
 * same reason AGENTS.md gives for every commit this estate's own agents make:
 * a trailer body containing something shell-special must never be interpolated
 * through `-m`. */
function commit(repo: string, message: string): void {
  const msgFile = join(repo, '.git', 'COMMIT_MSG_FIXTURE')
  writeFileSync(msgFile, message)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-F', msgFile])
}

describe('pathHasDivergenceTrailerInHistory — the pure lookup, with a fake git', () => {
  it('finds a Core-Divergence trailer on a commit that touched the path', () => {
    const log = (args: string[]): string => {
      expect(args).toContain('log')
      return '\x00fix: add a divergent workflow\n\nCore-Divergence: real-Postgres RLS lane\n'
    }
    expect(pathHasDivergenceTrailerInHistory('/repo', '.github/workflows/rls.yml', log)).toBe(true)
  })

  it('returns false when no commit touching the path carries the trailer', () => {
    const log = (): string => '\x00fix: add a workflow\n\nno trailer here\n'
    expect(pathHasDivergenceTrailerInHistory('/repo', '.github/workflows/rls.yml', log)).toBe(false)
  })

  it('fails CLOSED — not open — when git cannot answer', () => {
    // The opposite default from gitTrackedFiles: an un-inspectable tree must
    // NOT read as "declared", or every plain (non-git) fixture directory this
    // module's own other tests build would silently defang the orphan ratchet.
    const failing = (): string => {
      throw new Error('git: command not found')
    }
    expect(pathHasDivergenceTrailerInHistory('/repo', 'any/path', failing)).toBe(false)
  })

  it('does not accept a passing mention of the words inside prose', () => {
    // Same anchoring rule as parseDivergenceTrailer itself (core-ownership-guard.ts)
    // — reused, not re-derived, so this is really testing the reuse rather than
    // a second copy of the regex.
    const log = (): string => '\x00fix: discuss Core-Divergence: later maybe\n'
    expect(pathHasDivergenceTrailerInHistory('/repo', 'any/path', log)).toBe(false)
  })
})

describe('checkOrphanRatchet vs the Core-Divergence TRAILER route (#1718)', () => {
  let base: string
  let ours: string
  let theirs: string

  beforeEach(() => {
    base = makeTmpDir('base')
    ours = makeTmpDir('ours')
    theirs = makeTmpDir('theirs')
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  // Same real shape core-upgrade-orphan-ratchet-divergence.test.ts uses for the
  // config-file route: a real-Postgres CI lane a template-owned gate matches by
  // exact path and name (biffo-platform's actual rls-tests.yml addition, #1602).
  const DIVERGED = '.github/workflows/rls-tests.yml'

  it(
    '(a) a path declared ONLY via a Core-Divergence trailer — no biffo.divergence.json entry — ' +
      'is no longer reported as an orphan',
    async () => {
      initRepo(ours)
      w(ours, DIVERGED, 'name: RLS Tests\n')
      commit(
        ours,
        'infra(ci): add the real-Postgres RLS lane\n\n' +
          'Core-Divergence: template gate matches this exact path and name (#1602)\n',
      )

      // The premise this test depends on: no biffo.divergence.json anywhere,
      // so the config-file route (#1602/#1717) contributes nothing here — if
      // this test passed only because of that route, it would not be testing
      // the trailer at all.
      expect(readDivergenceConfig(ours).warnOnly).toEqual([])

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest: MANIFEST,
        mergeFile: neverMerges,
      })

      // The denominator (#1363): how many paths classify() actually examined.
      console.log(
        `core-upgrade-orphan-ratchet-trailer (a): ${plan.entries.length} path(s) examined, ` +
          `1 trailer-declared path under test (${DIVERGED})`,
      )
      expect(plan.entries.length).toBeGreaterThan(0)

      const entry = plan.entries.find((e) => e.path === DIVERGED)
      expect(entry, 'the upgrade should have an opinion about this path').toBeDefined()
      expect(entry?.status).toBe('keep-ours')

      // The line #1718 is about: fails against the unfixed code (orphaned ===
      // true, because isDeclaredDivergent never consulted git history), passes
      // once classify() also asks pathHasDivergenceTrailerInHistory.
      expect(entry?.orphaned).not.toBe(true)
      expect(plan.orphaned.map((e) => e.path)).not.toContain(DIVERGED)

      const ratchet = checkOrphanRatchet(plan.orphaned.length, { count: 0 })
      expect(ratchet.increased).toBe(false)
    },
  )

  it('(b) an UNDECLARED orphan in a real git history is still correctly flagged — the ratchet is not defanged', async () => {
    const UNDECLARED = '.github/workflows/some-other-lane.yml'
    initRepo(ours)
    w(ours, UNDECLARED, 'name: Some Other Lane\n')
    // An ordinary commit, deliberately with NO Core-Divergence trailer and no
    // biffo.divergence.json — the negative case this fix must not defeat.
    commit(ours, 'infra(ci): add some other lane\n')
    expect(readDivergenceConfig(ours).warnOnly).toEqual([])

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    const entry = plan.entries.find((e) => e.path === UNDECLARED)
    expect(entry?.orphaned).toBe(true)
    expect(plan.orphaned.map((e) => e.path)).toContain(UNDECLARED)

    const ratchet = checkOrphanRatchet(plan.orphaned.length, { count: 0 })
    expect(ratchet.increased).toBe(true)
  })

  it(
    'a commit that merely MENTIONS the phrase, without the trailer being its own line, ' +
      'does not launder an undeclared path',
    async () => {
      const LOOKS_LIKE_ONE = '.github/workflows/looks-divergent.yml'
      initRepo(ours)
      w(ours, LOOKS_LIKE_ONE, 'name: Looks Divergent\n')
      commit(ours, 'docs: explain when a Core-Divergence: trailer would be needed here\n')

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest: MANIFEST,
        mergeFile: neverMerges,
      })

      const entry = plan.entries.find((e) => e.path === LOOKS_LIKE_ONE)
      expect(entry?.orphaned).toBe(true)
    },
  )

  it('also reaches the sibling "instance deleted a template file" branch via the same closure', async () => {
    // isDeclaredDivergent is the one closure both classify() branches read
    // (see core-upgrade.ts) — proving the trailer route on THIS branch too is
    // what makes "same closure" true rather than aspirational.
    const DELETED_BUT_DECLARED = '.github/workflows/deprecated-lane.yml'
    w(base, DELETED_BUT_DECLARED, 'name: Deprecated Lane\n')
    w(theirs, DELETED_BUT_DECLARED, 'name: Deprecated Lane\n')

    initRepo(ours)
    w(ours, DELETED_BUT_DECLARED, 'name: Deprecated Lane\n')
    commit(ours, 'infra(ci): add deprecated lane placeholder\n')
    rmSync(join(ours, DELETED_BUT_DECLARED))
    commit(
      ours,
      'infra(ci): remove the deprecated lane\n\n' +
        'Core-Divergence: this instance never runs the deprecated lane (#1718 fixture)\n',
    )

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    const entry = plan.entries.find((e) => e.path === DELETED_BUT_DECLARED)
    // Declared-divergent deletion stays 'removed' rather than being 'restored'
    // (#395) — the same outcome the config-file route already produces, now
    // reachable via the trailer too.
    expect(entry?.status).toBe('removed')
    expect(plan.divergenceSkips).toContain(DELETED_BUT_DECLARED)
  })
})
