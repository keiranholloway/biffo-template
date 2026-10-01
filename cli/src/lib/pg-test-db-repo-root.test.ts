/**
 * Regression: `pg-test-db.sh` must build the schema of the repo it is CALLED FROM,
 * not of the directory it happens to be installed in.
 *
 * It used to derive its repo root from its own location. In a template checkout that
 * is the template; in the published `@biffo/cli` it is the npm package directory, so
 * `biffo plugin verify` in every plugin repo died with "no db/imports/*\/ DDL and no
 * alembic.ini". This runs the real script from a copy placed in an unrelated "package"
 * directory, with a fake `psql`/`docker` recording what it was asked to apply.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  'scripts/pg-test-db.sh',
)

function setup() {
  const root = makeTmpDir('pg-test-db-root')
  const pkg = join(root, 'pkg')
  mkdirSync(join(pkg, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(pkg, 'scripts', 'pg-test-db.sh'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const calls = join(root, 'calls')
  for (const tool of ['psql', 'docker']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 0\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'db', 'imports', 'mod'), { recursive: true })
  writeFileSync(join(repo, 'db', 'imports', 'mod', 'schema.sql'), 'CREATE TABLE t (i int);\n')
  const run = (cwd: string, extraEnv: Record<string, string> = {}) =>
    spawnSync('sh', [join(pkg, 'scripts', 'pg-test-db.sh')], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BIFFO_PG_REAP_HOURS: '0',
        ...extraEnv,
      },
    })
  const psqlCalls = () => {
    try {
      return readFileSync(calls, 'utf8')
    } catch {
      return ''
    }
  }
  return { repo, root, run, psqlCalls }
}

describe('pg-test-db.sh repo root', () => {
  it('builds the schema found in the caller directory, not the script package', () => {
    const { repo, run, psqlCalls } = setup()
    const result = run(repo)
    expect(result.stderr).not.toContain('no schema to build')
    expect(result.status).toBe(0)
    expect(psqlCalls()).toContain('-f db/imports/mod/schema.sql')
  })

  it('honours BIFFO_REPO_ROOT over the working directory', () => {
    const { repo, root, run, psqlCalls } = setup()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const result = run(elsewhere, { BIFFO_REPO_ROOT: repo })
    expect(result.status).toBe(0)
    expect(psqlCalls()).toContain('-f db/imports/mod/schema.sql')
  })
})
