import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPluginUninstall } from './plugin-uninstall.js'
import { makeTmpDir } from '../test-utils/tmp.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

const MANIFEST = {
  name: 'widgets',
  version: '1.0.0',
  description: 'Widgets plugin',
  tables: [],
  api_routes: [],
}

function makeProjectRoot(): string {
  const dir = makeTmpDir('biffo-project')
  mkdirSync(join(dir, 'services', 'widgets'), { recursive: true })
  writeFileSync(join(dir, 'services', 'widgets', 'biffo.plugin.json'), JSON.stringify(MANIFEST))
  return dir
}

function makeEnvironment(root: string, env: string): void {
  const dir = join(root, 'infra', 'environments', env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'main.tf'),
    '# hand-authored root config\n' + 'variable "enabled_plugins" {\n  type = list(string)\n}\n',
  )
}

function makeGitMock() {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runPluginUninstall', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
    promptMock.mockReset()
    promptMock.mockResolvedValue({ confirmed: true })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('rejects an invalid plugin name', async () => {
    await expect(
      runPluginUninstall(
        'Not_Valid',
        { dryRun: false, force: true, keepData: false, cwd: projectRoot },
        { git: makeGitMock() as never },
      ),
    ).rejects.toThrow('Invalid plugin name')
  })

  it('rejects when cwd has no services/ directory', async () => {
    const notAProject = makeTmpDir('not-a-biffo-project')
    try {
      await expect(
        runPluginUninstall(
          'widgets',
          { dryRun: false, force: true, keepData: false, cwd: notAProject },
          { git: makeGitMock() as never },
        ),
      ).rejects.toThrow('root of a Biffo project checkout')
    } finally {
      rmSync(notAProject, { recursive: true, force: true })
    }
  })

  it('rejects when the plugin is not installed', async () => {
    await expect(
      runPluginUninstall(
        'not-installed',
        { dryRun: false, force: true, keepData: false, cwd: projectRoot },
        { git: makeGitMock() as never },
      ),
    ).rejects.toThrow('is not installed at services/not-installed/')
  })

  it('refuses to uninstall a first-party plugin, pointing at enabled_plugins instead', async () => {
    // services/_plugins/ is template-owned (#243): deleting it here would be
    // undone by the next `biffo core upgrade`, so the CLI must not pretend.
    mkdirSync(join(projectRoot, 'services', '_plugins', 'orchestrator'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'services', '_plugins', 'orchestrator', 'biffo.plugin.json'),
      JSON.stringify({ name: 'orchestrator', version: '0.1.0' }),
    )

    await expect(
      runPluginUninstall(
        'orchestrator',
        { dryRun: false, force: true, keepData: false, cwd: projectRoot },
        { git: makeGitMock() as never },
      ),
    ).rejects.toThrow(/first-party plugin at services\/_plugins\/orchestrator\/.*enabled_plugins/s)

    // ...and it is still there.
    expect(existsSync(join(projectRoot, 'services', '_plugins', 'orchestrator'))).toBe(true)
  })

  it('rejects when cwd is not a git repository', async () => {
    const git = makeGitMock()
    git.isGitRepo.mockResolvedValue(false)

    await expect(
      runPluginUninstall(
        'widgets',
        { dryRun: false, force: true, keepData: false, cwd: projectRoot },
        { git: git as never },
      ),
    ).rejects.toThrow('is not a git repository')

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(true)
  })

  it('removes services/<name>/ and commits with --force (no prompt)', async () => {
    const git = makeGitMock()

    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: true, keepData: false, cwd: projectRoot },
      { git: git as never },
    )

    expect(promptMock).not.toHaveBeenCalled()
    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
    expect(git.commit).toHaveBeenCalledWith(projectRoot, 'chore(plugins): uninstall widgets@1.0.0')
  })

  it('also removes modules/plugins/<name>/ if it exists', async () => {
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'), '# tf\n')
    const git = makeGitMock()

    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: true, keepData: false, cwd: projectRoot },
      { git: git as never },
    )

    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets'))).toBe(false)
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      'services/widgets',
      'modules/plugins/widgets',
    ])
  })

  describe('vendored seed DDL (biffo-template#1554)', () => {
    it('leaves db/imports/_plugin-<name>/ in place and warns why, rather than removing it', async () => {
      mkdirSync(join(projectRoot, 'db', 'imports', '_plugin-widgets'), { recursive: true })
      writeFileSync(
        join(projectRoot, 'db', 'imports', '_plugin-widgets', '000_default.sql'),
        'SELECT 1;\n',
      )
      const git = makeGitMock()
      const { log } = await import('../lib/logger.js')

      await runPluginUninstall(
        'widgets',
        { dryRun: false, force: true, keepData: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(
        existsSync(join(projectRoot, 'db', 'imports', '_plugin-widgets', '000_default.sql')),
      ).toBe(true)
      // Not staged/committed either — untouched entirely, not just left on disk.
      expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/widgets'])
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('db/imports/_plugin-widgets'))
    })

    it('says nothing about a seed when the plugin never vendored one', async () => {
      const git = makeGitMock()
      const { log } = await import('../lib/logger.js')
      // The mocked logger is a module-level singleton shared across every
      // test in this file and is never reset between them (see the other
      // tests here, which only ever assert a call WAS made — immune to
      // this) — clear it so this negative assertion checks THIS run only.
      ;(log.warn as ReturnType<typeof vi.fn>).mockClear()

      await runPluginUninstall(
        'widgets',
        { dryRun: false, force: true, keepData: false, cwd: projectRoot },
        { git: git as never },
      )

      const seedWarning = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
        String(call[0]).includes('db/imports/_plugin-widgets'),
      )
      expect(seedWarning).toBeUndefined()
    })
  })

  it('prompts for confirmation when --force is not set, and honours "no"', async () => {
    promptMock.mockResolvedValue({ confirmed: false })
    const git = makeGitMock()

    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: false, keepData: false, cwd: projectRoot },
      { git: git as never },
    )

    expect(promptMock).toHaveBeenCalled()
    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(true)
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('proceeds when the confirmation prompt is accepted', async () => {
    promptMock.mockResolvedValue({ confirmed: true })
    const git = makeGitMock()

    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: false, keepData: false, cwd: projectRoot },
      { git: git as never },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
    expect(git.commit).toHaveBeenCalled()
  })

  describe('--dry-run', () => {
    it('does not remove anything, prompt, or commit', async () => {
      const git = makeGitMock()

      await runPluginUninstall(
        'widgets',
        { dryRun: true, force: false, keepData: false, cwd: projectRoot },
        { git: git as never },
      )

      expect(promptMock).not.toHaveBeenCalled()
      expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(true)
      expect(git.add).not.toHaveBeenCalled()
      expect(git.commit).not.toHaveBeenCalled()
    })
  })
})

describe('runPluginUninstall — Terraform wiring (#201)', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = makeProjectRoot()
    promptMock.mockReset()
    promptMock.mockResolvedValue({ confirmed: true })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('unwires the module block when the last plugin is removed', async () => {
    makeEnvironment(projectRoot, 'dev')
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'modules', 'plugins', 'widgets', 'variables.tf'),
      'variable "project_name" { type = string }\n',
    )
    const generatedTf = join(projectRoot, 'infra', 'environments', 'dev', 'plugins.generated.tf')
    writeFileSync(generatedTf, '# stale generated content\n')

    const git = makeGitMock()
    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: true, keepData: false, cwd: projectRoot },
      { git: git as never },
    )

    // Leaving the block behind would point `source` at a directory that no
    // longer exists, breaking `terraform validate` for the whole environment.
    expect(existsSync(generatedTf)).toBe(false)
    expect(git.add).toHaveBeenCalledWith(projectRoot, [
      'services/widgets',
      'modules/plugins/widgets',
      'infra/environments/dev/plugins.generated.tf',
    ])
  })

  it('leaves the remaining plugins wired in', async () => {
    makeEnvironment(projectRoot, 'dev')
    for (const name of ['widgets', 'keeper']) {
      mkdirSync(join(projectRoot, 'modules', 'plugins', name), { recursive: true })
      writeFileSync(
        join(projectRoot, 'modules', 'plugins', name, 'variables.tf'),
        'variable "project_name" { type = string }\n',
      )
    }

    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: true, keepData: false, cwd: projectRoot },
      { git: makeGitMock() as never },
    )

    const tf = readFileSync(
      join(projectRoot, 'infra', 'environments', 'dev', 'plugins.generated.tf'),
      'utf8',
    )
    expect(tf).toContain('module "plugin_keeper"')
    expect(tf).not.toContain('module "plugin_widgets"')
  })
})
