import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareCoreVersions,
  findCoreVersionUpward,
  isInstanceRepo,
  parseCoreVersion,
  planCoreVersionCleanup,
  readCoreVersionFile,
  readDeclinedMigrations,
  readInstanceCoreVersion,
  writeInstanceCoreVersion,
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

describe('declinedMigrations (#735)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-declined-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (body: unknown): void => {
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify(body, null, 2))
  }

  it('is empty when the file is absent or records none', () => {
    expect(readDeclinedMigrations(dir)).toEqual([])
    write({ version: '1.4.0' })
    expect(readDeclinedMigrations(dir)).toEqual([])
  })

  it('reads declared declines', () => {
    write({
      version: '1.4.0',
      declinedMigrations: [
        { file: '0010_orgs.py', reason: 'no public.users here', upstream: 'a/b#670' },
      ],
    })
    expect(readDeclinedMigrations(dir)).toEqual([
      { file: '0010_orgs.py', reason: 'no public.users here', upstream: 'a/b#670' },
    ])
  })

  it('rejects a decline with no reason', () => {
    // Same principle biffo.divergence.json applies: an entry nobody can review
    // later is drift wearing a temporary label.
    write({ version: '1.4.0', declinedMigrations: [{ file: '0010_orgs.py' }] })
    expect(() => readDeclinedMigrations(dir)).toThrow(/reason is required/)
  })

  it('rejects an empty reason, not just a missing one', () => {
    write({ version: '1.4.0', declinedMigrations: [{ file: '0010_orgs.py', reason: '' }] })
    expect(() => readDeclinedMigrations(dir)).toThrow(/reason is required/)
  })

  // The trap this feature would otherwise have walked into: declines are read
  // *during* an upgrade and biffo.core.json is rewritten *by* that same
  // upgrade. Serialising `{ version }` alone would erase the declines it had
  // just honoured, so they would survive exactly zero upgrades — and the file
  // would look like the feature worked.
  it('survives the version bump an upgrade performs in the same run', () => {
    write({
      version: '1.4.0',
      declinedMigrations: [{ file: '0010_orgs.py', reason: 'no public.users here' }],
    })

    writeInstanceCoreVersion(dir, '1.5.0')

    expect(readInstanceCoreVersion(dir)).toBe('1.5.0')
    expect(readDeclinedMigrations(dir)).toEqual([
      { file: '0010_orgs.py', reason: 'no public.users here' },
    ])
  })

  it('preserves fields this CLI does not know about', () => {
    // A future field must not need anyone to remember this function exists.
    write({ version: '1.4.0', somethingAddedLater: { keep: true } })
    writeInstanceCoreVersion(dir, '1.5.0')
    const raw = JSON.parse(readFileSync(join(dir, 'biffo.core.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(raw).toEqual({ version: '1.5.0', somethingAddedLater: { keep: true } })
    // version stays first, so the file reads the way it always has
    expect(Object.keys(raw)[0]).toBe('version')
  })

  it('writes a plain record when there is no existing file (biffo init)', () => {
    writeInstanceCoreVersion(dir, '1.5.0')
    expect(JSON.parse(readFileSync(join(dir, 'biffo.core.json'), 'utf8'))).toEqual({
      version: '1.5.0',
    })
  })
})

describe('planCoreVersionCleanup (#434)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-cleanup-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when there is no core.version file', () => {
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.3.0' }))
    expect(planCoreVersionCleanup(dir)).toBeNull()
  })

  it('deletes when core.version equals the version biffo.core.json records', () => {
    writeFileSync(join(dir, 'core.version'), '0.3.0\n')
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.3.0' }))
    expect(planCoreVersionCleanup(dir)).toEqual({
      path: join(dir, 'core.version'),
      action: 'delete',
      found: '0.3.0',
    })
  })

  it('treats equality semver-wise, tolerating surrounding whitespace', () => {
    writeFileSync(join(dir, 'core.version'), '  0.3.0  \n')
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.3.0' }))
    expect(planCoreVersionCleanup(dir)?.action).toBe('delete')
  })

  it('keeps a repurposed core.version that differs from biffo.core.json', () => {
    writeFileSync(join(dir, 'core.version'), '4.7.2\n')
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.3.0' }))
    expect(planCoreVersionCleanup(dir)).toEqual({
      path: join(dir, 'core.version'),
      action: 'keep',
      found: '4.7.2',
      reason: 'repurposed',
    })
  })

  it('keeps a core.version repurposed to a non-semver string', () => {
    writeFileSync(join(dir, 'core.version'), 'internal-build-42\n')
    writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.3.0' }))
    expect(planCoreVersionCleanup(dir)).toMatchObject({ action: 'keep', reason: 'repurposed' })
  })

  it('keeps core.version when biffo.core.json is absent (no authority)', () => {
    writeFileSync(join(dir, 'core.version'), '0.3.0\n')
    expect(planCoreVersionCleanup(dir)).toMatchObject({ action: 'keep', reason: 'no-authority' })
  })

  it('keeps core.version when biffo.core.json is present but unparseable', () => {
    writeFileSync(join(dir, 'core.version'), '0.3.0\n')
    writeFileSync(join(dir, 'biffo.core.json'), '{ not json')
    expect(planCoreVersionCleanup(dir)).toMatchObject({ action: 'keep', reason: 'no-authority' })
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
