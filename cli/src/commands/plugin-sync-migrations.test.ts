import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPluginSyncMigrations } from './plugin-sync-migrations.js'
import { makeTmpDir } from '../test-utils/tmp.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeProjectRoot(): string {
  const dir = makeTmpDir('biffo-project')
  mkdirSync(join(dir, 'services'), { recursive: true })
  return dir
}

function installPlugin(projectRoot: string, name: string): void {
  const dir = join(projectRoot, 'services', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'biffo.plugin.json'),
    JSON.stringify({ name, version: '1.0.0', tables: [{ name: `${name}_items` }] }),
  )
}

function makeMigrationsMock(generatedPaths: string[] = []) {
  return { generate: vi.fn().mockResolvedValue(generatedPaths) }
}

function makeGitMock(isRepo = true) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(isRepo),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runPluginSyncMigrations', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects when cwd has no services/ directory', async () => {
    const notAProject = makeTmpDir('not-a-biffo-project')
    const migrations = makeMigrationsMock()
    const git = makeGitMock()

    try {
      await expect(
        runPluginSyncMigrations(
          undefined,
          { dryRun: false, commit: true, cwd: notAProject },
          { migrations: migrations as never, git: git as never },
        ),
      ).rejects.toThrow('does not exist')
    } finally {
      rmSync(notAProject, { recursive: true, force: true })
    }
  })

  it('rejects a named plugin that is not installed', async () => {
    const migrations = makeMigrationsMock()
    const git = makeGitMock()

    await expect(
      runPluginSyncMigrations(
        'not-installed',
        { dryRun: false, commit: true, cwd: projectRoot },
        { migrations: migrations as never, git: git as never },
      ),
    ).rejects.toThrow('not installed at services/not-installed/')

    expect(migrations.generate).not.toHaveBeenCalled()
  })

  it('generates and commits a migration for a named installed plugin', async () => {
    installPlugin(projectRoot, 'rbac')
    const generatedPath = join(
      projectRoot,
      'services',
      'api',
      'migrations',
      'versions',
      'abc123_add_rbac_roles_table.py',
    )
    const migrations = makeMigrationsMock([generatedPath])
    const git = makeGitMock()

    await runPluginSyncMigrations(
      'rbac',
      { dryRun: false, commit: true, cwd: projectRoot },
      { migrations: migrations as never, git: git as never },
    )

    expect(migrations.generate).toHaveBeenCalledWith(projectRoot, ['rbac'])
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      join('services', 'api', 'migrations', 'versions', 'abc123_add_rbac_roles_table.py'),
    ])
    expect(git.commit).toHaveBeenCalledWith(
      projectRoot,
      'chore(plugins): sync migration(s) for rbac',
    )
  })

  it('generates for every installed plugin when no name is given', async () => {
    installPlugin(projectRoot, 'rbac')
    installPlugin(projectRoot, 'billing')
    const migrations = makeMigrationsMock([
      join(projectRoot, 'services', 'api', 'migrations', 'versions', 'a.py'),
    ])
    const git = makeGitMock()

    await runPluginSyncMigrations(
      undefined,
      { dryRun: false, commit: true, cwd: projectRoot },
      { migrations: migrations as never, git: git as never },
    )

    expect(migrations.generate).toHaveBeenCalledWith(projectRoot, undefined)
  })

  it('warns and does not attempt to commit when nothing was generated', async () => {
    installPlugin(projectRoot, 'rbac')
    const migrations = makeMigrationsMock([])
    const git = makeGitMock()

    await runPluginSyncMigrations(
      'rbac',
      { dryRun: false, commit: true, cwd: projectRoot },
      { migrations: migrations as never, git: git as never },
    )

    expect(git.isGitRepo).not.toHaveBeenCalled()
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('--dry-run does not call migrations.generate at all', async () => {
    installPlugin(projectRoot, 'rbac')
    const migrations = makeMigrationsMock()
    const git = makeGitMock()

    await runPluginSyncMigrations(
      'rbac',
      { dryRun: true, commit: true, cwd: projectRoot },
      { migrations: migrations as never, git: git as never },
    )

    expect(migrations.generate).not.toHaveBeenCalled()
  })

  it('--no-commit generates and stages nothing further, without committing', async () => {
    installPlugin(projectRoot, 'rbac')
    const generatedPath = join(
      projectRoot,
      'services',
      'api',
      'migrations',
      'versions',
      'abc123_add_rbac_roles_table.py',
    )
    const migrations = makeMigrationsMock([generatedPath])
    const git = makeGitMock()

    await runPluginSyncMigrations(
      'rbac',
      { dryRun: false, commit: false, cwd: projectRoot },
      { migrations: migrations as never, git: git as never },
    )

    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('rejects when cwd is not a git repository and something was generated', async () => {
    installPlugin(projectRoot, 'rbac')
    const generatedPath = join(
      projectRoot,
      'services',
      'api',
      'migrations',
      'versions',
      'abc123_add_rbac_roles_table.py',
    )
    const migrations = makeMigrationsMock([generatedPath])
    const git = makeGitMock(false)

    await expect(
      runPluginSyncMigrations(
        'rbac',
        { dryRun: false, commit: true, cwd: projectRoot },
        { migrations: migrations as never, git: git as never },
      ),
    ).rejects.toThrow('is not a git repository')
  })
})
