import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../../test-utils/tmp.js'
import { RealCommandRunner } from '../plugin-compose/command-runner.js'
import { generateDevKeypair } from '../plugin-compose/dev-auth.js'
import { buildProbes } from '../plugin-compose/probes.js'
import { BOOTSTRAP_PY } from '../plugin-compose/python-assets.js'
import { raisePostgres } from '../plugin-compose/raise-postgres.js'
import { validateManifest } from '../plugin-manifest.js'
import { buildManifestSchema } from './manifest-schema.js'

/**
 * Core's schema AND the plugin's manifest schema must both exist after `real_core`
 * provisioning (biffo-template#2187 follow-up). Fixture: a plugin with manifest-only tables.
 */
const FIXTURE = {
  name: 'schemademo',
  version: '0.1.0',
  description: 'd',
  author: 'a',
  tables: [{ name: 'widgets', columns: [{ name: 'n', type: 'String(10)', nullable: false }] }],
  api_routes: [{ method: 'GET', path: '/model-catalog', table: 'widgets', operation: 'list' }],
}

describe('real_core probes cover a Core-table-reading endpoint', () => {
  it('expects 200 for /model-catalog via core and host with the minted token', () => {
    const { probes } = buildProbes({
      coreUrl: 'http://core',
      hostUrl: 'http://host',
      manifest: validateManifest(FIXTURE),
      adminToken: 'ADMIN',
      privateKeyPem: generateDevKeypair().privateKeyPem,
      wrongKeyToken: 'WRONG',
    })
    const ok = probes.filter((p) => p.label.includes('REAL /model-catalog') && p.token === 'ADMIN')
    expect(ok.map((p) => [p.url, p.expect])).toEqual([
      ['http://core/api/v1/plugins/schemademo/model-catalog', 200],
      ['http://host/schemademo/model-catalog', 200],
    ])
  })
})

// Runs by default whenever Docker, psql and uv are available (the template checkout is Core).
// Set BIFFO_REAL_PG_E2E=0 to opt out; BIFFO_CORE_ROOT overrides the Core checkout.
const here0 = dirname(fileURLToPath(import.meta.url))
const coreRoot = process.env.BIFFO_CORE_ROOT ?? resolve(here0, '../../../..')
const have = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
const enabled =
  process.env.BIFFO_REAL_PG_E2E !== '0' &&
  have('docker', ['info']) &&
  have('psql', ['--version']) &&
  have('uv', ['--version'])
// pg-test-db.sh prints a SQLAlchemy DSN (postgresql+asyncpg://); psql needs a plain libpq URL.
const toPsqlDsn = (d: string) => d.replace(/^postgresql\+\w+:/, 'postgresql:')

describe.runIf(enabled)('real Postgres: Core schema plus plugin manifest schema', () => {
  it('has Core tables and the plugin table, with separate alembic version tables', () => {
    const runner = new RealCommandRunner()
    const pluginRoot = makeTmpDir('schema-plugin')
    writeFileSync(join(pluginRoot, 'biffo.plugin.json'), JSON.stringify(FIXTURE))
    const built = buildManifestSchema(runner, pluginRoot, coreRoot!)!
    const here = dirname(fileURLToPath(import.meta.url))
    const script = resolve(here, '../../../../scripts/pg-test-db.sh')
    const raised = raisePostgres(runner, script, pluginRoot, built.env)
    expect(raised.dsn).toBeTruthy()
    const dsn = raised.dsn!

    const work = makeTmpDir('schema-work')
    const services = join(work, 'services')
    mkdirSync(services, { recursive: true })
    symlinkSync(pluginRoot, join(services, FIXTURE.name), 'dir')
    writeFileSync(join(work, 'bootstrap.py'), BOOTSTRAP_PY)
    const coreApi = join(coreRoot!, 'services', 'api')
    const env = {
      ...(process.env as Record<string, string>),
      PYTHONPATH: join(coreApi, 'src'),
      BIFFO_DATABASE_URL: dsn.replace(/^postgres(ql)?:/, 'postgresql+asyncpg:'),
      BIFFO_PLUGIN_SERVICES_ROOT: services,
    }
    const boot = runner.run(
      'uv',
      [
        'run',
        '--frozen',
        '--directory',
        coreApi,
        'python',
        join(work, 'bootstrap.py'),
        join(work, 'state'),
        services,
      ],
      { cwd: coreApi, captureStdout: false, env },
    )
    expect(boot.status).toBe(0)

    const q = (sql: string) =>
      runner
        .run('psql', [toPsqlDsn(dsn), '-tAc', sql], { cwd: pluginRoot, captureStdout: true })
        .stdout.trim()
    const exists = (t: string) => q(`select to_regclass('public.${t}') is not null`)
    expect(exists('users')).toBe('t')
    expect(exists('plugin_chat_agents')).toBe('t')
    expect(exists('widgets')).toBe('t')
    expect(exists('alembic_version')).toBe('t')
    expect(exists('alembic_version_plugin_manifest')).toBe('t')
    // Separate version tables, each holding exactly one head. (Revision ids may coincide:
    // Core's chain gets the same generator-produced plugin revision at its head.)
    expect(q('select count(*) from alembic_version')).toBe('1')
    expect(q('select count(*) from alembic_version_plugin_manifest')).toBe('1')
  }, 300_000)
})
