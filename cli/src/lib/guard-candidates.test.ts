import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GUARD_CANDIDATE_CLASSIFICATION,
  discoverGuardCandidates,
  discoverGuardFiles,
} from './guard-candidates.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Sweep for #1519: `discoverGuardFiles`'s old `/-(audit|guard)\.ts$/`-only
 * enumeration silently excluded any guard not named that way — which is how
 * `core-upgrade-target-fidelity.ts` sat outside `guard-authority-inventory.ts`
 * until it was added by hand, despite being #1362's own sharpest instance.
 *
 * This file is the mechanism the issue asked for: a broadened CANDIDATE
 * enumeration (`guard-candidates.ts`) union-ing the old naming convention
 * with an export-name signal, and a hard requirement that every candidate be
 * explicitly classified — a guard or explicitly not one, with a reason —
 * before it is allowed to disappear into (or out of) the set either of the
 * two downstream sweeps (#1413's wiring sweep, #1362's authority inventory)
 * enumerate over.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const libDir = join(repoRoot, 'cli', 'src', 'lib')

describe('guard candidate discovery and classification (#1519)', () => {
  it('discovers candidates via BOTH signals — prints the denominator, does not merely imply it', () => {
    const candidates = discoverGuardCandidates(libDir)
    const guards = discoverGuardFiles(libDir)
    const notGuards = candidates.filter((f) => GUARD_CANDIDATE_CLASSIFICATION[f]?.isGuard !== true)

    // This is #1519's own acceptance criterion made mechanical: a sweep built
    // on guard discovery must STATE how many candidates it considered and how
    // many it classified as guards, not just report a result over whichever
    // count the regex happened to admit.
    console.log(
      `guard-candidates: ${candidates.length} candidate(s) considered, ${guards.length} ` +
        `classified as guard, ${notGuards.length} classified as not-a-guard`,
    )

    expect(candidates.length).toBeGreaterThan(0)
    // Pin the file #1519 itself was filed over — regression coverage that the
    // export-name signal, not just the old naming convention, is live.
    expect(candidates).toContain('core-upgrade-target-fidelity.ts')
    expect(guards).toContain('core-upgrade-target-fidelity.ts')
  })

  it('every discovered candidate has a classification entry — an unclassified one FAILS the build', () => {
    const candidates = discoverGuardCandidates(libDir)
    const unclassified = candidates.filter((f) => !(f in GUARD_CANDIDATE_CLASSIFICATION))

    expect(
      unclassified,
      `${unclassified.length} candidate(s) discovered under cli/src/lib have no entry in ` +
        `GUARD_CANDIDATE_CLASSIFICATION (guard-candidates.ts): ${unclassified.join(', ')}. ` +
        'Classify each one — isGuard:true with a reason it feeds the #1413/#1362 sweeps, or ' +
        'isGuard:false with the reason it does not. This is exactly how #1519 happened: a ' +
        'guard-shaped file with no entry anywhere is invisible to every sweep built on this list.',
    ).toEqual([])
  })

  it('every classification entry names a real, non-empty reason', () => {
    for (const [file, verdict] of Object.entries(GUARD_CANDIDATE_CLASSIFICATION)) {
      expect(verdict.reason.length, `${file}'s classification has no reason`).toBeGreaterThan(0)
    }
  })

  it('has no stale classification entries for files that are no longer candidates', () => {
    const candidates = new Set(discoverGuardCandidates(libDir))
    const stale = Object.keys(GUARD_CANDIDATE_CLASSIFICATION).filter((f) => !candidates.has(f))

    expect(
      stale,
      `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} classified in ` +
        'GUARD_CANDIDATE_CLASSIFICATION but no longer discovered as a candidate (renamed, ' +
        'deleted, or no longer matches either discovery signal) — remove the stale entry so this ' +
        'list stays an honest record of what exists today.',
    ).toEqual([])
  })

  describe('fail-first proof: an unclassified guard-shaped file is RED before it is green', () => {
    it('flags a synthetic file whose export name alone makes it a candidate (no filename match)', () => {
      const dir = makeTmpDir('guard-candidates-unclassified')
      mkdirSync(dir, { recursive: true })
      // Deliberately named so the OLD /-(audit|guard)\.ts$/ regex would have
      // missed it entirely — this is the exact shape of #core-upgrade-target-
      // fidelity.ts before #1519: an assert* export, an unrelated filename.
      writeFileSync(
        join(dir, 'new-shape-check.ts'),
        'export function assertSomethingIsTrue(): void {}\n',
      )

      const candidates = discoverGuardCandidates(dir)
      expect(candidates).toEqual(['new-shape-check.ts'])

      // The file is a candidate. It has no classification entry anywhere —
      // this is what "unclassified" looks like, and is precisely the state
      // the sweep above (`every discovered candidate has a classification
      // entry`) fails the real build on. Asserted here directly, against the
      // REAL classification table, as the fail-first proof: reverting
      // GUARD_CANDIDATE_CLASSIFICATION to omit an entry for a real candidate
      // reproduces this exact failure, which is what made this red before
      // guard-candidates.ts existed.
      expect((candidates[0] as string) in GUARD_CANDIDATE_CLASSIFICATION).toBe(false)
    })

    it('does NOT flag a file that merely mentions a guard verb in a comment or string', () => {
      const dir = makeTmpDir('guard-candidates-false-positive')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'unrelated-thing.ts'),
        "// this function does NOT check or verify or assert anything\nexport function doStuff(): string { return 'checkThis' }\n",
      )

      // Neither signal fires: the filename doesn't match the naming
      // convention, and the only EXPORTED function is named doStuff — "check"
      // only appears inside a comment and a string literal, which the AST
      // walk never reads as an export name.
      expect(discoverGuardCandidates(dir)).toEqual([])
    })
  })

  it('the old naming-convention files are still discovered — broadening did not narrow anything', () => {
    const candidates = discoverGuardCandidates(libDir)
    for (const guard of [
      'core-direct-paths-audit.ts',
      'eventbridge-log-permission-guard.ts',
      'plugin-tool-supply-audit.ts',
      'core-ownership-guard.ts',
    ]) {
      expect(candidates).toContain(guard)
    }
  })
})
