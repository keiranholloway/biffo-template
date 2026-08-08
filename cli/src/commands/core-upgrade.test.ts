import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreUpgradeDeps } from './core-upgrade.js'
import { buildPrBody, resolveTemplateRepoFlag, runCoreUpgrade } from './core-upgrade.js'
import type { MergeEntry, MergeStatus, UpgradePlan } from '../lib/core-upgrade.js'
import type { MigrationCarryPlan } from '../lib/core-migrations.js'
import { makeTmpDir } from '../test-utils/tmp.js'

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
  // Mocked so `applyAndOpenPr`'s unconditional dependency-install step (#1040)
  // never falls through to `defaultRunCommand` here and shells out to a real
  // `pnpm install` / `uv sync` against a throwaway tmp dir with no
  // package.json. Tests that care what it was called with build their own
  // `runCommand` and override this — see the lockfile-refresh describe block.
  const runCommand = vi.fn().mockResolvedValue({ ok: true })
  const deps: CoreUpgradeDeps = {
    git,
    makeGitHub: () => ({ createPullRequest, defaultBranch }),
    resolveToken: () => 'TOKEN',
    // Default: the template checkout faithfully matches the target tag, so the
    // working-tree fast path is taken. Tests that exercise a drifted checkout
    // (#471) override this to false.
    workingTreeMatchesTag: () => true,
    runCommand,
  }
  return { deps, git, createPullRequest, defaultBranch, runCommand }
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
    base = makeTmpDir('base')
    theirs = makeTmpDir('theirs')
    instance = makeTmpDir('inst')
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

  it('embeds the carried-PR marker in the COMMIT message, not only the PR body (#1011)', async () => {
    // `--apply` can commit and then fail at the push step (e.g. the pre-push
    // gate rejecting a tree it cannot verify, #1040), aborting before the PR
    // is ever opened. The
    // operator then pushes and opens the PR by hand, and a hand-made PR never
    // gets the marker `buildPrBody` writes into the PR body. The commit made
    // here, before that failing push, is the one place guaranteed to survive —
    // so it must carry the same marker.
    const { deps, git } = fakeDeps()

    // Give `theirs` real template history to read: two tags with one squash
    // commit between them, the shape `readCarriedPrs` parses.
    execFileSync('git', ['init'], { cwd: theirs })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: theirs })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: theirs })
    execFileSync('git', ['add', '-A'], { cwd: theirs })
    execFileSync('git', ['commit', '-m', 'chore: base'], { cwd: theirs })
    execFileSync('git', ['tag', 'core-v0.1.0'], { cwd: theirs })
    w(theirs, 'services/api/note.py', 'note')
    execFileSync('git', ['add', '-A'], { cwd: theirs })
    execFileSync('git', ['commit', '-m', 'feat(api): add a note (#42)'], { cwd: theirs })
    execFileSync('git', ['tag', 'core-v0.2.0'], { cwd: theirs })

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps,
    )

    expect(git.commit).toHaveBeenCalledWith(
      instance,
      expect.stringContaining('<!-- biffo:carries-template-prs:42 -->'),
    )
  })

  /**
   * Issue #1040. `applyAndOpenPr` used to go straight from writing files to
   * `git push` with no install in between, so `.husky/pre-push`'s
   * `scripts/verify.sh` rejected the push against a tree with no
   * `node_modules` — every worktree AGENTS.md §1 tells a caller to run this
   * in. `pnpm install` must run, and run BEFORE the push, not after.
   */
  it('installs dependencies before pushing (#1040)', async () => {
    const { deps, git, runCommand } = fakeDeps()

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps,
    )

    expect(runCommand).toHaveBeenCalledWith(['pnpm', 'install'], instance)
    const pnpmCall = runCommand.mock.calls.findIndex(
      (c) => c[0][0] === 'pnpm' && c[0][1] === 'install' && c[0].length === 2,
    )
    expect(pnpmCall).toBeGreaterThanOrEqual(0)
    // Before the push, not after — an install that ran too late would not have
    // helped the pre-push gate at all.
    expect(runCommand.mock.invocationCallOrder[pnpmCall]).toBeLessThan(
      git.push.mock.invocationCallOrder[0],
    )
  })

  it('also runs uv sync before pushing when the instance has a root pyproject.toml (#1040)', async () => {
    writeFileSync(join(instance, 'pyproject.toml'), '[project]\nname = "inst"\n')
    const { deps, git, runCommand } = fakeDeps()

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps,
    )

    expect(runCommand).toHaveBeenCalledWith(['uv', 'sync'], instance)
    const uvCall = runCommand.mock.calls.findIndex((c) => c[0][0] === 'uv' && c[0][1] === 'sync')
    expect(runCommand.mock.invocationCallOrder[uvCall]).toBeLessThan(
      git.push.mock.invocationCallOrder[0],
    )
  })

  it('does not invent a uv sync step when the instance has no Python at all (#1040)', async () => {
    const { deps, runCommand } = fakeDeps()

    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps,
    )

    expect(runCommand).not.toHaveBeenCalledWith(['uv', 'sync'], instance)
  })

  /**
   * Issue #1040's secondary fix. The marker is already inside the commit
   * message (#1011, asserted above) — but a human finishing a failed push by
   * hand pastes a PR BODY, not a commit message, and has no reason to go
   * looking in `git log` for it. A failed push must print the marker it would
   * have emitted, explicitly, so finishing by hand does not silently lose it.
   */
  it('prints the carried-PRs marker when the push fails (#1040)', async () => {
    // Same real template history as the commit-message test above: two tags,
    // one squash commit ending `(#42)` between them.
    execFileSync('git', ['init'], { cwd: theirs })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: theirs })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: theirs })
    execFileSync('git', ['add', '-A'], { cwd: theirs })
    execFileSync('git', ['commit', '-m', 'chore: base'], { cwd: theirs })
    execFileSync('git', ['tag', 'core-v0.1.0'], { cwd: theirs })
    w(theirs, 'services/api/note.py', 'note')
    execFileSync('git', ['add', '-A'], { cwd: theirs })
    execFileSync('git', ['commit', '-m', 'feat(api): add a note (#42)'], { cwd: theirs })
    execFileSync('git', ['tag', 'core-v0.2.0'], { cwd: theirs })

    const { deps } = fakeDeps({
      push: vi.fn().mockRejectedValue(new Error('Failed to push branch')),
    })

    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
        deps,
      ),
    ).rejects.toThrow(/push/i)

    const errors = vi.mocked(log.error).mock.calls.map((c) => String(c[0]))
    expect(errors.some((m) => m.includes('Push failed'))).toBe(true)
    expect(errors.some((m) => m.includes('<!-- biffo:carries-template-prs:42 -->'))).toBe(true)
  })

  it('says plainly there is no marker to lose when the failed push carries no template PRs (#1040)', async () => {
    // No templateRepo git history set up — readCarriedPrs cannot read one, so
    // carriedPrs is [] (best-effort by design). The failure message must not
    // claim a marker exists when there is nothing to carry.
    const { deps } = fakeDeps({
      push: vi.fn().mockRejectedValue(new Error('Failed to push branch')),
    })

    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
        deps,
      ),
    ).rejects.toThrow(/push/i)

    const errors = vi.mocked(log.error).mock.calls.map((c) => String(c[0]))
    expect(errors.some((m) => m.includes('carries no template PRs'))).toBe(true)
    expect(errors.some((m) => m.includes('biffo:carries-template-prs'))).toBe(false)
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
    const taggedTarget = makeTmpDir('tagged')
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
    base = makeTmpDir('lock-base')
    theirs = makeTmpDir('lock-theirs')
    instance = makeTmpDir('lock-inst')
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

    // The `--lockfile-only` regeneration is what this test is about, and it
    // must not fire. `installInstanceDependencies` (#1040) shares the same
    // `runCommand` fn but always runs a plain `pnpm install` regardless of
    // what this upgrade touched, so `runCommand` itself is no longer a
    // reliable "nothing happened" signal — assert on the specific command.
    expect(runCommand).not.toHaveBeenCalledWith(['pnpm', 'install', '--lockfile-only'], instance)
    expect(runCommand).not.toHaveBeenCalledWith(['uv', 'lock'], instance)
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
    base = makeTmpDir('cv-base')
    theirs = makeTmpDir('cv-theirs')
    instance = makeTmpDir('cv-inst')
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

describe('runCoreUpgrade — new instance seam warning (#1188)', () => {
  let base: string
  let theirs: string
  let instance: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    base = makeTmpDir('seam-base')
    theirs = makeTmpDir('seam-theirs')
    instance = makeTmpDir('seam-inst')
    // Something outside apps/portal/ also changes, so the upgrade is never a
    // no-op regardless of what the seam check finds.
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

  function tsconfig(paths: Record<string, string[]>): string {
    return JSON.stringify({ compilerOptions: { baseUrl: '.', paths } })
  }

  async function apply(): Promise<ReturnType<typeof fakeDeps>> {
    const deps = fakeDeps()
    await runCoreUpgrade(
      { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
      deps.deps,
    )
    return deps
  }

  it('warns in the terminal and the PR body when a new seam has no instance declaration', async () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    w(
      theirs,
      'apps/portal/tsconfig.json',
      tsconfig({ '@/instance-login-destinations': ['./src/lib/login-destinations-default.ts'] }),
    )
    // instance never adds src/instance-login-destinations.ts

    const { createPullRequest } = await apply()

    const terminalOutput = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
    expect(terminalOutput).toContain('#1188')
    expect(terminalOutput).toContain('apps/portal/src/instance-login-destinations.ts')
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('apps/portal/src/instance-login-destinations.ts'),
      }),
    )
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('#1188') }),
    )
  })

  it('does not warn when the instance already declares the new seam', async () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    w(
      theirs,
      'apps/portal/tsconfig.json',
      tsconfig({ '@/instance-login-destinations': ['./src/lib/login-destinations-default.ts'] }),
    )
    w(instance, 'apps/portal/src/instance-login-destinations.ts', 'export const x = 1\n')

    const { createPullRequest } = await apply()

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.not.stringContaining('#1188') }),
    )
  })

  it('is unaffected when the upgrade carries no seam changes at all', async () => {
    const paths = { '@/instance-nav': ['./src/lib/instance-nav-empty.ts'] }
    w(base, 'apps/portal/tsconfig.json', tsconfig(paths))
    w(theirs, 'apps/portal/tsconfig.json', tsconfig(paths))
    // instance never declared @/instance-nav either — irrelevant, it is not new.

    const { createPullRequest } = await apply()

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.not.stringContaining('#1188') }),
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
    base = makeTmpDir('rb-base')
    theirs = makeTmpDir('rb-theirs')
    instance = makeTmpDir('rb-inst')
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

  /**
   * Issue #1137. `applyUpgradePlan` + `git add -A` run and stage the merge
   * BEFORE `git commit` is attempted, so a commit that fails for any reason —
   * most commonly the ownership guard correctly refusing a conflicted,
   * `--allow-conflicts` commit — leaves the working tree dirty with the merge
   * still in it. At that point the upgrade branch's tip is bit-identical to
   * `callerBranch`'s (no commit ever landed on it), so `switchBranch`'s own
   * git-level protection does not fire: switching back would succeed and
   * silently carry the staged, conflict-marked merge onto the caller's branch
   * — exactly the "conflicted core upgrade lands on dev" report in #1137.
   *
   * `hasUncommittedChanges` returning `true` is how this is simulated here: a
   * fake can't reproduce git's "identical tip" behaviour directly (see
   * `core-upgrade.integration.test.ts` for that, against real git), but it can
   * assert the caller-branch code path never even attempts the unsafe switch
   * once it knows the tree is dirty.
   */
  it('does not switch back when the commit fails and leaves the tree dirty (#1137)', async () => {
    const { deps, git } = fakeDeps({
      commit: vi.fn().mockRejectedValue(new Error('core ownership guard: refused (conflicted)')),
      // First call is `checkInstanceCurrency`'s pre-flight check, before
      // anything has run — clean, so the upgrade proceeds. Every call after
      // that is `restoreCallerBranch`'s, once the failed commit has left the
      // merge staged but uncommitted.
      hasUncommittedChanges: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    })

    await expect(runCoreUpgrade(applyOpts(), deps)).rejects.toThrow(/ownership guard/)

    // The unsafe switch never happens — HEAD stays on the upgrade branch,
    // where the dirty state actually belongs.
    expect(git.switchBranch).not.toHaveBeenCalled()
    expect(vi.mocked(log.warn).mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('uncommitted changes'),
    )
  })

  it('still restores normally when a later step fails but nothing is left uncommitted', async () => {
    // Sanity check that #1137's guard is conditional, not a regression of
    // #984: a failure AFTER a successful commit (push, PR) leaves a clean
    // tree, and the existing restore-on-failure behaviour above must still
    // hold for that case.
    const { deps, git } = fakeDeps({
      push: vi.fn().mockRejectedValue(new Error('Failed to push branch')),
      hasUncommittedChanges: vi.fn().mockResolvedValue(false),
    })

    await expect(runCoreUpgrade(applyOpts(), deps)).rejects.toThrow(/push/i)

    expect(git.switchBranch).toHaveBeenCalledWith(instance, 'main')
  })

  it('fails closed (does not switch) when it cannot even tell whether the tree is dirty', async () => {
    const { deps, git } = fakeDeps({
      commit: vi.fn().mockRejectedValue(new Error('core ownership guard: refused (conflicted)')),
      // Clean on the pre-flight check, then unanswerable once
      // `restoreCallerBranch` asks after the commit has failed.
      hasUncommittedChanges: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockRejectedValue(new Error('git status failed')),
    })

    await expect(runCoreUpgrade(applyOpts(), deps)).rejects.toThrow(/ownership guard/)

    // An unanswerable "is it dirty?" is treated the same as "yes" — never as
    // "no, safe to switch".
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

describe('buildPrBody — new instance seams (#1188)', () => {
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

  const tsconfigChange: MergeEntry = {
    path: 'apps/portal/tsconfig.json',
    status: 'merged',
    conflicted: false,
    content: '{}',
  }

  const seam = {
    specifier: '@/instance-login-destinations',
    instanceFile: 'apps/portal/src/instance-login-destinations.ts',
    defaultFile: 'apps/portal/src/lib/login-destinations-default.ts',
  }

  it('names the file the instance must add and the default that applies until then', () => {
    const body = buildPrBody(
      '0.1.0',
      '0.2.0',
      planWith([tsconfigChange]),
      noMigrations,
      'dev',
      [],
      [],
      null,
      [],
      [seam],
    )
    expect(body).toContain('#1188')
    expect(body).toContain('@/instance-login-destinations')
    expect(body).toContain('apps/portal/src/instance-login-destinations.ts')
    expect(body).toContain('apps/portal/src/lib/login-destinations-default.ts')
  })

  it('omits the section entirely when no new seam is introduced', () => {
    const body = buildPrBody(
      '0.1.0',
      '0.2.0',
      planWith([tsconfigChange]),
      noMigrations,
      'dev',
      [],
      [],
      null,
      [],
      [],
    )
    expect(body).not.toContain('#1188')
    expect(body).not.toContain('instance seam')
  })
})

describe('resolveTemplateRepoFlag — --template as an alias for --template-repo (#1138)', () => {
  it('returns the canonical --template-repo value when only it is given', () => {
    expect(resolveTemplateRepoFlag('/path/to/template', undefined)).toBe('/path/to/template')
  })

  it('returns the --template alias value when only it is given', () => {
    expect(resolveTemplateRepoFlag(undefined, '/path/to/template')).toBe('/path/to/template')
  })

  it('returns undefined when neither is given', () => {
    expect(resolveTemplateRepoFlag(undefined, undefined)).toBeUndefined()
  })

  it('accepts both when they resolve to the same path', () => {
    expect(resolveTemplateRepoFlag('/a/b', '/a/b')).toBe('/a/b')
  })

  it('accepts both when they resolve to the same path via different spellings, returning --template-repo’s spelling', () => {
    // Normalization happens later, in the caller's resolve() — this just has
    // to not throw, and it returns the canonical flag's value verbatim rather
    // than silently rewriting what the user typed.
    expect(resolveTemplateRepoFlag('/a/b/../b', '/a/b')).toBe('/a/b/../b')
  })

  it('throws when both are given with different paths, naming both values', () => {
    expect(() => resolveTemplateRepoFlag('/a', '/b')).toThrow(
      /--template-repo.*\/a.*--template.*\/b/s,
    )
  })
})
