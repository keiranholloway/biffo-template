/**
 * The load-bearing overwrite guard, raced (#1222).
 *
 * `applyMigrationCarry` exists *specifically* to refuse an overwrite. It used
 * to express that as:
 *
 * ```js
 * if (existsSync(path)) throw new Error('… already exists …')
 * writeFileSync(path, content)
 * ```
 *
 * which is not a refusal. Between the check and the write another process can
 * create the file, and `writeFileSync` overwrites it anyway — so the guard
 * reads as protection and is not. CodeQL found both as high-severity
 * `js/file-system-race` on the first real scan of this repo.
 *
 * ## How these tests race it
 *
 * The functions are synchronous, so a second in-process caller cannot actually
 * interleave with the first — nothing here can preempt a `writeFileSync`.
 * What these tests do instead is reproduce the *effect* the losing half of the
 * race has on the code under test: `existsSync` reports the path as free, and
 * by the time the write happens the file really is there. That is precisely
 * what a concurrent creator produces, and it is what makes a check-then-write
 * clobber the other process's file.
 *
 * A fix that merely narrows the window still fails these. Only removing the
 * window passes: `writeFileSync(path, data, { flag: 'wx' })` is create-or-fail
 * decided by the kernel in one operation, so a lying `existsSync` cannot reach
 * the write at all — there is no check left to lie to.
 *
 * The assertion is deliberately two-part: the same user-facing error must
 * still be thrown (behaviour preserved — the messages are better worded than
 * anything `EEXIST` produces, and tests depend on them), AND the file that was
 * already there must survive byte-for-byte. Against the old code the first
 * assertion fails outright, because no error is thrown at all.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above ordinary
 * top-level declarations; a plain `let` read from the factory is in its
 * temporal dead zone when the factory runs.
 */
const race = vi.hoisted(() => ({ existsSyncLies: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    /**
     * Pass-through unless a test opts in, so every other consumer of `node:fs`
     * in this file — including `makeTmpDir` — behaves exactly as normal.
     */
    existsSync: (p: Parameters<typeof actual.existsSync>[0]): boolean =>
      race.existsSyncLies ? false : actual.existsSync(p),
  }
})

afterEach(() => {
  race.existsSyncLies = false
  vi.resetModules()
})

/** Write a file the "other process" is deemed to have just created. */
function seedRival(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('applyMigrationCarry — refusing to overwrite is atomic, not advisory', () => {
  const RIVAL = '# written by the other upgrade, one instruction ago\n'

  function planFor(path: string) {
    return {
      entries: [
        {
          path,
          file: '0001_a.py',
          revision: '0001',
          downRevision: null,
          content: '# the carry that must NOT land\n',
        },
      ],
      instanceHead: null,
      skipped: [],
      recognised: [],
      declined: [],
      staleDeclines: [],
      divergedBodies: [],
    }
  }

  it('refuses, and leaves the rival migration intact, when the file appears after the check', async () => {
    const { applyMigrationCarry } = await import('./core-migrations.js')
    const instanceDir = makeTmpDir('inst-race')
    const rel = 'services/api/migrations/versions/0001_a.py'
    const abs = join(instanceDir, rel)
    seedRival(abs, RIVAL)

    // The concurrent creator won the check and lost the write — under the old
    // check-then-write this silently overwrote an applied migration.
    race.existsSyncLies = true

    expect(() => applyMigrationCarry(instanceDir, planFor(rel))).toThrow(
      /Refusing to overwrite an existing migration: services\/api\/migrations\/versions\/0001_a\.py/,
    )
    expect(readFileSync(abs, 'utf8')).toBe(RIVAL)
  })

  it('still creates the file normally when nothing else is writing it', async () => {
    const { applyMigrationCarry } = await import('./core-migrations.js')
    const instanceDir = makeTmpDir('inst-race')
    const rel = 'services/api/migrations/versions/0001_a.py'
    race.existsSyncLies = true // no rival file exists, so `wx` must succeed

    expect(applyMigrationCarry(instanceDir, planFor(rel))).toEqual([rel])
    expect(readFileSync(join(instanceDir, rel), 'utf8')).toBe('# the carry that must NOT land\n')
  })
})
