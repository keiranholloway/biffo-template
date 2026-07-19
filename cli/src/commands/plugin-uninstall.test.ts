import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPluginUninstall } from './plugin-uninstall.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'biffo-project-'))
  mkdirSync(join(dir, 'services', 'widgets'), { recursive: true })
  writeFileSync(join(dir, 'services', 'widgets', 'biffo.plugin.json'), JSON.stringify(MANIFEST))
  return dir
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
    const notAProject = mkdtempSync(join(tmpdir(), 'not-a-biffo-project-'))
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
