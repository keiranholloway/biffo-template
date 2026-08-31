/**
 * End-to-end integration test for runPluginInstall().
 *
 * Unlike plugin-install.test.ts (which passes registry/git mocks), this
 * exercises the real RegistryAdapter and real GitAdapter — including an
 * actual `git clone` of a local file:// repo and an actual `git commit` —
 * with only the registry's HTTP fetch intercepted via MSW. This catches
 * wiring bugs the mock-level test can't: wrong argument order into the git
 * adapter, a manifest shape the real validator rejects, etc.
 */
import { execa } from 'execa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter } from '../adapters/registry/index.js'
import { runPluginInstall } from './plugin-install.js'
import { makeTmpDir, removeTmpDir } from '../test-utils/tmp.js'

const REGISTRY_URL = 'https://example.com/registry/plugins.json'
const server = setupServer()

/**
 * A real-but-stubbed PluginMigrationsAdapter: writes a dummy migration file
 * directly, no subprocess. Keeps this integration test tier uv/Python-free
 * (consistent with every other CLI integration test — see
 * adapters/plugin-migrations/index.ts's docstring for why the real adapter
 * needs uv/Python, and index.test.ts for the mocked-execa coverage of that
 * real adapter's own behavior instead).
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

describe('runPluginInstall — end-to-end', () => {
  let pluginSourceRepo: string
  let projectRoot: string

  beforeEach(async () => {
    // A local bare-ish "plugin repo" the CLI will `git clone`.
    pluginSourceRepo = makeTmpDir('biffo-plugin-source')
    await initGitRepo(pluginSourceRepo)
    writeFileSync(
      join(pluginSourceRepo, 'biffo.plugin.json'),
      JSON.stringify({
        name: 'widgets',
        version: '1.3.0',
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
    mkdirSync(join(pluginSourceRepo, 'terraform'), { recursive: true })
    writeFileSync(join(pluginSourceRepo, 'terraform', 'main.tf'), '# widgets plugin module\n')
    await commitAll(pluginSourceRepo, 'initial plugin source')

    // A local "Biffo project checkout" the CLI installs into.
    projectRoot = makeTmpDir('biffo-project')
    mkdirSync(join(projectRoot, 'services'), { recursive: true })
    await initGitRepo(projectRoot)
    writeFileSync(join(projectRoot, 'README.md'), '# Test project\n')
    await commitAll(projectRoot, 'chore: initial commit')

    server.use(
      http.get(REGISTRY_URL, () =>
        HttpResponse.json({
          schema_version: '1.0',
          last_updated: '2026-06-30T00:00:00Z',
          plugins: [
            {
              name: 'widgets',
              version: '1.3.0',
              minor_version: '1.3',
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
    // Both fixtures were just written to by real `git` subprocesses (clone,
    // init, add, commit) -- see `removeTmpDir`'s docstring for why a bare
    // `rmSync` here is racy.
    removeTmpDir(pluginSourceRepo)
    removeTmpDir(projectRoot)
  })

  it('resolves the registry, clones the real plugin repo, installs it, and commits', async () => {
    await runPluginInstall(
      'widgets@1.3',
      { dryRun: false, cwd: projectRoot },
      {
        registry: new RegistryAdapter(REGISTRY_URL),
        git: new GitAdapter(),
        migrations: new FakePluginMigrationsAdapter() as never,
      },
    )

    const manifestPath = join(projectRoot, 'services', 'widgets', 'biffo.plugin.json')
    expect(existsSync(manifestPath)).toBe(true)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      name: 'widgets',
      version: '1.3.0',
    })

    // The clone's own .git metadata must not leak into the monorepo's tree.
    expect(existsSync(join(projectRoot, 'services', 'widgets', '.git'))).toBe(false)

    // Terraform module copied, but no attempt made to wire infra/environments/*/main.tf.
    expect(existsSync(join(projectRoot, 'modules', 'plugins', 'widgets', 'main.tf'))).toBe(true)

    const log = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: projectRoot })
    expect(log.stdout).toBe('feat(plugins): install widgets@1.3.0')

    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })

  it('propagates a plugin-not-found registry error without cloning anything', async () => {
    await expect(
      runPluginInstall(
        'invoicing@1.0',
        { dryRun: false, cwd: projectRoot },
        {
          registry: new RegistryAdapter(REGISTRY_URL),
          git: new GitAdapter(),
          migrations: new FakePluginMigrationsAdapter() as never,
        },
      ),
    ).rejects.toThrow("Plugin 'invoicing' was not found")

    expect(existsSync(join(projectRoot, 'services', 'invoicing'))).toBe(false)
  })

  it('supports --dry-run against the real registry with no filesystem or git side effects', async () => {
    await runPluginInstall(
      'widgets@1.3',
      { dryRun: true, cwd: projectRoot },
      {
        registry: new RegistryAdapter(REGISTRY_URL),
        git: new GitAdapter(),
        migrations: new FakePluginMigrationsAdapter() as never,
      },
    )

    expect(existsSync(join(projectRoot, 'services', 'widgets'))).toBe(false)
    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })
})
