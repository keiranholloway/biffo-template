import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LOCKFILE_TRIGGERS,
  type RunCommandFn,
  describeFailures,
  lockfilesNeedingRefresh,
  refreshLockfiles,
} from './lockfile-refresh.js'

describe('lockfilesNeedingRefresh', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biffo-lock-'))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(dir, 'uv.lock'), 'version = 1\n')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const names = (paths: string[]) => lockfilesNeedingRefresh(paths, dir).map((t) => t.lockfile)

  it('is empty when no manifest changed', () => {
    expect(names(['services/api/src/api/main.py', 'cli/src/index.ts'])).toEqual([])
  })

  it('picks up a root manifest change', () => {
    expect(names(['package.json'])).toEqual(['pnpm-lock.yaml'])
    expect(names(['pyproject.toml'])).toEqual(['uv.lock'])
  })

  /**
   * The case that broke biffo-platform#2: the upgrade added
   * services/_plugins/agent-runtime as a workspace member, so a *nested*
   * pyproject.toml invalidated the root uv.lock. Matching only the repo root
   * would have missed it.
   */
  it('picks up a nested workspace member, which the root lockfile also locks', () => {
    expect(names(['services/_plugins/agent-runtime/pyproject.toml'])).toEqual(['uv.lock'])
    expect(names(['cli/package.json'])).toEqual(['pnpm-lock.yaml'])
  })

  /**
   * The reopened half of #393, and the exact pair of paths that fired it on
   * tabsii-platform 0.50.2 -> 0.53.0.
   *
   * `_skeletons/` is scaffolding source: those manifests describe the tree
   * `biffo sibling create` copies into a NEW repo, and are deliberately not
   * pnpm/uv workspace members here. Nothing in this repo's lockfiles resolves
   * them, so changing them cannot invalidate either — but the matcher only
   * looked at the filename, so it announced a refresh that had nothing to do.
   *
   * This is the distinction the previous suite could not make: the nested
   * workspace-member case above and this one are both nested manifests, and
   * only one of them is locked here. Both assertions must hold at once.
   */
  it('ignores a manifest under _skeletons/, which no lockfile here resolves', () => {
    expect(
      names([
        '_skeletons/sibling-template/apps/frontend/package.json',
        '_skeletons/sibling-template/services/api/pyproject.toml',
        '_skeletons/plugin-template/pyproject.toml',
      ]),
    ).toEqual([])
  })

  it('still refreshes when a real workspace member changes alongside a skeleton', () => {
    // The skeleton must not *suppress* a genuine trigger either — the exclusion
    // narrows which paths count, it does not veto the run.
    expect(
      names([
        '_skeletons/sibling-template/apps/frontend/package.json',
        'services/_plugins/agent-runtime/pyproject.toml',
      ]),
    ).toEqual(['uv.lock'])
  })

  it('handles both ecosystems changing at once', () => {
    expect(names(['package.json', 'services/api/pyproject.toml']).sort()).toEqual([
      'pnpm-lock.yaml',
      'uv.lock',
    ])
  })

  /**
   * A lockfile the instance does not have is not created. Its absence means
   * that ecosystem is not locked here, and inventing one is a bigger change
   * than an upgrade is entitled to make.
   */
  it('does not create a lockfile the instance does not have', () => {
    rmSync(join(dir, 'uv.lock'))
    expect(names(['pyproject.toml', 'package.json'])).toEqual(['pnpm-lock.yaml'])
  })

  it('does not match a file that merely ends in the manifest name', () => {
    // `my-package.json` is not `package.json`.
    expect(names(['docs/my-package.json', 'tools/notpyproject.toml'])).toEqual([])
  })

  it('regenerates the lockfile without installing packages', () => {
    // Resolving is all the upgrade needs, and it cannot run a dependency's
    // install scripts on the machine doing the upgrade.
    const pnpm = LOCKFILE_TRIGGERS.find((t) => t.ecosystem === 'pnpm')
    expect(pnpm?.command).toContain('--lockfile-only')
    expect(LOCKFILE_TRIGGERS.find((t) => t.ecosystem === 'uv')?.command).toEqual(['uv', 'lock'])
  })
})

describe('refreshLockfiles', () => {
  const ok: RunCommandFn = async () => ({ ok: true })

  it('runs each trigger in the instance directory', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = []
    const spy: RunCommandFn = async (command, cwd) => {
      calls.push({ command, cwd })
      return { ok: true }
    }
    const outcomes = await refreshLockfiles('/repo', LOCKFILE_TRIGGERS, spy)

    expect(outcomes.every((o) => o.ok)).toBe(true)
    // In the INSTANCE, so its registry config and platform decide the result.
    expect(calls.map((c) => c.cwd)).toEqual(['/repo', '/repo'])
    expect(calls[0]?.command).toEqual(['pnpm', 'install', '--lockfile-only'])
  })

  /**
   * One missing toolchain must not hide the other's result — a machine with uv
   * but no pnpm should still get its uv.lock refreshed, and be told about pnpm.
   */
  it('continues past a failure rather than stopping at the first', async () => {
    const failsPnpm: RunCommandFn = async (command) =>
      command[0] === 'pnpm' ? { ok: false, error: 'pnpm: not found' } : { ok: true }

    const outcomes = await refreshLockfiles('/repo', LOCKFILE_TRIGGERS, failsPnpm)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]?.ok).toBe(false)
    expect(outcomes[1]?.ok).toBe(true)
  })

  it('does nothing when nothing needs refreshing', async () => {
    expect(await refreshLockfiles('/repo', [], ok)).toEqual([])
  })
})

describe('describeFailures', () => {
  it('says nothing when everything succeeded', async () => {
    const outcomes = await refreshLockfiles('/repo', LOCKFILE_TRIGGERS, async () => ({ ok: true }))
    expect(describeFailures(outcomes)).toEqual([])
  })

  /**
   * The message has to be actionable on its own: a PR that is red because a
   * lockfile could not be regenerated is only recoverable if the reader is told
   * which command to run.
   */
  it('names the lockfile, the reason, and the exact command to run', async () => {
    const outcomes = await refreshLockfiles('/repo', LOCKFILE_TRIGGERS, async (command) =>
      command[0] === 'uv' ? { ok: false, error: 'uv: not found' } : { ok: true },
    )
    const [message, ...rest] = describeFailures(outcomes)
    expect(rest).toEqual([])
    expect(message).toContain('uv.lock')
    expect(message).toContain('uv: not found')
    expect(message).toContain('`uv lock`')
    expect(message).toContain('pyproject.toml')
  })
})

describe('the real template repo', () => {
  /**
   * Drift guard: the triggers name real files. A typo here disables the refresh
   * silently, and the symptom is a red instance PR nobody can trace back.
   */
  it('names manifests and lockfiles that actually exist', () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    const scratch = mkdtempSync(join(tmpdir(), 'biffo-lock-real-'))
    try {
      // Copy just the lockfile names across so existsSync sees them.
      for (const t of LOCKFILE_TRIGGERS) {
        expect(
          lockfilesNeedingRefresh([t.manifest], repoRoot, [t]).length,
          `${t.lockfile} is missing from the template root`,
        ).toBe(1)
      }
      mkdirSync(scratch, { recursive: true })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  /**
   * Drift guard for the exclusion: `_skeletons/` really does hold manifests
   * (so the test above is not vacuous), and the workspace globs really do
   * leave them out — which is why no lockfile here resolves them. If a
   * skeleton ever becomes a workspace member, this fails and the exclusion
   * must be revisited rather than quietly hiding a real trigger.
   */
  it('excludes the skeleton manifests that exist, and they are not workspace members', () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    const skeletonManifests = globSync('_skeletons/**/{package.json,pyproject.toml}', {
      cwd: repoRoot,
    })
    expect(skeletonManifests.length, '_skeletons/ has no manifests to exclude').toBeGreaterThan(0)
    expect(lockfilesNeedingRefresh(skeletonManifests, repoRoot)).toEqual([])

    const pnpmWorkspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    expect(pnpmWorkspace).not.toContain('_skeletons')
    const rootPyproject = readFileSync(join(repoRoot, 'pyproject.toml'), 'utf8')
    const uvMembers = /members\s*=\s*\[(.*?)\]/s.exec(rootPyproject)?.[1] ?? ''
    expect(uvMembers).not.toContain('_skeletons')
  })
})
