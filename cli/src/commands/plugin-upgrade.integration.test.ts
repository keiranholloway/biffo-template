/**
 * End-to-end integration test for runPluginUpgrade().
 *
 * Exercises the real RegistryAdapter and real GitAdapter — an actual `git
 * clone` of a local file:// repo and an actual `git add`/`git commit` of
 * the replacement — with only the registry's HTTP fetch intercepted via
 * MSW, mirroring plugin-install.integration.test.ts.
 */
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter } from '../adapters/registry/index.js'
import { runPluginUpgrade } from './plugin-upgrade.js'

const REGISTRY_URL = 'https://example.com/registry/plugins.json'
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

async function initGitRepo(dir: string): Promise<void> {
  await execa('git', ['init', '--initial-branch=main'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Biffo Test'], { cwd: dir })
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', message], { cwd: dir })
}

describe('runPluginUpgrade — end-to-end', () => {
  let pluginSourceRepo: string
  let projectRoot: string

  beforeEach(async () => {
    pluginSourceRepo = mkdtempSync(join(tmpdir(), 'biffo-plugin-source-'))
    await initGitRepo(pluginSourceRepo)
    writeFileSync(
      join(pluginSourceRepo, 'biffo.plugin.json'),
      JSON.stringify({
        name: 'widgets',
        version: '1.1.0',
        description: 'Widgets plugin',
        tables: [
          {
            name: 'widgets_items',
            columns: [{ name: 'label', type: 'String(100)', nullable: false }],
          },
        ],
        api_routes: [{ method: 'GET', path: '/items', table: 'widgets_items', operation: 'list' }],
      }),
    )
    await commitAll(pluginSourceRepo, 'widgets 1.1.0 source')

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
    await initGitRepo(projectRoot)
    await commitAll(projectRoot, 'feat(plugins): install widgets@1.0.0')

    server.use(
      http.get(REGISTRY_URL, () =>
        HttpResponse.json({
          schema_version: '1.0',
          last_updated: '2026-06-30T00:00:00Z',
          plugins: [
            {
              name: 'widgets',
              version: '1.1.0',
              minor_version: '1.1',
              repo: `file://${pluginSourceRepo}`,
              description: 'Widgets plugin',
              status: 'active',
            },
          ],
        }),
      ),
    )
  })

  afterEach(() => {
    rmSync(pluginSourceRepo, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('resolves the registry, clones the new version, replaces the install, and commits', async () => {
    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: false, force: true, cwd: projectRoot },
      { registry: new RegistryAdapter(REGISTRY_URL), git: new GitAdapter() },
    )

    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      name: 'widgets',
      version: '1.1.0',
    })
    expect(existsSync(join(projectRoot, 'services', 'widgets', '.git'))).toBe(false)

    const log = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: projectRoot })
    expect(log.stdout).toBe('feat(plugins): upgrade widgets 1.0.0 -> 1.1.0')

    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })

  it('supports --dry-run against the real registry with no filesystem or git side effects', async () => {
    await runPluginUpgrade(
      'widgets@1.1',
      { dryRun: true, force: true, cwd: projectRoot },
      { registry: new RegistryAdapter(REGISTRY_URL), git: new GitAdapter() },
    )

    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.0.0' })
    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })
})
