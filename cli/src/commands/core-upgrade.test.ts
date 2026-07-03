import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreUpgradeDeps } from './core-upgrade.js'
import { runCoreUpgrade } from './core-upgrade.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
import { log } from '../lib/logger.js'

const MANIFEST = { version: 1, templateOwned: ['services/api/'], userOwned: ['services/'] }

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function fakeDeps(over: Partial<ReturnType<typeof fakeGit>> = {}) {
  const git = fakeGit(over)
  const createPullRequest = vi.fn().mockResolvedValue({
    url: 'https://github.com/acme/instance/pull/7',
    number: 7,
  })
  const deps: CoreUpgradeDeps = {
    git,
    makeGitHub: () => ({ createPullRequest }),
    resolveToken: () => 'TOKEN',
  }
  return { deps, git, createPullRequest }
}

function fakeGit(over: Record<string, unknown> = {}) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    hasUncommittedChanges: vi.fn().mockResolvedValue(false),
    currentBranch: vi.fn().mockResolvedValue('main'),
    getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:acme/instance.git'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

describe('runCoreUpgrade --apply', () => {
  let base: string
  let theirs: string
  let instance: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    base = mkdtempSync(join(tmpdir(), 'base-'))
    theirs = mkdtempSync(join(tmpdir(), 'theirs-'))
    instance = mkdtempSync(join(tmpdir(), 'inst-'))
    // base @ 0.1.0
    writeFileSync(join(base, 'core.version'), '0.1.0\n')
    writeFileSync(join(base, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(base, 'services/api/main.py', 'v1')
    // theirs @ 0.2.0 — changes main.py, adds a file
    writeFileSync(join(theirs, 'core.version'), '0.2.0\n')
    writeFileSync(join(theirs, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(theirs, 'services/api/main.py', 'v2')
    w(theirs, 'services/api/added.py', 'NEW')
    // instance @ 0.1.0, unmodified main.py
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    w(instance, 'services/api/main.py', 'v1')
  })
  afterEach(() => {
    for (const d of [base, theirs, instance]) rmSync(d, { recursive: true, force: true })
  })

  it('creates a branch, applies files, bumps biffo.core.json, commits, pushes, opens a PR', async () => {
    const { deps, git, createPullRequest } = fakeDeps()

    await runCoreUpgrade({ cwd: instance, baseDir: base, theirsDir: theirs, apply: true }, deps)

    // branch created from the from->to version
    expect(git.createBranch).toHaveBeenCalledWith(instance, 'biffo/core-upgrade-0.1.0-to-0.2.0')
    // files applied to the instance working tree
    expect(readFileSync(join(instance, 'services/api/main.py'), 'utf8')).toBe('v2')
    expect(readFileSync(join(instance, 'services/api/added.py'), 'utf8')).toBe('NEW')
    // biffo.core.json bumped to the target
    expect(JSON.parse(readFileSync(join(instance, 'biffo.core.json'), 'utf8'))).toEqual({
      version: '0.2.0',
    })
    // staged, committed, pushed with the token
    expect(git.add).toHaveBeenCalledWith(instance, ['-A'])
    expect(git.commit).toHaveBeenCalledWith(instance, expect.stringContaining('0.1.0 -> 0.2.0'))
    expect(git.push).toHaveBeenCalledWith(instance, 'biffo/core-upgrade-0.1.0-to-0.2.0', {
      token: 'TOKEN',
    })
    // PR opened against the parsed owner/repo and current branch
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'instance',
        head: 'biffo/core-upgrade-0.1.0-to-0.2.0',
        base: 'main',
        title: expect.stringContaining('0.1.0 → 0.2.0'),
      }),
    )
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('pull/7'))
  })

  it('refuses to apply a conflicting plan without --allow-conflicts', async () => {
    // Make the instance locally edit main.py so it conflicts with theirs.
    w(instance, 'services/api/main.py', 'LOCAL EDIT')
    const { deps, git, createPullRequest } = fakeDeps()

    await expect(
      runCoreUpgrade({ cwd: instance, baseDir: base, theirsDir: theirs, apply: true }, deps),
    ).rejects.toThrow(/conflict/i)

    expect(git.createBranch).not.toHaveBeenCalled()
    expect(createPullRequest).not.toHaveBeenCalled()
  })

  it('opens a conflict PR when --allow-conflicts is set', async () => {
    w(instance, 'services/api/main.py', 'LOCAL EDIT')
    const { deps, createPullRequest } = fakeDeps()

    await runCoreUpgrade(
      { cwd: instance, baseDir: base, theirsDir: theirs, apply: true, allowConflicts: true },
      deps,
    )

    expect(createPullRequest).toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('conflict'))
  })

  it('refuses to run on a dirty working tree', async () => {
    const { deps, git } = fakeDeps({ hasUncommittedChanges: vi.fn().mockResolvedValue(true) })
    await expect(
      runCoreUpgrade({ cwd: instance, baseDir: base, theirsDir: theirs, apply: true }, deps),
    ).rejects.toThrow(/uncommitted/i)
    expect(git.createBranch).not.toHaveBeenCalled()
  })

  it('dry run (no --apply) never touches git or the working tree', async () => {
    const { deps, git, createPullRequest } = fakeDeps()
    await runCoreUpgrade({ cwd: instance, baseDir: base, theirsDir: theirs }, deps)
    expect(readFileSync(join(instance, 'services/api/main.py'), 'utf8')).toBe('v1') // unchanged
    expect(git.createBranch).not.toHaveBeenCalled()
    expect(createPullRequest).not.toHaveBeenCalled()
  })
})
