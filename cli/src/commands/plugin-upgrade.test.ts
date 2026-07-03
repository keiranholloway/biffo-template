import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryPluginEntry } from '../adapters/registry/index.js'
import { runPluginUpgrade } from './plugin-upgrade.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

const OLD_MANIFEST = {
  name: 'widgets',
  version: '1.0.0',
  description: 'Widgets plugin',
  tables: [{ name: 'widgets_items', columns: [{ name: 'label', type: 'String(100)' }] }],
  api_routes: [{ method: 'GET', path: '/items', table: 'widgets_items', operation: 'list' }],
}

const NEW_MANIFEST = { ...OLD_MANIFEST, version: '1.1.0' }

const REGISTRY_ENTRY: RegistryPluginEntry = {
  name: 'widgets',
  version: '1.1.0',
  minor_version: '1.1',
  repo: 'https://github.com/keiranholloway/biffo-plugin-widgets',
  status: 'active',
}

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-project-'))
  mkdirSync(join(dir, 'services', 'widgets'), { recursive: true })
  writeFileSync(join(dir, 'services', 'widgets', 'biffo.plugin.json'), JSON.stringify(OLD_MANIFEST))
  return dir
}

function makeClonedPluginDir(manifest: unknown = NEW_MANIFEST, withTerraform = false): string {
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

describe('runPluginUpgrade', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
    promptMock.mockReset()
    promptMock.mockResolvedValue({ confirmed: true })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects a malformed target argument', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        'widgets',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('Invalid target')
  })

  it('rejects when the plugin is not already installed', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        'not-installed@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('is not installed at services/not-installed/')

    expect(registry.resolvePlugin).not.toHaveBeenCalled()
  })

  it('resolves the new version, replaces services/<name>/, and commits', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(registry.resolvePlugin).toHaveBeenCalledWith('widgets', '1.1')
    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.1.0' })
    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    expect(git.commit).toHaveBeenCalledWith(
      projectRoot,
      'feat(plugins): upgrade widgets 1.0.0 -> 1.1.0',
    )
  })

  it('no-ops when the registry version matches the already-installed version', async () => {
    const registry = makeRegistryMock({ ...REGISTRY_ENTRY, version: '1.0.0', minor_version: '1.0' })
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      'widgets@1.0',
      { dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(git.cloneToTemp).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('replaces a previously-copied Terraform module with the new version', async () => {
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')

    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(NEW_MANIFEST, true))
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'))).toBe(false)
    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'))).toBe(true)
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      'services/widgets',
      'modules/plugins/widgets',
    ])
  })

  it('removes a stale Terraform module when the new version no longer ships one', async () => {
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')

    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(NEW_MANIFEST, false))
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets'))).toBe(false)
  })

  it('prompts for confirmation when --force is not set, and honours "no"', async () => {
    promptMock.mockResolvedValue({ confirmed: false })
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: false, force: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(promptMock).toHaveBeenCalled()
    expect(git.cloneToTemp).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('rejects when cwd is not a git repository', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()
    git.isGitRepo.mockResolvedValue(false)

    await expect(
      runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('is not a git repository')

    expect(git.cloneToTemp).not.toHaveBeenCalled()
  })

  it('rejects an invalid new manifest and leaves the old install untouched', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir({ name: 'widgets' })) // missing `version`
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow()

    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.0.0' })
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  describe('--dry-run', () => {
    it('does not clone, replace files, prompt, or commit', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: true, force: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(promptMock).not.toHaveBeenCalled()
      expect(git.cloneToTemp).not.toHaveBeenCalled()
      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
      const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.0.0' })
    })

    it('still resolves the plugin against the registry', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: true, force: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(registry.resolvePlugin).toHaveBeenCalledWith('widgets', '1.1')
    })
  })

  describe('migration generation', () => {
    it('generates a migration and stages it in the same commit when the new manifest has tables', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const generatedPath = join(
        projectRoot,
        'services',
        'api',
        'migrations',
        'versions',
        'def456_add_widgets_items_table.py',
      )
      const migrations = makeMigrationsMock([generatedPath])

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(migrations.generate).toHaveBeenCalledWith(projectRoot, ['widgets'])
      expect(git.add).toHaveBeenCalledWith(projectRoot, [
        'services/widgets',
        join('services', 'api', 'migrations', 'versions', 'def456_add_widgets_items_table.py'),
      ])
    })

    it('skips calling migrations.generate when the new manifest declares no tables', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir({ ...NEW_MANIFEST, tables: [], api_routes: [] }))
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
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
        runPluginUpgrade(
          'widgets@1.1',
          { dryRun: false, force: true, cwd: projectRoot },
          { registry: registry as never, git: git as never, migrations: migrations as never },
        ),
      ).rejects.toThrow('needs `uv`')

      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
    })
  })
})
