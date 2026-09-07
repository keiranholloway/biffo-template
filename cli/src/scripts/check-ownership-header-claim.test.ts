/**
 * `biffo check ownership-header-claim` (#1911).
 *
 * `runOwnershipHeaderClaimCheck` resolves its root via `git rev-parse
 * --show-toplevel` (mocked here, same technique as `check-skeleton-
 * drift.test.ts`), then reads `core-manifest.json` and sweeps git-TRACKED
 * files via `gitTrackedFiles` (`../lib/git-tracked-files.js`), which shells
 * out to the real `git` binary rather than the mocked `execa` wrapper — so
 * these fixtures are real, disposable git repos (`git init` + `git add`,
 * no commit needed since `git ls-files` reads the index).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runOwnershipHeaderClaimCheck } from './check-ownership-header-claim.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function initGitRepo(root: string): void {
  execFileSync('git', ['-C', root, 'init', '-q'])
  execFileSync('git', ['-C', root, 'add', '-A'])
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

const MANIFEST_JSON = JSON.stringify({
  version: 1,
  templateOwned: ['scripts/'],
  userOwned: [],
})

const MANIFEST_WITH_CARVEOUT_JSON = JSON.stringify({
  version: 1,
  templateOwned: ['scripts/'],
  userOwned: ['scripts/verify-deployed.checks'],
})

describe('runOwnershipHeaderClaimCheck', () => {
  it('skips cleanly on a satellite repo with no core-manifest.json at all', async () => {
    const root = makeTmpDir('ownership-header-satellite')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(root)

    await expect(runOwnershipHeaderClaimCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('skipped')
  })

  it('fails closed (exit 1) when the sweep finds zero header claims — refuses a false green', async () => {
    const root = makeTmpDir('ownership-header-zero-hits')
    write(root, 'core-manifest.json', MANIFEST_JSON)
    write(root, 'scripts/plain.sh', '#!/usr/bin/env sh\necho hello\n')
    initGitRepo(root)
    setRoot(root)

    await expect(runOwnershipHeaderClaimCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('swept zero files')
  })

  // Fail-first evidence for #1911: reproduce the exact #1706/#1707 shape —
  // a header claiming INSTANCE-OWNED while core-manifest.json has no
  // carve-out for the file, so it is template-owned by default.
  it('fails closed (exit 1) and names the file when a header claim disagrees with core-manifest.json', async () => {
    const root = makeTmpDir('ownership-header-disagreement')
    write(root, 'core-manifest.json', MANIFEST_JSON) // no carve-out yet
    write(
      root,
      'scripts/verify-deployed.checks',
      '# Checks for `verify-deployed.sh`. INSTANCE-OWNED — the mechanism is the same across\n' +
        '# the estate, the checks are not.\n',
    )
    initGitRepo(root)
    setRoot(root)

    await expect(runOwnershipHeaderClaimCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('scripts/verify-deployed.checks')
    expect(reported).toContain('INSTANCE-OWNED')
    expect(reported).toContain('template-owned')
  })

  it('passes (no exit) once the manifest carve-out matches the header claim — the actual #1707 fix', async () => {
    const root = makeTmpDir('ownership-header-agrees')
    write(root, 'core-manifest.json', MANIFEST_WITH_CARVEOUT_JSON)
    write(
      root,
      'scripts/verify-deployed.checks',
      '# Checks for `verify-deployed.sh`. INSTANCE-OWNED — the mechanism is the same across\n' +
        '# the estate, the checks are not.\n',
    )
    initGitRepo(root)
    setRoot(root)

    await expect(runOwnershipHeaderClaimCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('all agree with core-manifest.json')
  })

  it('checks an INSTANCE tree the same way (biffo.core.json present alongside core-manifest.json)', async () => {
    const root = makeTmpDir('ownership-header-instance')
    write(root, 'core-manifest.json', MANIFEST_JSON)
    write(root, 'biffo.core.json', JSON.stringify({ coreVersion: '0.1.0' }))
    write(
      root,
      'scripts/verify-deployed.checks',
      '# INSTANCE-OWNED — this instance drifted its header without a manifest carve-out.\n',
    )
    initGitRepo(root)
    setRoot(root)

    await expect(runOwnershipHeaderClaimCheck()).rejects.toThrow('process.exit(1)')
    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('scripts/verify-deployed.checks')
  })
})
