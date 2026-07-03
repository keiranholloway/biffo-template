import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryPluginEntry } from '../adapters/registry/index.js'
import { runPluginInstall } from './plugin-install.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const VALID_MANIFEST = {
  name: 'widgets',
  version: '1.0.0',
  description: 'Widgets plugin',
  tables: [{ name: 'widgets_items', columns: [{ name: 'label', type: 'String(100)' }] }],
  api_routes: [{ method: 'GET', path: '/items', table: 'widgets_items', operation: 'list' }],
}

const REGISTRY_ENTRY: RegistryPluginEntry = {
  name: 'widgets',
  version: '1.0.0',
  minor_version: '1.0',
  repo: 'https://github.com/keiranholloway/biffo-plugin-widgets',
  status: 'active',
}

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-project-'))
  mkdirSync(join(dir, 'services'), { recursive: true })
  return dir
}

function makeClonedPluginDir(manifest: unknown = VALID_MANIFEST, withTerraform = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-plugin-src-'))
  writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify(manifest))
  if (withTerraform) {
    mkdirSync(join(dir, 'terraform'), { recursive: true })
    writeFileSync(join(dir, 'terraform', 'main.tf'), '# plugin terraform module\n')
  }
  return dir
}

function makeRegistryMock(entry: RegistryPluginEntry = REGISTRY_ENTRY) {
  return { resolvePlugin: vi.fn().mockResolvedValue(entry) }
}

function makeGitMock(clonedDir: string) {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    cloneToTemp: vi.fn().mockResolvedValue(clonedDir),
    cleanup: vi.fn((dir: string) => rmSync(dir, { recursive: true, force: true })),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMigrationsMock(generatedPaths: string[] = []) {
  return { generate: vi.fn().mockResolvedValue(generatedPaths) }
}

describe('runPluginInstall', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects a malformed target argument', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginInstall(
        'widgets',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('Invalid target')

    expect(registry.resolvePlugin).not.toHaveBeenCalled()
  })

  it('resolves name@minor and passes both parts to the registry', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(registry.resolvePlugin).toHaveBeenCalledWith('widgets', '1.0')
  })

  it('clones the resolved repo, validates the manifest, and installs into services/<name>/', async () => {
    const clonedDir = makeClonedPluginDir()
    const registry = makeRegistryMock()
    const git = makeGitMock(clonedDir)
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(git.cloneToTemp).toHaveBeenCalledWith(REGISTRY_ENTRY.repo, 'biffo-plugin-widgets')
    const installedManifest = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(existsSync(installedManifest)).toBe(true)
    expect(JSON.parse(readFileSync(installedManifest, 'utf8'))).toMatchObject({ name: 'widgets' })
  })

  it('stages and commits with a Conventional Commit message', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    expect(git.commit).toHaveBeenCalledWith(projectRoot, 'feat(plugins): install widgets@1.0.0')
  })

  it('copies a Terraform module when the plugin repo ships one, without touching main.tf', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(VALID_MANIFEST, true))
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const copiedTf = join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf')
    expect(existsSync(copiedTf)).toBe(true)
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      'services/widgets',
      'modules/plugins/widgets',
    ])
    // Explicitly out of scope (blocked on #25) — no infra/environments/*/main.tf should be touched.
    expect(existsSync(join(projectRoot, 'infra'))).toBe(false)
  })

  it('does not copy a terraform/ directory when the plugin repo has none', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets'))).toBe(false)
    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
  })

  it('cleans up the temp clone directory after a successful install', async () => {
    const clonedDir = makeClonedPluginDir()
    const registry = makeRegistryMock()
    const git = makeGitMock(clonedDir)
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(git.cleanup).toHaveBeenCalledWith(clonedDir)
    expect(existsSync(clonedDir)).toBe(false)
  })

  it('rejects when the plugin is already installed', async () => {
    mkdirSync(join(projectRoot, 'services', 'widgets'), { recursive: true })
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('already installed')

    expect(git.cloneToTemp).not.toHaveBeenCalled()
  })

  it('rejects when cwd has no services/ directory', async () => {
    const notAProject = mkdtempSync(join(tmpdir(), 'not-a-biffo-project-'))
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    try {
      await expect(
        runPluginInstall(
          'widgets@1.0',
          { dryRun: false, cwd: notAProject },
          { registry: registry as never, git: git as never, migrations: migrations as never },
        ),
      ).rejects.toThrow('root of a Biffo project checkout')
    } finally {
      rmSync(notAProject, { recursive: true, force: true })
    }
  })

  it('rejects when cwd is not a git repository', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()
    git.isGitRepo.mockResolvedValue(false)

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('is not a git repository')

    expect(git.cloneToTemp).not.toHaveBeenCalled()
  })

  it('propagates a registry-not-found error without touching the filesystem', async () => {
    const registry = {
      resolvePlugin: vi.fn().mockRejectedValue(new Error("Plugin 'widgets' was not found")),
    }
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('was not found')

    expect(git.cloneToTemp).not.toHaveBeenCalled()
  })

  it('propagates a clone failure and leaves no partial install behind', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()
    git.cloneToTemp.mockRejectedValue(new Error('Failed to clone https://example.com: not found'))

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('Failed to clone')

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
  })

  it('rejects an invalid manifest and leaves no partial install behind', async () => {
    const clonedDir = makeClonedPluginDir({ name: 'widgets' }) // missing required `version`
    const registry = makeRegistryMock()
    const git = makeGitMock(clonedDir)
    const migrations = makeMigrationsMock()

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow()

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('rejects when the manifest name does not match the registry entry', async () => {
    const clonedDir = makeClonedPluginDir({ ...VALID_MANIFEST, name: 'not-widgets' })
    const registry = makeRegistryMock()
    const git = makeGitMock(clonedDir)
    const migrations = makeMigrationsMock()

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('does not match the registry entry')

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
  })

  it('rejects when the plugin repo has no biffo.plugin.json at its root', async () => {
    const clonedDir = mkdtempSync(join(tmpdir(), 'biffo-plugin-src-empty-'))
    const registry = makeRegistryMock()
    const git = makeGitMock(clonedDir)
    const migrations = makeMigrationsMock()

    await expect(
      runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('does not contain a biffo.plugin.json manifest')
  })

  describe('--dry-run', () => {
    it('does not clone, write files, or commit', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await runPluginInstall(
        'widgets@1.0',
        { dryRun: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(git.cloneToTemp).not.toHaveBeenCalled()
      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
      expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
    })

    it('still resolves the plugin against the registry', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await runPluginInstall(
        'widgets@1.0',
        { dryRun: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(registry.resolvePlugin).toHaveBeenCalledWith('widgets', '1.0')
    })
  })

  describe('migration generation', () => {
    it('generates a migration and stages it in the same commit when the manifest has tables', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const generatedPath = join(
        projectRoot,
        'services',
        'api',
        'migrations',
        'versions',
        'abc123_add_widgets_items_table.py',
      )
      const migrations = makeMigrationsMock([generatedPath])

      await runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(migrations.generate).toHaveBeenCalledWith(projectRoot, ['widgets'])
      expect(git.add).toHaveBeenCalledWith(projectRoot, [
        'services/widgets',
        join('services', 'api', 'migrations', 'versions', 'abc123_add_widgets_items_table.py'),
      ])
    })

    it('skips calling migrations.generate when the manifest declares no tables', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(
        makeClonedPluginDir({ ...VALID_MANIFEST, tables: [], api_routes: [] }),
      )
      const migrations = makeMigrationsMock()

      await runPluginInstall(
        'widgets@1.0',
        { dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(migrations.generate).not.toHaveBeenCalled()
      expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    })

    it('propagates a migration-generation failure and does not commit', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = {
        generate: vi.fn().mockRejectedValue(new Error('needs `uv` (Python) on PATH')),
      }

      await expect(
        runPluginInstall(
          'widgets@1.0',
          { dryRun: false, cwd: projectRoot },
          { registry: registry as never, git: git as never, migrations: migrations as never },
        ),
      ).rejects.toThrow('needs `uv`')

      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
      // The plugin source itself is left copied-but-uncommitted, matching
      // this command's existing no-rollback behavior for any other failure.
      expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(true)
    })
  })
})
