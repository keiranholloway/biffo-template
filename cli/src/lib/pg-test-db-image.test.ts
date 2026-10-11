/**
 * Engine image selection in `scripts/pg-test-db.sh`: plain DDL gets
 * `postgres:16`, PostGIS DDL gets the PostGIS image, `vector` DDL gets
 * pgvector, DDL asking for both fails naming `BIFFO_PG_IMAGE`, and
 * `BIFFO_PG_IMAGE` overrides every case.
 *
 * Drives the real script with a fake `docker` and a `psql` that always fails,
 * so the script reaches container creation and says which image it picked.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/pg-test-db.sh')

function run(ddl: string, env: Record<string, string> = {}) {
  const dir = makeTmpDir('biffo-pg-image')
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'db/imports/app'), { recursive: true })
  writeFileSync(join(dir, 'db/imports/app/schema.sql'), ddl)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'docker'), 0o755)
  chmodSync(join(bin, 'psql'), 0o755)
  const result = spawnSync('sh', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BIFFO_REPO_ROOT: dir,
      BIFFO_PG_READY_SECS: '0',
      BIFFO_PG_IMAGE: '',
      ...env,
    },
  })
  return { said: String(result.stderr ?? ''), status: result.status }
}

const PLAIN = 'CREATE TABLE t (id int);\n'
const POSTGIS = 'CREATE EXTENSION IF NOT EXISTS postgis;\n' + PLAIN
const VECTOR = 'CREATE EXTENSION IF NOT EXISTS vector;\n' + PLAIN
const BOTH = POSTGIS + VECTOR

describe('pg-test-db.sh engine image', () => {
  it('picks postgres:16 for plain DDL', () => {
    expect(run(PLAIN).said).toContain('(postgres:16)')
  })
  it('picks the PostGIS image for PostGIS DDL', () => {
    expect(run(POSTGIS).said).toContain('(postgis/postgis:16-3.4)')
  })
  it('picks pgvector/pgvector:pg16 for vector DDL', () => {
    expect(run(VECTOR).said).toContain('(pgvector/pgvector:pg16)')
  })
  it('does not match vector as a prefix of another extension name', () => {
    expect(run('CREATE EXTENSION vectorscale;\n').said).toContain('(postgres:16)')
  })
  it('fails naming BIFFO_PG_IMAGE when DDL asks for both', () => {
    const r = run(BOTH)
    expect(r.status).not.toBe(0)
    expect(r.said).toContain('BIFFO_PG_IMAGE')
    expect(r.said).not.toContain('creating container')
  })
  it.each([
    ['plain', PLAIN],
    ['postgis', POSTGIS],
    ['vector', VECTOR],
    ['both', BOTH],
  ])('BIFFO_PG_IMAGE overrides the %s case', (_n, ddl) => {
    const r = run(ddl, { BIFFO_PG_IMAGE: 'example/custom:1' })
    expect(r.said).toContain('(example/custom:1)')
  })
})
