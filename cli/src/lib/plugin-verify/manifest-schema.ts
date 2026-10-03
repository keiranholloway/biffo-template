import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandRunner } from '../plugin-compose/command-runner.js'

/**
 * Builds the test schema for a plugin from `biffo.plugin.json`'s declared `tables`
 * (biffo-template owner decision, 2026-09-30).
 *
 * A plugin repo has no `db/imports/` and no `alembic.ini`: its tables are declared in
 * the manifest, and production turns them into an Alembic migration with
 * `services/api/scripts/generate_plugin_migrations.py` (via `biffo plugin install` /
 * `sync-migrations`). This calls that SAME script -- deliberately no second
 * manifest-to-DDL path in TypeScript, since two generators could drift apart -- into a
 * scratch Alembic directory that `pg-test-db.sh` then upgrades to head.
 */

const MANIFEST = 'biffo.plugin.json'

/** True when `pg-test-db.sh` would find a schema in `cwd` on its own. */
export function hasNativeSchema(cwd: string): boolean {
  if (
    existsSync(join(cwd, 'alembic.ini')) ||
    existsSync(join(cwd, 'services', 'api', 'alembic.ini'))
  ) {
    return true
  }
  const imports = join(cwd, 'db', 'imports')
  if (!existsSync(imports)) return false
  return readdirSync(imports, { withFileTypes: true }).some(
    (d) => d.isDirectory() && readdirSync(join(imports, d.name)).some((f) => f.endsWith('.sql')),
  )
}

/** Env for `pg-test-db.sh` that points it at the generated schema. */
/** Version table of the scratch chain; never Core's `alembic_version`. */
export const PLUGIN_VERSION_TABLE = 'alembic_version_plugin_manifest'

export interface ManifestSchema {
  env: Record<string, string>
}

/**
 * Returns the env that makes `pg-test-db.sh` build the manifest's tables, `null` when
 * the manifest declares none, or throws with an actionable message.
 */
export function buildManifestSchema(
  runner: CommandRunner,
  pluginRoot: string,
  coreRoot: string,
): ManifestSchema | null {
  const manifestPath = join(pluginRoot, MANIFEST)
  if (!existsSync(manifestPath)) return null
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string
    tables?: unknown[]
  }
  if (!manifest.name || !Array.isArray(manifest.tables) || manifest.tables.length === 0) return null

  // The directory name must contain "alembic": pg-test-db.sh fingerprints only
  // `*.py` files whose path does, and that fingerprint is what tells it the schema changed.
  const scratch = mkdtempSync(join(tmpdir(), 'biffo-plugin-verify-alembic-'))
  const versions = join(scratch, 'migrations', 'versions')
  const serviceDir = join(scratch, 'services', manifest.name)
  mkdirSync(versions, { recursive: true })
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, MANIFEST), readFileSync(manifestPath), { mode: 0o600 })
  writeFileSync(join(scratch, 'alembic.ini'), '[alembic]\nscript_location = migrations\n', {
    mode: 0o600,
  })
  writeFileSync(join(scratch, 'migrations', 'env.py'), ENV_PY, { mode: 0o600 })

  const coreApi = join(coreRoot, 'services', 'api')
  const generator = join(coreApi, 'scripts', 'generate_plugin_migrations.py')
  if (!existsSync(generator)) {
    throw new Error(`Core at ${coreRoot} has no ${generator} to build the plugin schema with`)
  }
  const { status } = runner.run(
    'uv',
    [
      'run',
      '--project',
      coreApi,
      'python',
      generator,
      '--services-root',
      join(scratch, 'services'),
      '--versions-dir',
      versions,
      '--plugin',
      manifest.name,
    ],
    { cwd: coreApi, captureStdout: false },
  )
  if (status !== 0) {
    throw new Error(`the plugin migration generator exited ${status}`)
  }
  if (!readdirSync(versions).some((f) => f.endsWith('.py'))) {
    throw new Error('the plugin migration generator produced no migration for the declared tables')
  }

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.BIFFO_REPO_ROOT = pluginRoot
  env.BIFFO_PG_ALEMBIC_DIR = scratch
  env.BIFFO_PG_ALEMBIC_PROJECT = coreApi
  return { env }
}

/** Alembic env for the scratch chain: no models, just the generated migrations. */
const ENV_PY = `import asyncio
import os

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine


PLUGIN_VERSION_TABLE = "alembic_version_plugin_manifest"


async def run() -> None:
    engine = create_async_engine(os.environ["BIFFO_DATABASE_URL"])
    async with engine.connect() as connection:
        await connection.run_sync(lambda c: context.configure(
            connection=c,
            target_metadata=None,
            # Own version table: the default \`alembic_version\` is Core's, and a plugin-only
            # revision recorded there makes Core's own migrations look applied (or fail on
            # an unknown head) when Core boots, leaving its tables (users, ...) missing.
            version_table=PLUGIN_VERSION_TABLE,
        )
    )
        async with connection.begin():
            await connection.run_sync(lambda _: context.run_migrations())
    await engine.dispose()


asyncio.run(run())
`
