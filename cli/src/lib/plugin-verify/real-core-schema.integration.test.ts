import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../../test-utils/tmp.js'
import { RealCommandRunner } from '../plugin-compose/command-runner.js'
import { BOOTSTRAP_PY } from '../plugin-compose/python-assets.js'
import { raisePostgres } from '../plugin-compose/raise-postgres.js'
import { toAsyncpgDsn } from '../plugin-compose/compose-stack.js'
import { buildManifestSchema } from './manifest-schema.js'

/**
 * Real-database proof for the `real_core` provisioning path (#2181): a plugin with
 * manifest-only tables ends up with Core's schema (`users`, ...) AND its own table, and
 * Core's `alembic_version` is not shadowed by the plugin chain. Runs the REAL pieces --
 * the manifest-schema generator, `scripts/pg-test-db.sh`, and the `bootstrap.py` that
 * `composeStack` runs before Core boots -- against a real Postgres.
 *
 * Opt-in (needs uv, psql and a reachable Postgres): set BIFFO_IT_REAL_PG=1.
 */
const enabled = process.env.BIFFO_IT_REAL_PG === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')

function psql(dsn: string, sql: string): string {
  const r = spawnSync('psql', [dsn.replace(/^postgresql\+\w+:/, 'postgresql:'), '-At', '-c', sql], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

describe.runIf(enabled)('real_core database: Core schema + plugin manifest schema', () => {
  it('has Core tables (users) and the plugin table after provisioning + bootstrap', () => {
    const cwd = makeTmpDir('real-core-schema-plugin')
    const manifest = JSON.stringify({
      name: 'schema_fixture',
      tables: [{ name: 'schema_fixture_notes', columns: [{ name: 'title', type: 'String(100)' }] }],
    })
    writeFileSync(join(cwd, 'biffo.plugin.json'), manifest)
    const runner = new RealCommandRunner()
    const built = buildManifestSchema(runner, cwd, repoRoot)!
    const raised = raisePostgres(runner, join(repoRoot, 'scripts', 'pg-test-db.sh'), cwd, built.env)
    expect(raised.dsn).toBeTruthy()
    const dsn = raised.dsn!

    // Same step composeStack runs before starting Core.
    const work = makeTmpDir('real-core-schema-work')
    const services = join(work, 'services')
    mkdirSync(join(services, 'schema_fixture'), { recursive: true })
    writeFileSync(join(services, 'schema_fixture', 'biffo.plugin.json'), manifest)
    const app = join(work, 'bootstrap.py')
    writeFileSync(app, BOOTSTRAP_PY)
    const coreApi = join(repoRoot, 'services', 'api')
    const boot = spawnSync(
      'uv',
      ['run', '--frozen', '--directory', coreApi, 'python', app, join(work, 'state'), services],
      {
        cwd: coreApi,
        encoding: 'utf8',
        env: { ...process.env, BIFFO_DATABASE_URL: toAsyncpgDsn(dsn) },
      },
    )
    expect(boot.status, boot.stderr).toBe(0)

    const exists = (t: string) => psql(dsn, `select to_regclass('public.${t}') is not null`)
    expect(exists('users')).toBe('t')
    expect(exists('schema_fixture_notes')).toBe('t')
    expect(psql(dsn, `select count(*) from alembic_version`)).toBe('1')
  }, 300_000)
})
