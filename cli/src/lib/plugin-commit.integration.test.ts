/**
 * Real-`uv`, real-`git` proof that a plugin commit lands with a current uv.lock (biffo-template#2108).
 *
 * Nothing here mocks `refreshLock`: the failure this guards is "the committed tree fails `uv lock --check`", which only a real
 * uv workspace can observe. The workspace members have no third-party dependencies, so `uv lock` resolves offline.
 *
 * Every case checks the COMMITTED tree (`git worktree add --detach … HEAD`), not the working directory — the reported defect
 * was a clean-looking commit whose lock was rewritten on disk afterwards, so a working-tree check would pass over it.
 */
import { execa } from 'execa'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import { runPluginUninstall } from '../commands/plugin-uninstall.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import { commitPluginChange } from './plugin-commit.js'

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout
}

function writeMember(root: string, name: string): void {
  const dir = join(root, 'services', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'pyproject.toml'),
    `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n`,
  )
  writeFileSync(
    join(dir, 'biffo.plugin.json'),
    JSON.stringify({ name, version: '0.1.0', description: name, tables: [], api_routes: [] }),
  )
}

/** `uv lock --check` on a detached checkout of HEAD; returns the exit code. */
async function lockCheckOnCommittedTree(root: string): Promise<number> {
  const wt = join(makeTmpDir('biffo-lockcheck'), 'tree')
  await git(root, 'worktree', 'add', '--detach', wt, 'HEAD')
  try {
    return (await execa('uv', ['lock', '--check'], { cwd: wt, reject: false })).exitCode ?? -1
  } finally {
    await git(root, 'worktree', 'remove', '--force', wt)
  }
}

describe('plugin commits carry a current uv.lock (#2108)', () => {
  let root: string

  beforeEach(async () => {
    root = makeTmpDir('biffo-uvlock')
    writeFileSync(
      join(root, 'pyproject.toml'),
      `[project]\nname = "inst"\nversion = "0.0.0"\nrequires-python = ">=3.12"\ndependencies = []\n\n` +
        `[tool.uv.workspace]\nmembers = ["services/*"]\n`,
    )
    writeMember(root, 'widgets')
    await git(root, 'init', '--initial-branch=main')
    await git(root, 'config', 'user.email', 'test@example.com')
    await git(root, 'config', 'user.name', 'Biffo Test')
    await execa('uv', ['lock'], { cwd: root })
    await git(root, 'add', '-A')
    await git(root, 'commit', '-m', 'chore: baseline')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('baseline: the fixture commit is itself lock-clean', async () => {
    expect(await lockCheckOnCommittedTree(root)).toBe(0)
  })

  it('control — the old hand-picked add+commit of a new member leaves the committed tree stale', async () => {
    writeMember(root, 'gadgets')
    await new GitAdapter().add(root, ['services/gadgets'])
    await new GitAdapter().commit(root, 'feat(plugins): scaffold gadgets plugin', [
      'services/gadgets',
    ])
    expect(await lockCheckOnCommittedTree(root)).not.toBe(0)
  })

  it('commitPluginChange: adding a member (the `plugin create` shape) commits a current lock', async () => {
    writeMember(root, 'gadgets')
    const staged = await commitPluginChange(
      { git: new GitAdapter(), migrations: new PluginMigrationsAdapter() },
      root,
      ['services/gadgets'],
      'feat(plugins): scaffold gadgets plugin',
    )
    expect(staged).toEqual(['services/gadgets', 'uv.lock'])
    expect(await lockCheckOnCommittedTree(root)).toBe(0)
    expect(await git(root, 'status', '--porcelain')).toBe('')
  })

  it('runPluginUninstall commits a current lock (member removed from the tree and from the lock)', async () => {
    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: true, keepData: false, cwd: root },
      { git: new GitAdapter() },
    )
    expect(await lockCheckOnCommittedTree(root)).toBe(0)
    expect(await git(root, 'status', '--porcelain')).toBe('')
    expect(await git(root, 'show', 'HEAD', '--stat', '--format=')).toContain('uv.lock')
  })

  it('a non-uv checkout (no uv.lock) commits exactly the paths it was given', async () => {
    await git(root, 'rm', '-q', 'uv.lock')
    await git(root, 'commit', '-q', '-m', 'chore: drop lock')
    writeMember(root, 'gadgets')
    const staged = await commitPluginChange(
      { git: new GitAdapter() },
      root,
      ['services/gadgets'],
      'feat(plugins): scaffold gadgets plugin',
    )
    expect(staged).toEqual(['services/gadgets'])
  })

  it('a failing `uv lock` aborts BEFORE anything is committed', async () => {
    writeMember(root, 'gadgets')
    const head = await git(root, 'rev-parse', 'HEAD')
    await expect(
      commitPluginChange(
        {
          git: new GitAdapter(),
          migrations: { refreshLock: () => Promise.reject(new Error('uv lock failed')) },
        },
        root,
        ['services/gadgets'],
        'feat(plugins): scaffold gadgets plugin',
      ),
    ).rejects.toThrow('uv lock failed')
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('')
  })
})
