import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCoreManifest } from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'
import {
  MIGRATIONS_VERSIONS_DIR,
  applyMigrationCarry,
  parseMigration,
  planMigrationCarry,
  readMigrations,
  reissuedRevisionId,
  validateChain,
} from './core-migrations.js'
import { listTemplateOwnedFiles } from './core-manifest.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function migration(revision: string, down: string | null, body = 'pass'): string {
  return `"""a migration

Revision ID: ${revision}
Revises: ${down ?? ''}
Create Date: 2026-07-19

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "${revision}"
down_revision: str | None = ${down === null ? 'None' : `"${down}"`}
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    ${body}


def downgrade() -> None:
    pass
`
}

describe('parseMigration', () => {
  it('parses revision and down_revision literals', () => {
    const m = parseMigration('0002_x.py', migration('0002', '0001'))
    expect(m.revision).toBe('0002')
    expect(m.downRevision).toBe('0001')
  })

  it('parses a base migration with down_revision None', () => {
    expect(parseMigration('0001_x.py', migration('0001', null)).downRevision).toBeNull()
  })

  it('throws when the revision assignment is missing', () => {
    expect(() => parseMigration('broken.py', 'down_revision = None\n')).toThrow(
      /could not find a module-level 'revision/,
    )
  })

  it('throws on a computed (non-literal) revision id rather than guessing', () => {
    expect(() =>
      parseMigration('computed.py', 'revision = compute()\ndown_revision = None\n'),
    ).toThrow(/Unsupported revision literal/)
  })
})

describe('validateChain', () => {
  const m = (file: string, rev: string, down: string | null) => ({
    file,
    revision: rev,
    downRevision: down,
    content: '',
  })

  it('returns the single head', () => {
    expect(validateChain([m('a.py', '1', null), m('b.py', '2', '1')], 'x')).toBe('2')
  })

  it('returns null for an empty chain', () => {
    expect(validateChain([], 'x')).toBeNull()
  })

  it('rejects two heads', () => {
    expect(() =>
      validateChain([m('a.py', '1', null), m('b.py', '2', '1'), m('c.py', '3', '1')], 'x'),
    ).toThrow(/2 heads/)
  })

  it('rejects a duplicate revision id', () => {
    expect(() => validateChain([m('a.py', '1', null), m('b.py', '1', null)], 'x')).toThrow(
      /duplicate revision id/,
    )
  })

  it('rejects a dangling down_revision', () => {
    expect(() => validateChain([m('a.py', '1', null), m('b.py', '2', 'gone')], 'x')).toThrow(
      /which no migration defines/,
    )
  })

  it('rejects a chain with no base', () => {
    expect(() => validateChain([m('a.py', '1', '2'), m('b.py', '2', '1')], 'x')).toThrow(
      /no base migration/,
    )
  })
})

describe('planMigrationCarry', () => {
  let templateDir: string
  let instanceDir: string

  beforeEach(() => {
    templateDir = mkdtempSync(join(tmpdir(), 'tmpl-'))
    instanceDir = mkdtempSync(join(tmpdir(), 'inst-'))
    for (const d of [templateDir, instanceDir]) {
      mkdirSync(join(d, MIGRATIONS_VERSIONS_DIR), { recursive: true })
    }
  })
  afterEach(() => {
    for (const d of [templateDir, instanceDir]) rmSync(d, { recursive: true, force: true })
  })

  function write(root: string, file: string, content: string): void {
    writeFileSync(join(root, MIGRATIONS_VERSIONS_DIR, file), content)
  }

  it('carries nothing when the instance already has every template migration', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0001_a.py', migration('0001', null))
    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.entries).toEqual([])
    expect(plan.skipped).toEqual(['0001_a.py'])
  })

  it('appends a new core migration onto the instance head instead of the template parent', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(templateDir, '0002_b.py', migration('0002', '0001'))
    write(instanceDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0009_local.py', migration('0009', '0001'))

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.instanceHead).toBe('0009')
    expect(plan.entries).toHaveLength(1)
    const [entry] = plan.entries
    expect(entry?.file).toBe('0002_b.py')
    // Re-chained onto the instance's head, not the template's 0001.
    expect(entry?.downRevision).toBe('0009')
    expect(entry?.revision).toBe('0002')
    expect(entry?.content).toContain('down_revision: str | None = "0009"')
    expect(entry?.content).toContain('Revises: 0009')
  })

  it('re-issues a revision id that the instance already uses (the #198 collision)', () => {
    // Template's orchestration migration is 0003; the instance already has a
    // *different* 0003 and its head is 0006 — exactly the reported case.
    write(templateDir, '0001_a.py', migration('0001', null))
    write(templateDir, '0003_orchestration.py', migration('0003', '0001'))
    write(instanceDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0003_instance_thing.py', migration('0003', '0001'))
    write(instanceDir, '0006_more.py', migration('0006', '0003'))

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.entries).toHaveLength(1)
    const [entry] = plan.entries
    expect(entry?.reissuedFrom).toBe('0003')
    expect(entry?.revision).toBe(reissuedRevisionId('0003_orchestration.py'))
    expect(entry?.revision).toMatch(/^core_[0-9a-f]{8}$/)
    expect(entry?.downRevision).toBe('0006')
    expect(entry?.content).toContain(`revision: str = "${entry?.revision}"`)
  })

  it('chains multiple carried migrations onto each other, in template chain order', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(templateDir, '0002_b.py', migration('0002', '0001'))
    write(templateDir, '0003_c.py', migration('0003', '0002'))
    write(instanceDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0005_local.py', migration('0005', '0001'))

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.entries.map((e) => e.file)).toEqual(['0002_b.py', '0003_c.py'])
    expect(plan.entries.map((e) => e.downRevision)).toEqual(['0005', '0002'])
  })

  it('carries the whole template chain into an instance with no migrations at all', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(templateDir, '0002_b.py', migration('0002', '0001'))
    rmSync(join(instanceDir, MIGRATIONS_VERSIONS_DIR), { recursive: true })

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.instanceHead).toBeNull()
    expect(plan.entries.map((e) => e.downRevision)).toEqual([null, '0001'])
    expect(plan.entries[0]?.content).toContain('down_revision: str | None = None')
  })

  it('is idempotent — re-running after a carry plans nothing new', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(templateDir, '0003_orch.py', migration('0003', '0001'))
    write(instanceDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0003_local.py', migration('0003', '0001'))

    const first = planMigrationCarry({ templateDir, instanceDir })
    applyMigrationCarry(instanceDir, first)
    const second = planMigrationCarry({ templateDir, instanceDir })
    expect(second.entries).toEqual([])
    expect(second.skipped).toContain('0003_orch.py')
  })

  it('aborts loudly when the instance chain is already broken', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0001_a.py', migration('0001', null))
    write(instanceDir, '0002_forked.py', migration('0002', '0001'))
    write(instanceDir, '0003_forked.py', migration('0003', '0001'))

    expect(() => planMigrationCarry({ templateDir, instanceDir })).toThrow(/2 heads/)
  })

  it('writes nothing while planning', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    planMigrationCarry({ templateDir, instanceDir })
    expect(existsSync(join(instanceDir, MIGRATIONS_VERSIONS_DIR, '0001_a.py'))).toBe(false)
  })
})

describe('applyMigrationCarry', () => {
  let templateDir: string
  let instanceDir: string

  beforeEach(() => {
    templateDir = mkdtempSync(join(tmpdir(), 'tmpl-'))
    instanceDir = mkdtempSync(join(tmpdir(), 'inst-'))
    mkdirSync(join(templateDir, MIGRATIONS_VERSIONS_DIR), { recursive: true })
  })
  afterEach(() => {
    for (const d of [templateDir, instanceDir]) rmSync(d, { recursive: true, force: true })
  })

  it('writes carried migrations and leaves a valid single-head chain', () => {
    writeFileSync(
      join(templateDir, MIGRATIONS_VERSIONS_DIR, '0001_a.py'),
      migration('0001', null, 'op.create_table("thing")'),
    )
    writeFileSync(
      join(templateDir, MIGRATIONS_VERSIONS_DIR, '0002_b.py'),
      migration('0002', '0001'),
    )

    const plan = planMigrationCarry({ templateDir, instanceDir })
    const written = applyMigrationCarry(instanceDir, plan)
    expect(written).toEqual([
      `${MIGRATIONS_VERSIONS_DIR}/0001_a.py`,
      `${MIGRATIONS_VERSIONS_DIR}/0002_b.py`,
    ])
    // DDL is carried verbatim; only the chaining is rewritten.
    expect(readFileSync(join(instanceDir, MIGRATIONS_VERSIONS_DIR, '0001_a.py'), 'utf8')).toContain(
      'op.create_table("thing")',
    )
    expect(validateChain(readMigrations(join(instanceDir, MIGRATIONS_VERSIONS_DIR)), 'x')).toBe(
      '0002',
    )
  })

  it('refuses to overwrite an existing migration', () => {
    writeFileSync(join(templateDir, MIGRATIONS_VERSIONS_DIR, '0001_a.py'), migration('0001', null))
    const plan = planMigrationCarry({ templateDir, instanceDir })
    applyMigrationCarry(instanceDir, plan)
    expect(() => applyMigrationCarry(instanceDir, plan)).toThrow(/Refusing to overwrite/)
  })
})

// Skipped in an instance (issue #327). services/api/migrations/versions/ is
// user-owned (carved out of the merge engine — see core-manifest.json), and this
// test file ships in the template-owned cli/, so it reaches every instance. Run
// against the instance's own migration chain it would assert single-head over
// user-owned instance data — a branch there is the instance's Alembic problem to
// resolve, not a signal a template-shipped gate should red on.
const runningInInstance = isInstanceRepo(repoRoot)

describe.skipIf(runningInInstance)('the real template', () => {
  it('ships a valid, single-head core migration chain', () => {
    const head = validateChain(readMigrations(join(repoRoot, MIGRATIONS_VERSIONS_DIR)), 'template')
    expect(head).toBeTruthy()
  })

  it('keeps migrations/versions out of the merge engine (they are carried, not merged)', () => {
    const manifest = readCoreManifest(repoRoot)
    const merged = listTemplateOwnedFiles(repoRoot, manifest)
    expect(merged.some((f) => f.startsWith(`${MIGRATIONS_VERSIONS_DIR}/`))).toBe(false)
    // …while the framework around them stays template-owned and merged.
    expect(merged).toContain('services/api/migrations/env.py')
  })

  it('carries every core migration into a fresh instance', () => {
    const instanceDir = mkdtempSync(join(tmpdir(), 'fresh-'))
    try {
      const plan = planMigrationCarry({ templateDir: repoRoot, instanceDir })
      const templateFiles = readMigrations(join(repoRoot, MIGRATIONS_VERSIONS_DIR)).map(
        (m) => m.file,
      )
      expect(plan.entries.map((e) => e.file).sort()).toEqual([...templateFiles].sort())
    } finally {
      rmSync(instanceDir, { recursive: true, force: true })
    }
  })
})
