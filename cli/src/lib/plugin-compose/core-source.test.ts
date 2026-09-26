import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../test-utils/tmp.js'
import type { CommandRunner } from './command-runner.js'
import { CORE_MARKER, isCoreRoot, resolveCoreRoot } from './core-source.js'

const dirs: string[] = []
function tmp(): string {
  const d = makeTmpDir('core-source-')
  dirs.push(d)
  return d
}
function fakeCore(root: string): string {
  mkdirSync(join(root, CORE_MARKER, '..'), { recursive: true })
  writeFileSync(join(root, CORE_MARKER), '')
  return root
}
afterEach(() => dirs.splice(0).forEach(removeTmpDir))

const neverRuns: CommandRunner = {
  run: () => {
    throw new Error('must not fetch')
  },
}

describe('resolveCoreRoot', () => {
  it('uses --core-root when it is a real checkout, without fetching', () => {
    const core = fakeCore(tmp())
    expect(
      resolveCoreRoot({ explicit: core, env: {}, coreTag: 'core-v1', runner: neverRuns }),
    ).toBe(core)
  })

  it('falls back to BIFFO_CORE_ROOT', () => {
    const core = fakeCore(tmp())
    expect(
      resolveCoreRoot({ env: { BIFFO_CORE_ROOT: core }, coreTag: 'core-v1', runner: neverRuns }),
    ).toBe(core)
  })

  it('rejects a directory that is not a Core checkout, naming what it looked for', () => {
    const notCore = tmp()
    expect(isCoreRoot(notCore)).toBe(false)
    expect(() =>
      resolveCoreRoot({ explicit: notCore, env: {}, coreTag: 'core-v1', runner: neverRuns }),
    ).toThrow(/not a biffo-template checkout/)
  })

  it('fetches the pinned core tag into the cache when nothing is supplied', () => {
    const cache = tmp()
    const calls: string[][] = []
    const runner: CommandRunner = {
      run: (cmd, args) => {
        calls.push([cmd, ...args])
        fakeCore(args[args.length - 1]!)
        return { status: 0, stdout: '' }
      },
    }
    const root = resolveCoreRoot({ env: {}, coreTag: 'core-v9.9.9', cacheDir: cache, runner })
    expect(root).toBe(join(cache, 'core-v9.9.9'))
    expect(calls[0]).toEqual(expect.arrayContaining(['git', 'clone', '--branch', 'core-v9.9.9']))
    // A second resolution reuses the cache and does not fetch again.
    expect(
      resolveCoreRoot({ env: {}, coreTag: 'core-v9.9.9', cacheDir: cache, runner: neverRuns }),
    ).toBe(root)
  })

  it('a failed fetch is an error that says how to supply Core yourself — never a silent empty root', () => {
    const runner: CommandRunner = { run: () => ({ status: 128, stdout: '' }) }
    expect(() => resolveCoreRoot({ env: {}, coreTag: 'core-v9', cacheDir: tmp(), runner })).toThrow(
      /--core-root/,
    )
  })

  it('a fetch that "succeeds" but yields no Core is still an error', () => {
    const runner: CommandRunner = { run: () => ({ status: 0, stdout: '' }) }
    expect(() => resolveCoreRoot({ env: {}, coreTag: 'core-v9', cacheDir: tmp(), runner })).toThrow(
      /Could not fetch Core/,
    )
  })
})
