/**
 * Issue #984, reproduced against real git rather than a fake.
 *
 * The reported failure is a property of the *checkout*, not of the call graph:
 * after `biffo core upgrade --apply`, the repo it was pointed at was left with
 * HEAD on `biffo/core-upgrade-…`. A test that only asserts which adapter method
 * was called cannot see that, so this tier drives the real `GitAdapter` against
 * a real repository and asks git itself where HEAD is afterwards.
 *
 * It exercises the failure path deliberately. The upgrade runs to completion —
 * branch created, files applied, commit made, push landed on a real bare remote
 * — and then dies where a local remote cannot be parsed as `owner/repo`. That is
 * the same shape as the failures that actually happen in the field (a rejected
 * push, a GitHub API error), and it is the case where leaving HEAD moved is
 * worst: the caller has an error in front of them and no reason to suspect their
 * checkout also changed underneath.
 */
import { execa } from 'execa'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import type { CoreUpgradeDeps } from './core-upgrade.js'
import { runCoreUpgrade } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

const MANIFEST = { version: 1, templateOwned: ['services/api/'], userOwned: ['services/'] }

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd })
  return stdout.trim()
}

describe('runCoreUpgrade --apply — HEAD in a real checkout (#984)', () => {
  let base: string
  let theirs: string
  let instance: string
  let remote: string

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    base = makeTmpDir('ci-base')
    theirs = makeTmpDir('ci-theirs')
    instance = makeTmpDir('ci-inst')
    remote = makeTmpDir('ci-remote')

    // Merge base @ 0.1.0 and target @ 0.2.0, as loose trees — no tags needed.
    writeFileSync(join(base, 'core.version'), '0.1.0\n')
    writeFileSync(join(base, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(base, 'services/api/main.py', 'v1')
    writeFileSync(join(theirs, 'core.version'), '0.2.0\n')
    writeFileSync(join(theirs, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(theirs, 'services/api/main.py', 'v2')

    // The instance is a real repo on `dev`, with a real remote to push to.
    await execa('git', ['init', '--bare', '--initial-branch=dev'], { cwd: remote })
    await git(instance, 'init', '--initial-branch=dev')
    await git(instance, 'config', 'user.email', 'test@example.com')
    await git(instance, 'config', 'user.name', 'Biffo Test')
    await git(instance, 'remote', 'add', 'origin', remote)
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    w(instance, 'services/api/main.py', 'v1')
    await git(instance, 'add', '-A')
    await git(instance, 'commit', '-m', 'initial')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of [base, theirs, instance, remote]) rmSync(d, { recursive: true, force: true })
  })

  function realGitDeps(): CoreUpgradeDeps {
    return {
      git: new GitAdapter(),
      // Never reached: the run dies parsing the local remote as owner/repo.
      makeGitHub: () => {
        throw new Error('makeGitHub should not be reached in this test')
      },
      resolveToken: () => 'TOKEN',
      workingTreeMatchesTag: () => true,
    }
  }

  it('leaves the checkout on the branch it started on when the run fails late', async () => {
    expect(await git(instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev')

    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
        realGitDeps(),
      ),
    ).rejects.toThrow(/Could not parse a GitHub owner\/repo/)

    // The observable symptom of #984: git's own answer, in the caller's repo.
    expect(await git(instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev')

    // ...and the restore did not throw the upgrade's work away. The branch still
    // exists locally with the upgrade commit on it, and the push still landed —
    // a "restore" that also reverted the work would be a worse bug than the one
    // being fixed.
    const upgradeBranch = 'biffo/core-upgrade-0.1.0-to-0.2.0'
    expect(await git(instance, 'rev-parse', '--verify', upgradeBranch)).toMatch(/^[0-9a-f]{40}$/)
    expect(await git(instance, 'show', `${upgradeBranch}:services/api/main.py`)).toBe('v2')
    expect(await git(remote, 'rev-parse', '--verify', upgradeBranch)).toMatch(/^[0-9a-f]{40}$/)

    // `dev` itself is untouched — the upgrade is on its branch, not on the
    // caller's integration branch.
    expect(await git(instance, 'show', 'dev:services/api/main.py')).toBe('v1')
  })
})

/**
 * Issue #1137, reproduced against real git.
 *
 * `applyUpgradePlan` writes the merged files and `git add -A` stages them
 * BEFORE `git commit` is attempted, so a commit that fails — in the field,
 * the ownership guard's commit-msg hook correctly refusing a conflicted,
 * `--allow-conflicts` merge — leaves the working tree dirty with the merge
 * still in it, and the freshly-created upgrade branch is still bit-identical
 * to `dev` (no commit has landed on it yet). `git switch dev` in that state
 * does not refuse: nothing conflicts with an identical tree, so it silently
 * carries the staged, conflict-marked merge onto `dev` — parking template-
 * owned, conflict-marked changes on the integration branch one `git commit`
 * away from landing there directly, which is exactly what AGENTS.md §2
 * forbids and #984's restore was never tested against.
 *
 * This subclasses the real `GitAdapter` and overrides only `commit` to fail
 * without touching git — `add` still runs for real, so the working tree is
 * genuinely staged and dirty exactly as it would be after a real hook
 * rejection, and `hasUncommittedChanges` answers from the real repository
 * rather than a fake.
 */
describe('runCoreUpgrade --apply — a failed commit does not land on the caller’s branch (#1137)', () => {
  let base: string
  let theirs: string
  let instance: string
  let remote: string

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    base = makeTmpDir('cf-base')
    theirs = makeTmpDir('cf-theirs')
    instance = makeTmpDir('cf-inst')
    remote = makeTmpDir('cf-remote')

    writeFileSync(join(base, 'core.version'), '0.1.0\n')
    writeFileSync(join(base, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(base, 'services/api/main.py', 'v1')
    writeFileSync(join(theirs, 'core.version'), '0.2.0\n')
    writeFileSync(join(theirs, 'core-manifest.json'), JSON.stringify(MANIFEST))
    w(theirs, 'services/api/main.py', 'v2 <<<<<<< conflict-shaped>>>>>>>')

    await execa('git', ['init', '--bare', '--initial-branch=dev'], { cwd: remote })
    await git(instance, 'init', '--initial-branch=dev')
    await git(instance, 'config', 'user.email', 'test@example.com')
    await git(instance, 'config', 'user.name', 'Biffo Test')
    await git(instance, 'remote', 'add', 'origin', remote)
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    w(instance, 'services/api/main.py', 'v1')
    await git(instance, 'add', '-A')
    await git(instance, 'commit', '-m', 'initial')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of [base, theirs, instance, remote]) rmSync(d, { recursive: true, force: true })
  })

  /** The real GitAdapter, with `commit` replaced by a failure that never
   * touches git — standing in for the ownership guard's commit-msg hook
   * refusing, without needing husky wired up in a throwaway repo. */
  class FailingCommitGitAdapter extends GitAdapter {
    override async commit(): Promise<void> {
      throw new Error('core ownership guard: refused — template-owned paths changed (simulated)')
    }
  }

  function realGitDepsWithFailingCommit(): CoreUpgradeDeps {
    return {
      git: new FailingCommitGitAdapter(),
      makeGitHub: () => {
        throw new Error('makeGitHub should not be reached in this test')
      },
      resolveToken: () => 'TOKEN',
      workingTreeMatchesTag: () => true,
    }
  }

  it('leaves the dirty merge on the upgrade branch instead of carrying it onto dev', async () => {
    expect(await git(instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev')

    await expect(
      runCoreUpgrade(
        { cwd: instance, templateRepo: theirs, baseDir: base, theirsDir: theirs, apply: true },
        realGitDepsWithFailingCommit(),
      ),
    ).rejects.toThrow(/ownership guard/)

    const upgradeBranch = 'biffo/core-upgrade-0.1.0-to-0.2.0'

    // The whole point: HEAD did NOT go back to dev. Before #1137's fix, this
    // would be 'dev' — `git switch dev` succeeds trivially here because the
    // upgrade branch's tip is still identical to dev's, so nothing about the
    // switch looks unsafe to git even though the dirty content is a
    // conflict-shaped merge nobody has reviewed.
    expect(await git(instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(upgradeBranch)

    // dev's own committed content is untouched.
    expect(await git(instance, 'show', 'dev:services/api/main.py')).toBe('v1')

    // The merge is still staged, right where the failed commit left it — nobody
    // lost work, it just never got attributed to the wrong branch.
    const status = await git(instance, 'status', '--porcelain')
    expect(status).toContain('services/api/main.py')
  })
})
