import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir, sweepTmpDirs } from './tmp.js'

describe('makeTmpDir', () => {
  it('creates a directory under the OS tmp root with the given prefix', () => {
    const dir = makeTmpDir('tmp-helper-unit')
    expect(existsSync(dir)).toBe(true)
    expect(dirname(dir)).toBe(tmpdir())
    expect(basename(dir).startsWith('tmp-helper-unit-')).toBe(true)
    sweepTmpDirs()
  })

  it('sweepTmpDirs removes every directory created since the last sweep', () => {
    const first = makeTmpDir('tmp-helper-sweep-a')
    const second = makeTmpDir('tmp-helper-sweep-b')
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)

    sweepTmpDirs()

    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(false)
  })

  it('sweepTmpDirs is idempotent and safe with nothing to clean', () => {
    sweepTmpDirs()
    expect(() => sweepTmpDirs()).not.toThrow()
  })

  it('a swept dir is not re-removed (and does not error) on a second sweep', () => {
    const dir = makeTmpDir('tmp-helper-double-sweep')
    sweepTmpDirs()
    expect(existsSync(dir)).toBe(false)
    expect(() => sweepTmpDirs()).not.toThrow()
  })
})
