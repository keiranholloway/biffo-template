import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryPluginEntry } from '../adapters/registry/index.js'
import { runPluginUpgrade } from './plugin-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

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
  const dir = makeTmpDir('biffo-project')
  mkdirSync(join(dir, 'services', 'widgets'), { recursive: true })
  writeFileSync(join(dir, 'services', 'widgets', 'biffo.plugin.json'), JSON.stringify(OLD_MANIFEST))
  return dir
}

function makeClonedPluginDir(manifest: unknown = NEW_MANIFEST, withTerraform = false): string {
  const dir = makeTmpDir('biffo-plugin-src')
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
    // Defaults to "yes, something changed" so every existing commit-path test
    // keeps committing; --local's no-op-refresh tests override this to false.
    hasUncommittedChanges: vi.fn().mockResolvedValue(true),
    commit: vi.fn().mockResolvedValue(undefined),
    // Provenance (#1547): a real GitAdapter would `git ls-remote` the
    // registry repo. Mocked to `null` ("unknown") so no test in this file
    // depends on real network access; provenance-specific tests override it.
    resolveDefaultBranchSha: vi.fn().mockResolvedValue(null),
  }
}

function makeMigrationsMock(generatedPaths: string[] = []) {
  return { generate: vi.fn().mockResolvedValue(generatedPaths) }
}

// biffo-template#1554 — a new version declaring a baseline-row seed.
const SEEDED_NEW_MANIFEST = {
  ...NEW_MANIFEST,
  seed: { dir: 'db/seed', baseline_tables: ['widgets_items'] },
}

function writeSeedFiles(pluginDir: string, seedDirRel: string, files: Record<string, string>) {
  const seedDir = join(pluginDir, seedDirRel)
  mkdirSync(seedDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(seedDir, name), content)
  }
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

  describe('seed vendoring (biffo-template#1554)', () => {
    it('vendors seed.dir into db/imports/_plugin-<name>/ and stages it in the commit', async () => {
      const clonedDir = makeClonedPluginDir(SEEDED_NEW_MANIFEST)
      writeSeedFiles(clonedDir, 'db/seed', { '000_default.sql': 'SELECT 1;\n' })
      const registry = makeRegistryMock()
      const git = makeGitMock(clonedDir)
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      const vendored = join(projectRoot, 'db', 'imports', '_plugin-widgets', '000_default.sql')
      expect(existsSync(vendored)).toBe(true)
      expect(git.add).toHaveBeenCalledWith(
        projectRoot,
        expect.arrayContaining(['db/imports/_plugin-widgets']),
      )
    })

    it('fully replaces the vendored directory rather than merging old and new files', async () => {
      // Simulates a previous install having vendored a now-superseded file —
      // upgrade must not leave it behind alongside the new one (mirrors the
      // Terraform-module replace test above).
      mkdirSync(join(projectRoot, 'db', 'imports', '_plugin-widgets'), { recursive: true })
      writeFileSync(
        join(projectRoot, 'db', 'imports', '_plugin-widgets', 'old_stale.sql'),
        '-- stale, should be gone after upgrade\n',
      )
      const clonedDir = makeClonedPluginDir(SEEDED_NEW_MANIFEST)
      writeSeedFiles(clonedDir, 'db/seed', { '001_new.sql': 'SELECT 1;\n' })

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: makeGitMock(clonedDir) as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      expect(
        existsSync(join(projectRoot, 'db', 'imports', '_plugin-widgets', 'old_stale.sql')),
      ).toBe(false)
      expect(existsSync(join(projectRoot, 'db', 'imports', '_plugin-widgets', '001_new.sql'))).toBe(
        true,
      )
    })

    it('a plugin with no seed leaves db/imports/ completely untouched', async () => {
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir(NEW_MANIFEST))
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(existsSync(join(projectRoot, 'db', 'imports'))).toBe(false)
    })
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

  describe('module-removal guard (biffo-template#1563)', () => {
    function writeGeneratedTf(pluginName: string): void {
      const dir = join(projectRoot, 'infra', 'environments', 'dev')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'plugins.generated.tf'),
        [
          '# generated',
          '',
          `module "plugin_${pluginName}" {`,
          `  source   = "../../../modules/plugins/${pluginName}"`,
          `  for_each = contains(var.enabled_plugins, "${pluginName}") ? { "${pluginName}" = true } : {}`,
          '}',
        ].join('\n'),
      )
    }

    it('refuses to remove a Terraform module still referenced by infra/, naming the file and line, and leaves the checkout untouched', async () => {
      mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
      writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')
      writeGeneratedTf('widgets')

      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir(NEW_MANIFEST, false))
      const migrations = makeMigrationsMock()

      await expect(
        runPluginUpgrade(
          'widgets@1.1',
          { dryRun: false, force: true, cwd: projectRoot },
          { registry: registry as never, git: git as never, migrations: migrations as never },
        ),
      ).rejects.toThrow(
        /Refusing to remove modules\/plugins\/widgets\/.*infra\/environments\/dev\/plugins\.generated\.tf:4/s,
      )

      // Nothing was mutated — the refusal happened before any destructive step.
      expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'))).toBe(true)
      expect(
        JSON.parse(
          readFileSync(join(projectRoot, 'services', 'widgets', 'biffo.plugin.json'), 'utf8'),
        ),
      ).toMatchObject({ version: '1.0.0' })
      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
    })

    it('still replaces the module in place when the new version keeps shipping terraform/, even if referenced', async () => {
      mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
      writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')
      writeGeneratedTf('widgets')

      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir(NEW_MANIFEST, true))
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        'widgets@1.1',
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'))).toBe(true)
      expect(git.commit).toHaveBeenCalled()
    })
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

/** A local, unpublished plugin checkout — as opposed to `makeClonedPluginDir`,
 * which models a temp clone `GitAdapter.cloneToTemp` has already stripped
 * `.git` from. Real checkouts carry their own VCS/build detritus, which is
 * exactly what these tests need present to prove it gets filtered. */
function makeLocalPluginDir(
  manifest: unknown = NEW_MANIFEST,
  opts: { withTerraform?: boolean; pyproject?: string; extraFiles?: Record<string, string> } = {},
): string {
  const dir = makeTmpDir('biffo-plugin-local')
  writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify(manifest))
  if (opts.withTerraform) {
    mkdirSync(join(dir, 'terraform'), { recursive: true })
    writeFileSync(join(dir, 'terraform', 'main.tf'), '# plugin terraform module\n')
  }
  if (opts.pyproject) {
    writeFileSync(join(dir, 'pyproject.toml'), opts.pyproject)
  }
  for (const [relPath, contents] of Object.entries(opts.extraFiles ?? {})) {
    const abs = join(dir, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents)
  }
  return dir
}

describe('runPluginUpgrade --local', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
    promptMock.mockReset()
    promptMock.mockResolvedValue({ confirmed: true })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects when both a registry target and --local are given', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        'widgets@1.1',
        { local: makeLocalPluginDir(), dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('not both')
  })

  it('rejects when neither a registry target nor --local is given', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        undefined,
        { dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('Nothing to upgrade')
  })

  it('rejects a --local refresh when the plugin is not already installed', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()
    const localDir = makeLocalPluginDir({ ...NEW_MANIFEST, name: 'not-installed' })

    await expect(
      runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('is not installed at services/not-installed/')

    expect(git.isGitRepo).not.toHaveBeenCalled()
  })

  it('refreshes services/<name>/ from the local checkout and commits, without touching the registry', async () => {
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()
    const localDir = makeLocalPluginDir()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(registry.resolvePlugin).not.toHaveBeenCalled()
    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.1.0' })
    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    expect(git.commit).toHaveBeenCalledWith(
      projectRoot,
      'chore(plugins): refresh widgets from local checkout',
    )
  })

  it('does not destroy the plugin when --local points at its own installed location (the self-copy trap)', async () => {
    // The installed copy IS the "local checkout" — e.g. someone runs
    // `biffo plugin upgrade --local services/widgets` from the project root.
    // A naive rmSync-then-cpSync would delete the plugin, then copy an empty
    // directory onto itself, and commit the empty result with no error.
    const installedDir = join(projectRoot, 'services', 'widgets')
    writeFileSync(join(installedDir, 'existing_module.py'), '# must survive\n')
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: installedDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(installedDir, 'existing_module.py'))).toBe(true)
    expect(existsSync(join(installedDir, 'biffo.plugin.json'))).toBe(true)
  })

  it('does not crash committing when the refresh has nothing to stage (a legitimate no-op)', async () => {
    // git.hasUncommittedChanges reporting false is what a byte-identical
    // refresh (or an in-place one) looks like at the git-status level — the
    // real `git commit` would exit non-zero with "nothing to commit" here.
    const localDir = makeLocalPluginDir()
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    git.hasUncommittedChanges.mockResolvedValue(false)
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).resolves.toBeUndefined()

    expect(git.commit).not.toHaveBeenCalled()
  })

  it('re-applies the [tool.uv.sources] workspace adaptation the fresh copy wipes (the install-time trap)', async () => {
    // The instance's uv workspace provides biffo-plugin-sdk as a member —
    // mirrors packages/python-sdk in a real Biffo checkout.
    mkdirSync(join(projectRoot, 'packages', 'python-sdk'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'packages', 'python-sdk', 'pyproject.toml'),
      '[project]\nname = "biffo-plugin-sdk"\n',
    )
    writeFileSync(
      join(projectRoot, 'pyproject.toml'),
      '[tool.uv.workspace]\nmembers = ["packages/python-sdk"]\n',
    )

    // The already-installed copy carries the adaptation `plugin install`
    // appended previously.
    writeFileSync(
      join(projectRoot, 'services', 'widgets', 'pyproject.toml'),
      '[project]\nname = "widgets"\ndependencies = ["biffo-plugin-sdk>=1.1"]\n\n' +
        '[tool.uv.sources]\nbiffo-plugin-sdk = { workspace = true }\n',
    )

    // The local checkout is the plugin's OWN pyproject.toml — as the
    // standalone repo ships it, with no workspace-sources block, because it
    // resolves biffo-plugin-sdk from PyPI.
    const localDir = makeLocalPluginDir(NEW_MANIFEST, {
      pyproject: '[project]\nname = "widgets"\ndependencies = ["biffo-plugin-sdk>=1.1"]\n',
    })

    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const refreshed = readFileSync(
      join(projectRoot, 'services', 'widgets', 'pyproject.toml'),
      'utf8',
    )
    expect(refreshed).toContain('[tool.uv.sources]')
    expect(refreshed).toContain('biffo-plugin-sdk = { workspace = true }')
  })

  it('copies a new source file the local checkout adds', async () => {
    const localDir = makeLocalPluginDir(NEW_MANIFEST, {
      extraFiles: { 'src/new_module.py': '# new file\n' },
    })
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets', 'src', 'new_module.py'))).toBe(true)
  })

  it('drops a file the old install carried that the local checkout no longer has', async () => {
    writeFileSync(
      join(projectRoot, 'services', 'widgets', 'stale_module.py'),
      '# will be removed by the refresh\n',
    )
    const localDir = makeLocalPluginDir()
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets', 'stale_module.py'))).toBe(false)
  })

  it('filters VCS/build detritus out of the local checkout, same as plugin install --local', async () => {
    const localDir = makeLocalPluginDir(NEW_MANIFEST, {
      extraFiles: {
        '.git/HEAD': 'ref: refs/heads/main\n',
        'node_modules/x/index.js': '// vendored\n',
        '.venv/pyvenv.cfg': 'home = /usr\n',
      },
    })
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    const installedDir = join(projectRoot, 'services', 'widgets')
    expect(existsSync(join(installedDir, '.git'))).toBe(false)
    expect(existsSync(join(installedDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(installedDir, '.venv'))).toBe(false)
  })

  describe('migration generation — only when the table set actually changed', () => {
    it('generates and stages a migration when migrations.generate reports a new table set', async () => {
      const localDir = makeLocalPluginDir()
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

      await runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(migrations.generate).toHaveBeenCalledWith(projectRoot, ['widgets'])
      expect(git.add).toHaveBeenCalledWith(projectRoot, [
        'services/widgets',
        join('services', 'api', 'migrations', 'versions', 'abc123_add_widgets_items_table.py'),
      ])
    })

    it('produces no migration for a route- or code-only change (table set unchanged)', async () => {
      // Same table set as the already-installed manifest — only a route or
      // implementation detail differs. The real generator
      // (plugin_migrations.py::sync_plugin_migrations) recognises this by
      // the manifest name + table-name hash and returns nothing; this test
      // asserts the CLI honours that "no new migration" result rather than
      // staging one anyway.
      const localDir = makeLocalPluginDir({
        ...NEW_MANIFEST,
        api_routes: [
          ...NEW_MANIFEST.api_routes,
          { method: 'GET', path: '/items/{id}', table: 'widgets_items', operation: 'read' },
        ],
      })
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock([]) // table set unchanged — nothing generated

      await runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(migrations.generate).toHaveBeenCalledWith(projectRoot, ['widgets'])
      expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    })

    it('skips calling migrations.generate entirely when the manifest declares no tables', async () => {
      const localDir = makeLocalPluginDir({ ...NEW_MANIFEST, tables: [], api_routes: [] })
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(migrations.generate).not.toHaveBeenCalled()
      expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    })
  })

  it('replaces a previously-copied Terraform module with the local checkout’s version', async () => {
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')

    const localDir = makeLocalPluginDir(NEW_MANIFEST, { withTerraform: true })
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'))).toBe(false)
    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'))).toBe(true)
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      'services/widgets',
      'modules/plugins/widgets',
    ])
  })

  it('removes a stale Terraform module when the local checkout no longer ships one and nothing references it', async () => {
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')

    const localDir = makeLocalPluginDir(NEW_MANIFEST, { withTerraform: false })
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: true, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets'))).toBe(false)
  })

  describe('module-removal guard (biffo-template#1563)', () => {
    function writeGeneratedTf(pluginName: string): void {
      const dir = join(projectRoot, 'infra', 'environments', 'dev')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'plugins.generated.tf'),
        [
          '# generated',
          '',
          `module "plugin_${pluginName}" {`,
          `  source   = "../../../modules/plugins/${pluginName}"`,
          `  for_each = contains(var.enabled_plugins, "${pluginName}") ? { "${pluginName}" = true } : {}`,
          '}',
        ].join('\n'),
      )
    }

    it('refuses a local refresh that would remove a still-referenced Terraform module, naming the file and line', async () => {
      mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
      writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'), '# old\n')
      writeGeneratedTf('widgets')

      const localDir = makeLocalPluginDir(NEW_MANIFEST, { withTerraform: false })
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await expect(
        runPluginUpgrade(
          undefined,
          { local: localDir, dryRun: false, force: true, cwd: projectRoot },
          { registry: registry as never, git: git as never, migrations: migrations as never },
        ),
      ).rejects.toThrow(
        /Refusing to remove modules\/plugins\/widgets\/.*infra\/environments\/dev\/plugins\.generated\.tf:4/s,
      )

      expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'old.tf'))).toBe(true)
      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
    })
  })

  describe('seed vendoring (biffo-template#1554)', () => {
    it('vendors seed.dir into db/imports/_plugin-<name>/ and stages it in the commit', async () => {
      const localDir = makeLocalPluginDir(SEEDED_NEW_MANIFEST, {
        extraFiles: { 'db/seed/000_default.sql': 'SELECT 1;\n' },
      })

      await runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: makeGitMock(makeClonedPluginDir()) as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      const vendored = join(projectRoot, 'db', 'imports', '_plugin-widgets', '000_default.sql')
      expect(existsSync(vendored)).toBe(true)
    })

    it('a plugin with no seed leaves db/imports/ completely untouched', async () => {
      const localDir = makeLocalPluginDir(NEW_MANIFEST)

      await runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        {
          registry: makeRegistryMock() as never,
          git: makeGitMock(makeClonedPluginDir()) as never,
          migrations: makeMigrationsMock() as never,
        },
      )

      expect(existsSync(join(projectRoot, 'db', 'imports'))).toBe(false)
    })
  })

  it('prompts for confirmation when --force is not set, and honours "no"', async () => {
    promptMock.mockResolvedValue({ confirmed: false })
    const localDir = makeLocalPluginDir()
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    const migrations = makeMigrationsMock()

    await runPluginUpgrade(
      undefined,
      { local: localDir, dryRun: false, force: false, cwd: projectRoot },
      { registry: registry as never, git: git as never, migrations: migrations as never },
    )

    expect(promptMock).toHaveBeenCalled()
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('rejects when cwd is not a git repository', async () => {
    const localDir = makeLocalPluginDir()
    const registry = makeRegistryMock()
    const git = makeGitMock(makeClonedPluginDir())
    git.isGitRepo.mockResolvedValue(false)
    const migrations = makeMigrationsMock()

    await expect(
      runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: false, force: true, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      ),
    ).rejects.toThrow('is not a git repository')

    expect(git.add).not.toHaveBeenCalled()
  })

  describe('--dry-run', () => {
    it('does not resolve the registry, replace files, prompt, or commit', async () => {
      const localDir = makeLocalPluginDir()
      const registry = makeRegistryMock()
      const git = makeGitMock(makeClonedPluginDir())
      const migrations = makeMigrationsMock()

      await runPluginUpgrade(
        undefined,
        { local: localDir, dryRun: true, force: false, cwd: projectRoot },
        { registry: registry as never, git: git as never, migrations: migrations as never },
      )

      expect(registry.resolvePlugin).not.toHaveBeenCalled()
      expect(promptMock).not.toHaveBeenCalled()
      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
      const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.0.0' })
    })
  })
})
