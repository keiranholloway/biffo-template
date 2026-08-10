/**
 * End-to-end integration test for runPluginUpgrade().
 *
 * Exercises the real RegistryAdapter and real GitAdapter — an actual `git
 * clone` of a local file:// repo and an actual `git add`/`git commit` of
 * the replacement — with only the registry's HTTP fetch intercepted via
 * MSW, mirroring plugin-install.integration.test.ts.
 */
import { execa } from 'execa'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter } from '../adapters/registry/index.js'
import { runPluginUpgrade } from './plugin-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

const REGISTRY_URL = 'https://example.com/registry/plugins.json'
const server = setupServer()

/**
 * A real-but-stubbed PluginMigrationsAdapter: writes a dummy migration file
 * directly, no subprocess. Keeps this integration test tier uv/Python-free
 * — see plugin-install.integration.test.ts's copy of this fake for the full
 * rationale.
 */
class FakePluginMigrationsAdapter {
  async generate(cwd: string, pluginNames?: string[]): Promise<string[]> {
    if (!pluginNames || pluginNames.length === 0) return []
    const versionsDir = join(cwd, 'services', 'api', 'migrations', 'versions')
    mkdirSync(versionsDir, { recursive: true })
    const paths: string[] = []
    for (const name of pluginNames) {
      const path = join(versionsDir, `fake_${name}_migration.py`)
      writeFileSync(path, `# fake migration for ${name}\n`)
      paths.push(path)
    }
    return paths
  }
}

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
    pluginSourceRepo = makeTmpDir('biffo-plugin-source')
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

    projectRoot = makeTmpDir('biffo-project')
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
      {
        registry: new RegistryAdapter(REGISTRY_URL),
        git: new GitAdapter(),
        migrations: new FakePluginMigrationsAdapter() as never,
      },
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
      {
        registry: new RegistryAdapter(REGISTRY_URL),
        git: new GitAdapter(),
        migrations: new FakePluginMigrationsAdapter() as never,
      },
    )

    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '1.0.0' })
    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })
})

describe('runPluginUpgrade --local — end-to-end', () => {
  let localCheckout: string
  let projectRoot: string

  beforeEach(async () => {
    // A real local plugin checkout — deliberately NOT a git repo pointed at
    // by the registry, and carrying its own .git/venv/node_modules the way a
    // developer's actual working copy would, unlike the temp clone
    // `GitAdapter.cloneToTemp` hands the registry path (which has already
    // stripped `.git`).
    localCheckout = makeTmpDir('biffo-plugin-local-checkout')
    await initGitRepo(localCheckout)
    writeFileSync(
      join(localCheckout, 'biffo.plugin.json'),
      JSON.stringify({
        name: 'widgets',
        version: '1.0.0',
        description: 'Widgets plugin',
        tables: [
          {
            name: 'widgets_items',
            columns: [{ name: 'label', type: 'String(100)', nullable: false }],
          },
        ],
        api_routes: [
          { method: 'GET', path: '/items', table: 'widgets_items', operation: 'list' },
          { method: 'GET', path: '/items/{id}', table: 'widgets_items', operation: 'read' },
        ],
      }),
    )
    writeFileSync(
      join(localCheckout, 'pyproject.toml'),
      '[project]\nname = "widgets"\ndependencies = ["biffo-plugin-sdk>=1.1"]\n',
    )
    await commitAll(localCheckout, 'local edits')

    projectRoot = makeTmpDir('biffo-project')
    mkdirSync(join(projectRoot, 'packages', 'python-sdk'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'packages', 'python-sdk', 'pyproject.toml'),
      '[project]\nname = "biffo-plugin-sdk"\n',
    )
    writeFileSync(
      join(projectRoot, 'pyproject.toml'),
      '[tool.uv.workspace]\nmembers = ["packages/python-sdk"]\n',
    )
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
    // The already-installed copy carries the workspace-source adaptation
    // `plugin install` appended at install time — this is what a naive
    // refresh must not silently drop.
    writeFileSync(
      join(projectRoot, 'services', 'widgets', 'pyproject.toml'),
      '[project]\nname = "widgets"\ndependencies = ["biffo-plugin-sdk>=1.1"]\n\n' +
        '[tool.uv.sources]\nbiffo-plugin-sdk = { workspace = true }\n',
    )
    await initGitRepo(projectRoot)
    await commitAll(projectRoot, 'feat(plugins): install widgets@1.0.0')
  })

  afterEach(() => {
    rmSync(localCheckout, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('refreshes the install from the local checkout, preserves the workspace-source adaptation, and commits', async () => {
    await runPluginUpgrade(
      undefined,
      { local: localCheckout, dryRun: false, force: true, cwd: projectRoot },
      {
        registry: new RegistryAdapter(REGISTRY_URL),
        git: new GitAdapter(),
        migrations: new FakePluginMigrationsAdapter() as never,
      },
    )

    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      name: 'widgets',
      version: '1.0.0',
    })

    // The local checkout's own .git must not leak into the monorepo's tree.
    expect(existsSync(join(projectRoot, 'services', 'widgets', '.git'))).toBe(false)

    // The install-time [tool.uv.sources] adaptation survives the refresh —
    // this is the defect that actually bit under the manual hand-sync.
    const pyproject = readFileSync(
      join(projectRoot, 'services', 'widgets', 'pyproject.toml'),
      'utf8',
    )
    expect(pyproject).toContain('[tool.uv.sources]')
    expect(pyproject).toContain('biffo-plugin-sdk = { workspace = true }')

    const log = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: projectRoot })
    expect(log.stdout).toBe('chore(plugins): refresh widgets from local checkout')

    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })

  it('supports --dry-run with no filesystem or git side effects', async () => {
    await runPluginUpgrade(
      undefined,
      { local: localCheckout, dryRun: true, force: true, cwd: projectRoot },
      {
        registry: new RegistryAdapter(REGISTRY_URL),
        git: new GitAdapter(),
        migrations: new FakePluginMigrationsAdapter() as never,
      },
    )

    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })
})
