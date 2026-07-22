import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareCoreVersions,
  findCoreVersionUpward,
  isInstanceRepo,
  parseCoreVersion,
  readCoreVersionFile,
  readInstanceCoreVersion,
} from './core-version.js'

describe('parseCoreVersion', () => {
  it('parses a semver into a numeric tuple', () => {
    expect(parseCoreVersion('1.2.3')).toEqual([1, 2, 3])
  })
  it('trims surrounding whitespace', () => {
    expect(parseCoreVersion(' 0.1.0\n')).toEqual([0, 1, 0])
  })
  it.each(['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', 'abc', ''])('rejects %j', (bad) => {
    expect(() => parseCoreVersion(bad)).toThrow()
  })
})

describe('compareCoreVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareCoreVersions('1.0.0', '2.0.0')).toBe(-1)
    expect(compareCoreVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareCoreVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareCoreVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareCoreVersions('0.10.0', '0.9.0')).toBe(1) // numeric, not lexical
  })
})

describe('findCoreVersionUpward / readCoreVersionFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-core-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a core.version in a parent directory', () => {
    writeFileSync(join(dir, 'core.version'), '3.4.5\n')
    const nested = join(dir, 'a', 'b')
    // findCoreVersionUpward walks up from the start dir
    const found = findCoreVersionUpward(nested)
    expect(found).toBe(join(dir, 'core.version'))
    expect(readCoreVersionFile(found as string)).toBe('3.4.5')
  })

  it('returns null when no core.version exists up the tree', () => {
    expect(findCoreVersionUpward(dir)).toBeNull()
  })
})

describe('readInstanceCoreVersion', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-instance-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when neither biffo.core.json nor core.version is present', () => {
    expect(readInstanceCoreVersion(dir)).toBeNull()
  })

  it('falls back to the inherited core.version when biffo.core.json is absent', () => {
    writeFileSync(join(dir, 'core.version'), '0.2.0\n')
    expect(readInstanceCoreVersion(dir)).toBe('0.2.0')
  })

  it('prefers biffo.core.json (the upgrade record) over the inherited core.version', () => {
    writeFileSync(join(dir, 'core.version'), '0.2.0\n')
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.3.0' }))
    expect(readInstanceCoreVersion(dir)).toBe('0.3.0')
  })

  it('reads the recorded version', () => {
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '1.4.0' }))
    expect(readInstanceCoreVersion(dir)).toBe('1.4.0')
  })

  it('throws on malformed JSON', () => {
    writeFileSync(join(dir, 'biffo.core.json'), '{ not json')
    expect(() => readInstanceCoreVersion(dir)).toThrow(/not valid JSON/)
  })

  it('throws when version is missing or not semver', () => {
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '1.2' }))
    expect(() => readInstanceCoreVersion(dir)).toThrow(/invalid/)
  })
})

describe('isInstanceRepo', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-probe-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is true when biffo.core.json is present', () => {
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '1.4.0' }))
    expect(isInstanceRepo(dir)).toBe(true)
  })

  it('is false for a bare directory', () => {
    expect(isInstanceRepo(dir)).toBe(false)
  })

  /**
   * The discrimination that matters, and the one that is easy to get wrong:
   * an instance inherits `core.version` through GitHub template generation, so
   * that file says nothing about which repo you are in. Only `biffo.core.json`
   * does. Keying the probe on `core.version` would classify the template AND
   * every instance as an instance, silently skipping the template-only guards in
   * the one repo that needs them (#367).
   */
  it('is false when only the inherited core.version is present', () => {
    writeFileSync(join(dir, 'core.version'), '0.46.2\n')
    expect(isInstanceRepo(dir)).toBe(false)
  })

  /**
   * Negative control: the probe must actually FLIP, or every
   * `skipIf(runningInInstance)` in this package is a no-op that silently runs
   * template-only guards in instances (or, worse, skips them in the template)
   * while looking correct.
   *
   * Deliberately not asserted against the repo this suite runs in: that
   * assertion has one right answer in the template and the opposite one in an
   * instance, so it would itself be a template-only check — the very defect
   * #367 is about.
   */
  it('negative control: flips as the marker appears', () => {
    expect(isInstanceRepo(dir)).toBe(false)
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '1.4.0' }))
    expect(isInstanceRepo(dir)).toBe(true)
  })
})
