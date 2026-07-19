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

function makeEnvironment(root: string, env: string): void {
  const dir = join(root, 'infra', 'environments', env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'main.tf'),
    '# hand-authored root config — the CLI must never edit this\n' +
      'variable "enabled_plugins" {\n  type = list(string)\n}\n',
  )
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
    // No environment root config in this fixture, so there is nothing to wire
    // into — and the CLI must not invent an infra/ tree.
    expect(existsSync(join(projectRoot, 'infra'))).toBe(false)
  })

  it('wires the copied module into every environment root config (#201)', async () => {
    makeEnvironment(projectRoot, 'dev')
    makeEnvironment(projectRoot, 'prod')
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(VALID_MANIFEST, true))
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    for (const env of ['dev', 'prod']) {
      const tf = readFileSync(
        join(projectRoot, 'infra', 'environments', env, 'plugins.generated.tf'),
        'utf8',
      )
      expect(tf).toContain('module "plugin_widgets" {')
      expect(
        JSON.parse(
          readFileSync(
            join(projectRoot, 'infra', 'environments', env, 'plugins.auto.tfvars.json'),
            'utf8',
          ),
        ),
      ).toEqual({ enabled_plugins: ['widgets'] })
    }

    // The generated files are committed alongside the plugin, not left dirty.
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      'services/widgets',
      'modules/plugins/widgets',
      'infra/environments/dev/plugins.generated.tf',
      'infra/environments/dev/plugins.auto.tfvars.json',
      'infra/environments/prod/plugins.generated.tf',
      'infra/environments/prod/plugins.auto.tfvars.json',
    ])
  })

  it('never edits the user-owned main.tf when wiring a plugin in', async () => {
    makeEnvironment(projectRoot, 'dev')
    const mainTf = join(projectRoot, 'infra', 'environments', 'dev', 'main.tf')
    const before = readFileSync(mainTf, 'utf8')

    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir(VALID_MANIFEST, true))
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      'widgets@1.0',
      { dryRun: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(readFileSync(mainTf, 'utf8')).toBe(before)
  })

  it('wires a --local plugin in exactly as a registry one, and re-running adds no duplicate', async () => {
    makeEnvironment(projectRoot, 'dev')
    const localDir = makeClonedPluginDir(VALID_MANIFEST, true)
    const git = makeGitMock(localDir)
    const migrations = makeMigrationsMock()

    await runPluginInstall(
      undefined,
      { local: localDir, dryRun: false, cwd: projectRoot },
      { registry: makeRegistryMock() as never, git: git as never, migrations: migrations as never },
    )

    const tfPath = join(projectRoot, 'infra', 'environments', 'dev', 'plugins.generated.tf')
    const first = readFileSync(tfPath, 'utf8')
    expect(first).toContain('module "plugin_widgets" {')

    // Re-install over the top (the in-tree source path, which is re-runnable by
    // design) must regenerate identically rather than append a second block.
    await runPluginInstall(
      undefined,
      {
        local: join(projectRoot, 'services', 'widgets'),
        dryRun: false,
        cwd: projectRoot,
      },
      { registry: makeRegistryMock() as never, git: git as never, migrations: migrations as never },
    )

    const second = readFileSync(tfPath, 'utf8')
    expect(second).toBe(first)
    expect(second.match(/module "plugin_widgets"/g)).toHaveLength(1)
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

  /**
   * `--local` exists because the registry (`biffo-plugins-registry`) ships
   * `plugins: []`, so there has never been a way to install a plugin developed
   * in-tree (issue #200). It must not become a weaker install path: the same
   * `validateManifest` runs, the same Terraform copy runs, and the same
   * Alembic migration is generated and committed.
   */
  describe('--local', () => {
    function localPluginDir(manifest: unknown = VALID_MANIFEST, withTerraform = false): string {
      return makeClonedPluginDir(manifest, withTerraform)
    }

    it('installs from a local directory without consulting the registry', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock('')
      const migrations = makeMigrationsMock()
      const local = localPluginDir()

      await runPluginInstall(
        undefined,
        { local, dryRun: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(registry.resolvePlugin).not.toHaveBeenCalled()
      expect(git.cloneToTemp).not.toHaveBeenCalled()
      const installed = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
      expect(JSON.parse(readFileSync(installed, 'utf8'))).toMatchObject({ name: 'widgets' })
      rmSync(local, { recursive: true, force: true })
    })

    it('lands in the user-owned services/<name>/, never services/_plugins/', async () => {
      const local = localPluginDir()

      await runPluginInstall(
        undefined,
        { local, dryRun: false, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: makeGitMock('') as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(true)
      expect(existsSync(join(projectRoot, 'services', '_plugins'))).toBe(false)
      rmSync(local, { recursive: true, force: true })
    })

    it('validates the manifest exactly as the registry path does', async () => {
      const local = localPluginDir({ name: 'widgets' }) // missing required fields

      await expect(
        runPluginInstall(
          undefined,
          { local, dryRun: false, cwd: projectRoot },
          {
            registry: makeRegistryMock() as never,
            git: makeGitMock('') as never,
            migrations: makeMigrationsMock() as never,
          },
        ),
      ).rejects.toThrow()

      expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
      rmSync(local, { recursive: true, force: true })
    })

    it('generates and commits the migration, like the registry path', async () => {
      const local = localPluginDir()
      const git = makeGitMock('')
      const migrations = makeMigrationsMock([
        join(projectRoot, 'services/api/migrations/versions/abc_widgets.py'),
      ])

      await runPluginInstall(
        undefined,
        { local, dryRun: false, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: git as never,
          migrations: migrations as never,
        },
      )

      expect(migrations.generate).toHaveBeenCalledWith(projectRoot, ['widgets'])
      expect(git.add).toHaveBeenCalledWith(projectRoot, [
        'services/widgets',
        'services/api/migrations/versions/abc_widgets.py',
      ])
      expect(git.commit).toHaveBeenCalledWith(projectRoot, 'feat(plugins): install widgets@1.0.0')
      rmSync(local, { recursive: true, force: true })
    })

    it("copies a local plugin's terraform/ into modules/plugins/<name>/", async () => {
      const local = localPluginDir(VALID_MANIFEST, true)

      await runPluginInstall(
        undefined,
        { local, dryRun: false, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: makeGitMock('') as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'))).toBe(true)
      rmSync(local, { recursive: true, force: true })
    })

    it('installs in place when --local already points into the checkout', async () => {
      // The `biffo plugin create` → `biffo plugin install --local` flow: the
      // source *is* the install location, so there is nothing to copy and the
      // already-installed guard must not fire against the plugin itself.
      const inTree = join(projectRoot, 'services', 'widgets')
      mkdirSync(join(inTree, 'terraform'), { recursive: true })
      writeFileSync(join(inTree, 'biffo.plugin.json'), JSON.stringify(VALID_MANIFEST))
      writeFileSync(join(inTree, 'terraform', 'main.tf'), '# tf\n')
      const git = makeGitMock('')

      await runPluginInstall(
        undefined,
        { local: inTree, dryRun: false, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: git as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'))).toBe(true)
      expect(git.commit).toHaveBeenCalledWith(projectRoot, 'feat(plugins): install widgets@1.0.0')
    })

    it('rejects a --local path that is not a plugin directory', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'not-a-plugin-'))

      await expect(
        runPluginInstall(
          undefined,
          { local: empty, dryRun: false, cwd: projectRoot },
          {
            registry: makeRegistryMock() as never,
            git: makeGitMock('') as never,
            migrations: makeMigrationsMock() as never,
          },
        ),
      ).rejects.toThrow('does not contain a biffo.plugin.json')

      rmSync(empty, { recursive: true, force: true })
    })

    it('rejects a --local path that does not exist', async () => {
      await expect(
        runPluginInstall(
          undefined,
          { local: join(projectRoot, 'nope'), dryRun: false, cwd: projectRoot },
          {
            registry: makeRegistryMock() as never,
            git: makeGitMock('') as never,
            migrations: makeMigrationsMock() as never,
          },
        ),
      ).rejects.toThrow('--local path does not exist')
    })

    it('rejects a registry target and --local together', async () => {
      const local = localPluginDir()

      await expect(
        runPluginInstall(
          'widgets@1.0',
          { local, dryRun: false, cwd: projectRoot },
          {
            registry: makeRegistryMock() as never,
            git: makeGitMock('') as never,
            migrations: makeMigrationsMock() as never,
          },
        ),
      ).rejects.toThrow('not both')

      rmSync(local, { recursive: true, force: true })
    })

    it('rejects neither a target nor --local', async () => {
      await expect(
        runPluginInstall(
          undefined,
          { dryRun: false, cwd: projectRoot },
          {
            registry: makeRegistryMock() as never,
            git: makeGitMock('') as never,
            migrations: makeMigrationsMock() as never,
          },
        ),
      ).rejects.toThrow('Nothing to install')
    })

    it('writes nothing under --dry-run', async () => {
      const local = localPluginDir()
      const git = makeGitMock('')

      await runPluginInstall(
        undefined,
        { local, dryRun: true, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: git as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
      expect(git.commit).not.toHaveBeenCalled()
      rmSync(local, { recursive: true, force: true })
    })
  })
})
