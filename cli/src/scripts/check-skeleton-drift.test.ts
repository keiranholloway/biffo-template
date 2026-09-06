/**
 * `biffo check skeleton-drift` (biffo-template#1363's wiring, #1906's
 * satellite fix).
 *
 * `runSkeletonDriftCheck` takes no options — it always resolves its root via
 * `git rev-parse --show-toplevel` — so these tests mock the underlying
 * `execa` package (not `../lib/exec.js`, which just wraps it) to point that
 * resolution at a disposable tmp tree, the same technique
 * `check-branch-protection.test.ts` already uses for its own git call.
 *
 * The satellite-shaped case (#1906) is the one this file exists to add: a
 * repo with no `_skeletons/` directory at all used to be indistinguishable
 * from a repo whose skeleton discovery had broken, and `runSkeletonDriftCheck`
 * hard-failed (`process.exit(1)`, "Refusing to report success over zero
 * input") on every one of the 15 satellites in the shared-sync rehearsal.
 * The genuine "discovery broke" case — `_skeletons/` exists but nothing
 * under it qualifies as a real skeleton — must still fail exactly as before;
 * that is exercised here too, so the fix cannot be read as silencing the
 * real signal along with the false one.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runSkeletonDriftCheck } from './check-skeleton-drift.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function setRoot(root: string): void {
  vi.mocked(execa).mockResolvedValue({ stdout: root } as never)
}

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

describe('runSkeletonDriftCheck', () => {
  it('is not applicable (exit 0, no crash) in a satellite tree with no _skeletons/ at all (#1906)', async () => {
    const root = makeTmpDir('skeleton-drift-satellite')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(root)

    await expect(runSkeletonDriftCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('no _skeletons/ directory')
    expect(logged.toLowerCase()).toContain('not applicable')
  })

  it('STILL fails (exit 1) when _skeletons/ exists but nothing under it qualifies as a real skeleton', async () => {
    const root = makeTmpDir('skeleton-drift-broken-discovery')
    // A directory under _skeletons/ with no ci.yml never counts as a real
    // skeleton (discoverSkeletons's own filter) — this is the genuine
    // "discovery broke" shape, and it must still fail closed exactly as
    // before #1906's fix, not be waved through by the new satellite branch.
    write(root, '_skeletons/plugin-template/README.md', '# not a real skeleton dir')
    setRoot(root)

    await expect(runSkeletonDriftCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('Refusing to report success over zero input')
  })
})
