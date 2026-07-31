import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreUpgradeDeps } from './core-upgrade.js'
import { buildPrBody, runCoreUpgrade } from './core-upgrade.js'
import type { MergeEntry, MergeStatus, UpgradePlan } from '../lib/core-upgrade.js'
import type { MigrationCarryPlan } from '../lib/core-migrations.js'

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
  // Instances integrate on `dev`, the template on `main`. The fake answers
  // `dev` so a regression to "use the current branch" (which the git fake
  // reports as `main`) shows up as a wrong base rather than passing by accident.
  const defaultBranch = vi.fn().mockResolvedValue('dev')
  const createPullRequest = vi.fn().mockResolvedValue({
    url: 'https://github.com/acme/instance/pull/7',
    number: 7,
  })
  const deps: CoreUpgradeDeps = {
    git,
    makeGitHub: () => ({ createPullRequest, defaultBranch }),
    resolveToken: () => 'TOKEN',
    // Default: the template checkout faithfully matches the target tag, so the
    // working-tree fast path is taken. Tests that exercise a drifted checkout
    // (#471) override this to false.
    workingTreeMatchesTag: () => true,
  }
  return { deps, git, createPullRequest, defaultBranch }
}

function fakeGit(over: Record<string, unknown> = {}) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    hasUncommittedChanges: vi.fn().mockResolvedValue(false),
    currentBranch: vi.fn().mockResolvedValue('main'),
    fetch: vi.fn().mockResolvedValue(undefined),
    aheadBehind: vi.fn().mockResolvedValue({ ahead: 0, behind: 0, hasUpstream: true }),
    getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:acme/instance.git'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    switchBranch: vi.fn().mockResolvedValue(undefined),
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
    const { deps, git, createPullRequest, defaultBranch } = fakeDeps()

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps,
    )

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
    // PR opened against the parsed owner/repo and the repo's DEFAULT branch —
    // not the branch the caller happens to be on. The git fake reports `main`
    // as current and the GitHub fake reports `dev` as default, so this asserts
    // which of the two is used.
    expect(defaultBranch).toHaveBeenCalledWith({ owner: 'acme', repo: 'instance' })
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'instance',
        head: 'biffo/core-upgrade-0.1.0-to-0.2.0',
        base: 'dev',
        title: expect.stringContaining('0.1.0 → 0.2.0'),
      }),
    )
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('pull/7'))
  })

  it('honors an explicit --base over the repo default', async () => {
    const { deps, createPullRequest, defaultBranch } = fakeDeps()
    await runCoreUpgrade(
      {
        cwd: instance,
        templateRepo: theirs,
        baseDir: base,
        theirsDir: theirs,
        apply: true,
        base: 'release/2026-07',
      },
      deps,
    )
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'release/2026-07' }),
    )
    expect(defaultBranch).not.toHaveBeenCalled()
  })

  it('auto-resolves the merge base from the instance version tag when --from-template is omitted', async () => {
    const { deps, git, createPullRequest } = fakeDeps()
    const cleanup = vi.fn()
    // Fake materialize: the base tree at the instance's version (0.1.0) is the
    // `base` fixture; the target (0.2.0) equals templateRepo's working version,
    // so it is used directly and never materialized.
    const materialize = vi.fn((_repo: string, version: string) => {
      expect(version).toBe('0.1.0')
      return { dir: base, cleanup }
    })

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, apply: true },
      { ...deps, materialize },
    )

    expect(materialize).toHaveBeenCalledTimes(1)
    expect(materialize).toHaveBeenCalledWith(theirs, '0.1.0')
    expect(cleanup).toHaveBeenCalledTimes(1) // temp base tree disposed
    // Same result as the explicit-dirs path.
    expect(git.createBranch).toHaveBeenCalledWith(instance, 'biffo/core-upgrade-0.1.0-to-0.2.0')
    expect(readFileSync(join(instance, 'services/api/main.py'), 'utf8')).toBe('v2')
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('0.1.0 → 0.2.0') }),
    )
  })

  it('extracts the TARGET tag instead of the working tree when the checkout has drifted (#471)', async () => {
    // The bug: when target == latest, the template's working tree was used as
    // `theirs` directly. A checkout behind/ahead of the tag then silently shipped
    // stale content as the upgrade target while still reporting the right
    // version. With the gate returning false, the target must be MATERIALIZED
    // from its tag, not read from the working tree.
    const { deps } = fakeDeps()
    const cleanup = vi.fn()
    // A separate, CORRECT target tree at 0.2.0 (what the tag would extract),
    // distinct from `theirs` — proving the extract, not the working dir, is used.
    const taggedTarget = mkdtempSync(join(tmpdir(), 'tagged-'))
    writeFileSync(join(taggedTarget, 'core.version'), '0.2.0\n')
    writeFileSync(join(taggedTarget, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(taggedTarget, 'services/api/main.py', 'v2-from-tag')
    w(taggedTarget, 'services/api/added.py', 'NEW')

    const materialize = vi.fn((_repo: string, version: string) => {
      if (version === '0.1.0') return { dir: base, cleanup }
      if (version === '0.2.0') return { dir: taggedTarget, cleanup }
      throw new Error(`unexpected version ${version}`)
    })

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, apply: true },
      { ...deps, materialize, workingTreeMatchesTag: () => false },
    )

    // Both base AND target were extracted from their tags (the fix): the drifted
    // working tree was never trusted as the target.
    expect(materialize).toHaveBeenCalledWith(theirs, '0.2.0')
    // The applied content came from the TAGGED target, not `theirs`' working tree.
    expect(readFileSync(join(instance, 'services/api/main.py'), 'utf8')).toBe('v2-from-tag')

    rmSync(taggedTarget, { recursive: true, force: true })
  })

  it('errors when the instance version is unknown and no --from-template is given', async () => {
    rmSync(join(instance, 'biffo.core.json'))
    const { deps } = fakeDeps()
    await expect(
      runCoreUpgrade({ cwd: instance, templateRepo: theirs }, { ...deps, materialize: vi.fn() }),
    ).rejects.toThrow(/current core version/)
  })

  it('refuses to apply a conflicting plan without --allow-conflicts', async () => {
    // Make the instance locally edit main.py so it conflicts with theirs.
    w(instance, 'services/api/main.py', 'LOCAL EDIT')
    const { deps, git, createPullRequest } = fakeDeps()

    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
        deps,
      ),
    ).rejects.toThrow(/conflict/i)

    expect(git.createBranch).not.toHaveBeenCalled()
    expect(createPullRequest).not.toHaveBeenCalled()
  })

  it('opens a conflict PR when --allow-conflicts is set', async () => {
    w(instance, 'services/api/main.py', 'LOCAL EDIT')
    const { deps, createPullRequest } = fakeDeps()

    await runCoreUpgrade(
      {
        cwd: instance,
        templateRepo: theirs,
        baseDir: base,
        theirsDir: theirs,
        apply: true,
        allowConflicts: true,
      },
      deps,
    )

    expect(createPullRequest).toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('conflict'))
  })

  it('refuses to run on a dirty working tree', async () => {
    const { deps, git } = fakeDeps({ hasUncommittedChanges: vi.fn().mockResolvedValue(true) })
    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
        deps,
      ),
    ).rejects.toThrow(/uncommitted/i)
    expect(git.createBranch).not.toHaveBeenCalled()
  })

  // #394 — currency of the instance tree ("ours") is established BEFORE any plan
  // is computed, since a stale/detached tree silently produces a wrong merge.

  it('refuses a detached HEAD before planning', async () => {
    const { deps } = fakeDeps({ currentBranch: vi.fn().mockResolvedValue('HEAD') })
    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs },
        deps,
      ),
    ).rejects.toThrow(/detached HEAD/i)
  })

  it('refuses a branch that is behind its upstream', async () => {
    const { deps } = fakeDeps({
      aheadBehind: vi.fn().mockResolvedValue({ ahead: 0, behind: 3, hasUpstream: true }),
    })
    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs },
        deps,
      ),
    ).rejects.toThrow(/behind its upstream/i)
  })

  it('fetches before the ahead/behind check', async () => {
    const { deps, git } = fakeDeps()
    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs },
      deps,
    )
    expect(git.fetch).toHaveBeenCalledWith(instance)
  })

  it('allows a dirty tree with --allow-dirty', async () => {
    const { deps, createPullRequest } = fakeDeps({
      hasUncommittedChanges: vi.fn().mockResolvedValue(true),
    })
    await runCoreUpgrade(
      {
        cwd: instance,
        templateRepo: theirs,
        baseDir: base,
        theirsDir: theirs,
        apply: true,
        allowDirty: true,
      },
      deps,
    )
    expect(createPullRequest).toHaveBeenCalled()
  })

  it('does not check currency when the tree is not a git repo (dry run on loose files)', async () => {
    const { deps, git } = fakeDeps({ isGitRepo: vi.fn().mockResolvedValue(false) })
    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs },
      deps,
    )
    expect(git.fetch).not.toHaveBeenCalled()
  })

  it('dry run (no --apply) never touches git or the working tree', async () => {
    const { deps, git, createPullRequest } = fakeDeps()
    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs },
      deps,
    )
    expect(readFileSync(join(instance, 'services/api/main.py'), 'utf8')).toBe('v1') // unchanged
    expect(git.createBranch).not.toHaveBeenCalled()
    expect(createPullRequest).not.toHaveBeenCalled()
  })
})

/**
 * Issue #393, reopened half: the refresh fired on entries that wrote nothing.
 *
 * `plan.changes` is what the upgrade *considered*; it includes `removed`
 * entries for files the instance never had, which land nothing on disk. The
 * refresh now reads `applyUpgradePlan`'s result instead — what actually
 * happened — so these tests drive the whole command and assert on whether the
 * lockfile commands ran at all.
 */
describe('runCoreUpgrade — lockfile refresh is driven by what landed (#393)', () => {
  // Root manifests and _skeletons/ are template-owned, as in the real
  // core-manifest.json; services/ stays user-owned so it does not sweep in.
  const LOCK_MANIFEST = {
    version: 1,
    templateOwned: ['services/api/', 'package.json', 'pyproject.toml', '_skeletons/'],
    userOwned: ['services/'],
  }

  let base: string
  let theirs: string
  let instance: string
  let runCommand: ReturnType<typeof vi.fn>

  function seed(root: string, version: string): void {
    writeFileSync(join(root, 'core.version'), `${version}\n`)
    writeFileSync(join(root, 'core-manifest.json'), JSON.stringify(LOCK_MANIFEST))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    base = mkdtempSync(join(tmpdir(), 'lock-base-'))
    theirs = mkdtempSync(join(tmpdir(), 'lock-theirs-'))
    instance = mkdtempSync(join(tmpdir(), 'lock-inst-'))
    seed(base, '0.1.0')
    seed(theirs, '0.2.0')
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    // The instance locks both ecosystems, so nothing is skipped for a missing
    // lockfile and the assertions are about the trigger, not its guard.
    writeFileSync(join(instance, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(instance, 'uv.lock'), 'version = 1\n')
    // Something must always change, or the upgrade is a no-op and exits early.
    w(base, 'services/api/main.py', 'v1')
    w(theirs, 'services/api/main.py', 'v2')
    w(instance, 'services/api/main.py', 'v1')
    runCommand = vi.fn().mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    for (const d of [base, theirs, instance]) rmSync(d, { recursive: true, force: true })
  })

  async function upgrade(): Promise<void> {
    const { deps } = fakeDeps()
    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      {
        ...deps,
        runCommand,
      } as CoreUpgradeDeps,
    )
  }

  /**
   * The exact pair of entries that fired the false positive on
   * tabsii-platform 0.50.2 -> 0.53.0. `_skeletons/` is template-owned and the
   * instance does not carry it, so both sides agree and the instance's absence
   * is respected — status `removed`, nothing written, nothing deleted.
   */
  it('does not refresh for _skeletons/ manifests the instance never had', async () => {
    for (const root of [base, theirs]) {
      w(root, '_skeletons/sibling-template/apps/frontend/package.json', '{"name":"frontend"}')
      w(root, '_skeletons/sibling-template/services/api/pyproject.toml', '[project]\n')
    }

    await upgrade()

    expect(runCommand).not.toHaveBeenCalled()
    // And it does not claim otherwise in the log.
    const info = vi.mocked(log.info).mock.calls.map((c) => String(c[0]))
    expect(info.some((m) => m.includes('Refreshed'))).toBe(false)
  })

  /**
   * The same defect with `_skeletons/` taken out of the picture: a `removed`
   * entry for a manifest on a path this repo really does lock, which the
   * instance simply never had. `plan.changes` lists it; nothing is written or
   * deleted, so nothing is invalidated. This is the assertion the exclusion
   * alone cannot make.
   */
  it('restores a template-owned manifest the instance deleted, and refreshes (#395)', async () => {
    w(base, 'services/api/pyproject.toml', '[project]\nname = "api"\n')
    w(theirs, 'services/api/pyproject.toml', '[project]\nname = "api"\n')
    // The instance deleted a template-owned manifest — drift. The upgrade
    // restores it (#395), which changes dependency resolution, so the lockfile
    // refresh runs (it is no longer a silent no-op).

    await upgrade()

    expect(existsSync(join(instance, 'services/api/pyproject.toml'))).toBe(true)
    expect(runCommand).toHaveBeenCalled()
  })

  it('still refreshes when a real root manifest is rewritten', async () => {
    writeFileSync(join(base, 'package.json'), '{"name":"inst"}\n')
    writeFileSync(join(theirs, 'package.json'), '{"name":"inst","overrides":{"sharp":"1"}}\n')
    writeFileSync(join(instance, 'package.json'), '{"name":"inst"}\n')

    await upgrade()

    expect(runCommand).toHaveBeenCalledWith(['pnpm', 'install', '--lockfile-only'], instance)
    expect(vi.mocked(log.info).mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('pnpm-lock.yaml'),
    )
  })

  /**
   * Why the filtering reads the apply result rather than dropping `removed` by
   * status: a `removed` entry that actually deletes a workspace member's
   * manifest changes resolution just as much as editing one does. Filtering on
   * status would have silently stopped refreshing here.
   */
  it('refreshes when a workspace member manifest is genuinely deleted', async () => {
    writeFileSync(join(base, 'pyproject.toml'), '[project]\nname = "x"\n')
    writeFileSync(join(instance, 'pyproject.toml'), '[project]\nname = "x"\n')
    // absent from `theirs` — upstream removed it, and the instance had not
    // touched it, so the upgrade deletes it for real.

    await upgrade()

    expect(existsSync(join(instance, 'pyproject.toml'))).toBe(false)
    expect(runCommand).toHaveBeenCalledWith(['uv', 'lock'], instance)
  })
})

/**
 * Issue #434: an instance may still carry an orphaned `core.version` inherited
 * before #423 retired it from the template. An upgrade deletes it, but only when
 * it is provably the un-repurposed inherited value — one known instance
 * repurposed the file as its own app-release lineage, and deleting that would
 * destroy real data. The decision fails closed toward keeping the file.
 */
describe('runCoreUpgrade — orphaned core.version cleanup (#434)', () => {
  let base: string
  let theirs: string
  let instance: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    base = mkdtempSync(join(tmpdir(), 'cv-base-'))
    theirs = mkdtempSync(join(tmpdir(), 'cv-theirs-'))
    instance = mkdtempSync(join(tmpdir(), 'cv-inst-'))
    // base @ 0.1.0, theirs @ 0.2.0 — something changes so the upgrade is not a no-op.
    writeFileSync(join(base, 'core.version'), '0.1.0\n')
    writeFileSync(join(base, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(base, 'services/api/main.py', 'v1')
    writeFileSync(join(theirs, 'core.version'), '0.2.0\n')
    writeFileSync(join(theirs, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(theirs, 'services/api/main.py', 'v2')
    // instance @ 0.1.0 per biffo.core.json, unmodified main.py.
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    w(instance, 'services/api/main.py', 'v1')
  })
  afterEach(() => {
    for (const d of [base, theirs, instance]) rmSync(d, { recursive: true, force: true })
  })

  async function apply(): Promise<ReturnType<typeof fakeDeps>> {
    const deps = fakeDeps()
    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps.deps,
    )
    return deps
  }

  it('deletes core.version when it matches the version biffo.core.json records', async () => {
    // Inherited copy still equals what biffo.core.json records (0.1.0) — the
    // pristine post-init shape, un-repurposed.
    writeFileSync(join(instance, 'core.version'), '0.1.0\n')

    const { createPullRequest } = await apply()

    expect(existsSync(join(instance, 'core.version'))).toBe(false)
    // The deletion is surfaced, not silent.
    expect(vi.mocked(log.info).mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('core.version'),
    )
    // ...and explained in the PR body.
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('removed orphaned') }),
    )
  })

  it('keeps core.version when it differs from biffo.core.json (looks repurposed)', async () => {
    // The instance repurposed core.version as its own app-release lineage; it no
    // longer tracks the inherited core version (which biffo.core.json records as
    // 0.1.0). Deleting it would destroy real data.
    writeFileSync(join(instance, 'core.version'), '4.7.2\n')

    const { createPullRequest } = await apply()

    expect(existsSync(join(instance, 'core.version'))).toBe(true)
    expect(readFileSync(join(instance, 'core.version'), 'utf8')).toBe('4.7.2\n')
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.not.stringContaining('removed orphaned') }),
    )
  })

  it('keeps a core.version repurposed to a non-semver string', async () => {
    writeFileSync(join(instance, 'core.version'), 'internal-build-42\n')

    await apply()

    expect(existsSync(join(instance, 'core.version'))).toBe(true)
  })

  it('keeps core.version when biffo.core.json is absent (no authority to check)', async () => {
    // Supply the merge base explicitly so the upgrade can still run without
    // biffo.core.json — otherwise the instance version cannot be resolved.
    rmSync(join(instance, 'biffo.core.json'))
    writeFileSync(join(instance, 'core.version'), '0.1.0\n')

    const deps = fakeDeps()
    await runCoreUpgrade(
      {
        cwd: instance,
        templateRepo: theirs,
        baseDir: base,
        theirsDir: theirs,
        toVersion: '0.2.0',
        apply: true,
      },
      deps.deps,
    )

    // No biffo.core.json to compare against — fail closed, keep the file.
    expect(existsSync(join(instance, 'core.version'))).toBe(true)
  })

  it('keeps core.version when biffo.core.json is present but unparseable', async () => {
    writeFileSync(join(instance, 'biffo.core.json'), '{ not valid json')
    writeFileSync(join(instance, 'core.version'), '0.1.0\n')

    // A malformed biffo.core.json throws when read as the instance version, so
    // supply the merge base explicitly to keep the run focused on the cleanup.
    const deps = fakeDeps()
    await expect(
      runCoreUpgrade(
        {
          cwd: instance,
          templateRepo: theirs,
          baseDir: base,
          theirsDir: theirs,
          toVersion: '0.2.0',
          apply: true,
        },
        deps.deps,
      ),
    ).rejects.toThrow()
    // The upgrade aborts on the malformed record before any cleanup — the file
    // is untouched, which is the safe direction.
    expect(existsSync(join(instance, 'core.version'))).toBe(true)
  })

  it('leaves the instance alone when there is no core.version file at all', async () => {
    await apply()
    expect(existsSync(join(instance, 'core.version'))).toBe(false)
    // Nothing was created, and nothing claims a cleanup happened.
    expect(vi.mocked(log.info).mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining('Deleted orphaned'),
    )
  })
})

/**
 * Issue #984: `--apply` created the upgrade branch by checking it out in the
 * caller's own checkout and never moved HEAD back, so the repo it was pointed at
 * was left parked on the upgrade branch — which AGENTS.md §2 forbids, and which
 * silently redirects every other tool reading that checkout.
 *
 * The restore has to hold on the failure paths too. Push and PR creation are the
 * two steps that talk to the network, so they are the ones that actually fail in
 * practice — and they fail *after* the branch has been created, which is exactly
 * when leaving HEAD moved is least recoverable by the caller.
 */
describe('runCoreUpgrade --apply — restores the caller’s branch (#984)', () => {
  let base: string
  let theirs: string
  let instance: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    base = mkdtempSync(join(tmpdir(), 'rb-base-'))
    theirs = mkdtempSync(join(tmpdir(), 'rb-theirs-'))
    instance = mkdtempSync(join(tmpdir(), 'rb-inst-'))
    writeFileSync(join(base, 'core.version'), '0.1.0\n')
    writeFileSync(join(base, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(base, 'services/api/main.py', 'v1')
    writeFileSync(join(theirs, 'core.version'), '0.2.0\n')
    writeFileSync(join(theirs, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(theirs, 'services/api/main.py', 'v2')
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    w(instance, 'services/api/main.py', 'v1')
  })
  afterEach(() => {
    for (const d of [base, theirs, instance]) rmSync(d, { recursive: true, force: true })
  })

  const applyOpts = (): Parameters<typeof runCoreUpgrade>[0] => ({
    cwd: instance,
    templateRepo: theirs,
    baseDir: base,
    theirsDir: theirs,
    apply: true,
  })

  it('switches back to the branch the caller was on after opening the PR', async () => {
    const { deps, git, createPullRequest } = fakeDeps()

    await runCoreUpgrade(applyOpts(), deps)

    expect(createPullRequest).toHaveBeenCalled()
    // The fake reports `main` as the caller's branch; HEAD must end up back
    // there, not on the upgrade branch createBranch switched to.
    expect(git.switchBranch).toHaveBeenCalledWith(instance, 'main')
  })

  it('restores the branch even when the push fails', async () => {
    const { deps, git } = fakeDeps({
      push: vi.fn().mockRejectedValue(new Error('Failed to push branch')),
    })

    await expect(runCoreUpgrade(applyOpts(), deps)).rejects.toThrow(/push/i)

    expect(git.createBranch).toHaveBeenCalled()
    expect(git.switchBranch).toHaveBeenCalledWith(instance, 'main')
  })

  it('restores the branch even when opening the PR fails', async () => {
    const { deps, git } = fakeDeps()
    const failing: CoreUpgradeDeps = {
      ...deps,
      makeGitHub: () => ({
        defaultBranch: vi.fn().mockResolvedValue('dev'),
        createPullRequest: vi.fn().mockRejectedValue(new Error('field: base, code: invalid')),
      }),
    }

    await expect(runCoreUpgrade(applyOpts(), failing)).rejects.toThrow(/invalid/)

    expect(git.switchBranch).toHaveBeenCalledWith(instance, 'main')
  })

  it('does not fail the upgrade when the restore itself fails, but says so', async () => {
    const { deps, git } = fakeDeps({
      switchBranch: vi.fn().mockRejectedValue(new Error('local changes would be overwritten')),
    })

    // The PR was opened; a failed restore is a hygiene problem, not a reason to
    // report the upgrade as failed.
    await expect(runCoreUpgrade(applyOpts(), deps)).resolves.toBeUndefined()

    expect(git.switchBranch).toHaveBeenCalledWith(instance, 'main')
    expect(vi.mocked(log.warn).mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('main'),
    )
  })

  it('never moves HEAD at all when the branch could not be created', async () => {
    const { deps, git } = fakeDeps({
      createBranch: vi.fn().mockRejectedValue(new Error('branch already exists')),
    })

    await expect(runCoreUpgrade(applyOpts(), deps)).rejects.toThrow(/already exists/)

    // HEAD never moved, so there is nothing to restore and no switch to make.
    expect(git.switchBranch).not.toHaveBeenCalled()
  })
})

describe('buildPrBody — global workflow promotion note (issue #328)', () => {
  function emptySummary(): Record<MergeStatus, number> {
    return {
      unchanged: 0,
      'take-theirs': 0,
      'keep-ours': 0,
      merged: 0,
      conflict: 0,
      added: 0,
      'add-conflict': 0,
      removed: 0,
      'remove-conflict': 0,
    }
  }

  function planWith(changes: MergeEntry[]): UpgradePlan {
    const summary = emptySummary()
    for (const c of changes) summary[c.status]++
    return { entries: changes, changes, conflicts: [], summary }
  }

  const noMigrations: MigrationCarryPlan = { entries: [], instanceHead: null, skipped: [] }

  const globalChange: MergeEntry = {
    path: '.github/workflows/deploy-global.yml',
    status: 'merged',
    conflicted: false,
    content: 'x',
  }

  it('adds a promotion note when a global workflow changes and the PR targets a branch other than the dispatch ref', () => {
    // The dispatch ref is `dev` (#559). Targeting anything else (e.g. a
    // leftover `staging`) still leaves the global workflow executing from `dev`
    // until a promotion, so the note fires.
    const body = buildPrBody('0.1.0', '0.2.0', planWith([globalChange]), noMigrations, 'staging')
    expect(body).toContain('Promotion required')
    expect(body).toContain('.github/workflows/deploy-global.yml')
    expect(body).toContain('`staging` → `dev`')
    expect(body).toContain('#328')
  })

  it('omits the note when the PR already targets the dispatch ref (`dev`, nothing to promote)', () => {
    const body = buildPrBody('0.1.0', '0.2.0', planWith([globalChange]), noMigrations, 'dev')
    expect(body).not.toContain('Promotion required')
  })

  it('omits the note when no global workflow is touched', () => {
    const ordinary: MergeEntry = {
      path: 'services/api/main.py',
      status: 'merged',
      conflicted: false,
      content: 'x',
    }
    const body = buildPrBody('0.1.0', '0.2.0', planWith([ordinary]), noMigrations, 'dev')
    expect(body).not.toContain('Promotion required')
  })
})
