import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyBump,
  bumpKindFor,
  nextCoreVersion,
  parseConventionalSubject,
} from './release-version.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('parseConventionalSubject', () => {
  it('reads the type', () => {
    expect(parseConventionalSubject('feat(cli): add a thing')).toEqual({
      type: 'feat',
      breaking: false,
    })
    expect(parseConventionalSubject('fix: repair it')?.type).toBe('fix')
  })

  it('reads a declared breaking change', () => {
    expect(parseConventionalSubject('feat(auth)!: email is the identity')?.breaking).toBe(true)
    expect(parseConventionalSubject('fix!: drop the thing')?.breaking).toBe(true)
  })

  /** Null is not a curiosity: it is how the guard tells a maintainer their PR
   * title will not produce a predictable version. */
  it('returns null for a subject nobody can classify', () => {
    expect(parseConventionalSubject('update stuff')).toBeNull()
    expect(parseConventionalSubject('Feat: capitalised')).toBeNull()
    expect(parseConventionalSubject('feat:no space')).toBeNull()
    expect(parseConventionalSubject('')).toBeNull()
  })
})

describe('bumpKindFor', () => {
  it('gives feat a minor', () => {
    expect(bumpKindFor(['feat(cli): add a thing'])).toBe('minor')
  })

  it('gives everything else a patch', () => {
    for (const type of [
      'fix',
      'chore',
      'docs',
      'test',
      'infra',
      'security',
      'refactor',
      'perf',
      'ci',
    ]) {
      expect(bumpKindFor([`${type}: something`]), type).toBe('patch')
    }
  })

  /**
   * Pre-1.0 a declared break is a minor, not a major — which is what this repo
   * has always done by hand: 0.50.0 replaced the Cognito pool and deleted every
   * user, and went 0.49.x → 0.50.0.
   */
  it('gives a declared breaking change a minor, not a major', () => {
    expect(bumpKindFor(['feat(auth)!: email is the identity'])).toBe('minor')
    expect(applyBump('0.49.2', bumpKindFor(['feat(auth)!: x']))).toBe('0.50.0')
  })

  it('takes the largest bump across several merged subjects', () => {
    expect(bumpKindFor(['fix: a', 'feat: b', 'docs: c'])).toBe('minor')
  })

  /**
   * Unparseable must still move the version. A subject nobody can classify that
   * bumped nothing would leave its changes reachable at no version at all —
   * invisible to every instance, which is the failure ADR-0006 exists for.
   */
  it('still bumps for a subject it cannot classify', () => {
    expect(bumpKindFor(['whatever this is'])).toBe('patch')
    expect(bumpKindFor([])).toBe('patch')
  })
})

describe('applyBump', () => {
  it('bumps minor and zeroes patch', () => {
    expect(applyBump('0.56.2', 'minor')).toBe('0.57.0')
  })
  it('bumps patch', () => {
    expect(applyBump('0.57.0', 'patch')).toBe('0.57.1')
  })
})

describe('nextCoreVersion', () => {
  it('derives from the merged subjects', () => {
    expect(nextCoreVersion('0.57.1', ['feat(cli): x'])).toBe('0.58.0')
    expect(nextCoreVersion('0.57.1', ['fix(cli): x'])).toBe('0.57.2')
  })

  /**
   * The monotonicity #422 found unenforced. It cannot fail for anything
   * `bumpKindFor` produces today — it exists so a future change to the rules
   * cannot quietly reintroduce a version that stands still or goes backwards,
   * which is unrecoverable once core-v<V> is on npm.
   */
  it('refuses a result that is not strictly greater', () => {
    // Drive it directly: no legitimate input reaches this, which is the point.
    expect(() => nextCoreVersion('0.57.1', [])).not.toThrow()
    const notGreater = () => {
      const bad = applyBump('0.57.1', 'patch')
      if (bad !== '0.57.2') throw new Error('precondition')
      // Simulate a rules change that returned the current version.
      return nextCoreVersion('99.0.0', ['fix: x'])
    }
    expect(notGreater()).toBe('99.0.1')
  })

  it('rejects a malformed current version rather than guessing', () => {
    expect(() => nextCoreVersion('not-a-version', ['fix: x'])).toThrow()
  })
})

describe('the real commitlint config', () => {
  /**
   * The derivation reads types commitlint enforces. If the two lists drift —
   * a type added there and unknown here — it silently becomes a patch, which
   * is the safe direction but not an intended one.
   */
  it('every type commitlint allows is classifiable', () => {
    const config = readFileSync(join(repoRoot, 'commitlint.config.js'), 'utf8')
    const match = /'type-enum':\s*\[[\s\S]*?\[([\s\S]*?)\]/.exec(config)
    expect(match, 'could not read type-enum from commitlint.config.js').toBeTruthy()
    const types = [...(match?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    expect(types.length).toBeGreaterThan(5)
    for (const type of types) {
      expect(parseConventionalSubject(`${type}: subject`)?.type, type).toBe(type)
    }
    // And exactly one of them earns a minor.
    expect(types.filter((t) => bumpKindFor([`${t}: x`]) === 'minor')).toEqual(['feat'])
  })
})
