import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareCoreVersions,
  findCoreVersionUpward,
  parseCoreVersion,
  readCoreVersionFile,
  readInstanceCoreVersion,
} from './core-version.js'

const here = dirname(fileURLToPath(import.meta.url))
// cli/src/lib -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..')

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

  it('returns null when biffo.core.json is absent', () => {
    expect(readInstanceCoreVersion(dir)).toBeNull()
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

describe('template repo invariant', () => {
  it('root core.version and biffo.core.json record the same version', () => {
    const version = readCoreVersionFile(join(repoRoot, 'core.version'))
    const instance = JSON.parse(readFileSync(join(repoRoot, 'biffo.core.json'), 'utf8')) as {
      version: string
    }
    expect(instance.version).toBe(version)
  })
})
