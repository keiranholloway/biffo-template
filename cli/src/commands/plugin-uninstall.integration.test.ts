/**
 * End-to-end integration test for runPluginUninstall().
 *
 * Unlike plugin-uninstall.test.ts (which passes a git mock), this exercises
 * the real GitAdapter — an actual `git add` of a deletion and an actual
 * `git commit` — against a real local repository.
 */
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { runPluginUninstall } from './plugin-uninstall.js'

async function initGitRepo(dir: string): Promise<void> {
  await execa('git', ['init', '--initial-branch=main'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Biffo Test'], { cwd: dir })
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', message], { cwd: dir })
}

describe('runPluginUninstall — end-to-end', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'biffo-project-'))
    mkdirSync(join(projectRoot, 'services', 'widgets'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'services', 'widgets', 'biffo.plugin.json'),
      JSON.stringify({
        name: 'widgets',
        version: '1.0.0',
        description: 'Widgets plugin',
        tables: [],
        api_routes: [],
      }),
    )
    mkdirSync(join(projectRoot, 'modules', 'plugins', 'widgets'), { recursive: true })
    writeFileSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'), '# tf\n')
    await initGitRepo(projectRoot)
    await commitAll(projectRoot, 'feat(plugins): install widgets@1.0.0')
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('removes and commits the deletion of services/<name>/ and modules/plugins/<name>/', async () => {
    await runPluginUninstall(
      'widgets',
      { dryRun: false, force: true, keepData: false, cwd: projectRoot },
      { git: new GitAdapter() },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets'))).toBe(false)

    const log = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: projectRoot })
    expect(log.stdout).toBe('chore(plugins): uninstall widgets@1.0.0')

    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })

  it('supports --dry-run with no filesystem or git side effects', async () => {
    await runPluginUninstall(
      'widgets',
      { dryRun: true, force: true, keepData: false, cwd: projectRoot },
      { git: new GitAdapter() },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(true)
    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })
})
