import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCoreManifest } from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'
import {
  MIGRATIONS_VERSIONS_DIR,
  applyMigrationCarry,
  migrationBodyHash,
  parseCarriedFrom,
  stampCarriedFrom,
  parseMigration,
  planMigrationCarry,
  readMigrations,
  rechainMigration,
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

/**
 * Migration identity (#366).
 *
 * The carry used to decide "have I already carried this?" by filename alone,
 * which is defeated by exactly the thing instances are pushed into doing: a
 * revision-id collision forces the carried copy to be re-issued, so the instance
 * renames the file to match its new id. Same content, already applied — but the
 * next upgrade no longer recognises it and re-issues the migration, running
 * `op.create_table(...)` against a database that already has those tables.
 *
 * `db-init` runs `command.upgrade(cfg, "head")` on every deploy, so that lands
 * as a failed production deploy rather than a caught mistake.
 */
describe('planMigrationCarry — recognising an already-carried migration', () => {
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

  const write = (root: string, file: string, content: string): void =>
    writeFileSync(join(root, MIGRATIONS_VERSIONS_DIR, file), content)

  const ddl = (table: string) => `op.create_table("${table}")`

  /** The exact #366 scenario, reproduced. */
  it('does not re-issue a carried migration the instance renamed', () => {
    write(templateDir, '0003_create_orchestration_tables.py', migration('0003', null, ddl('orch')))

    // The instance already used 0003, so its copy was re-issued and renamed to
    // match — byte-identical DDL, applied, under a different filename.
    write(instanceDir, '0001_own.py', migration('0001', null, ddl('own')))
    write(
      instanceDir,
      '0007_create_orchestration_tables.py',
      migration('0007', '0001', ddl('orch')),
    )

    const plan = planMigrationCarry({ templateDir, instanceDir })

    // Before the fix this planned 1 entry: CREATE TABLE against a live database.
    expect(plan.entries).toEqual([])
    expect(plan.skipped).toEqual(['0003_create_orchestration_tables.py'])
    expect(plan.recognised).toEqual([
      {
        file: '0003_create_orchestration_tables.py',
        instanceFile: '0007_create_orchestration_tables.py',
        how: 'body',
      },
    ])
  })

  it('stamps provenance on carry, so the next upgrade needs no inference', () => {
    write(templateDir, '0003_orchestration.py', migration('0003', null, ddl('orch')))
    write(instanceDir, '0003_mine.py', migration('0003', null, ddl('mine')))

    const first = planMigrationCarry({ templateDir, instanceDir })
    expect(first.entries).toHaveLength(1)
    // The id collided, so it was re-issued — the situation that leads to a rename.
    expect(first.entries[0]?.reissuedFrom).toBe('0003')
    expect(first.entries[0]?.content).toContain('# biffo:carried-from: 0003_orchestration.py')
    applyMigrationCarry(instanceDir, first)

    // Now rename it AND edit it, defeating both filename and body matching.
    const carried = join(instanceDir, MIGRATIONS_VERSIONS_DIR, '0003_orchestration.py')
    const renamed = join(instanceDir, MIGRATIONS_VERSIONS_DIR, '0009_orchestration.py')
    renameSync(carried, renamed)
    writeFileSync(renamed, `${readFileSync(renamed, 'utf8')}\n# a later local tweak\n`)

    const second = planMigrationCarry({ templateDir, instanceDir })
    expect(second.entries).toEqual([])
    expect(second.recognised[0]?.how).toBe('provenance')
  })

  it('stamping is idempotent, so a resumed upgrade cannot double-stamp', () => {
    const once = stampCarriedFrom(migration('0003', null, ddl('x')), '0003_a.py')
    expect(stampCarriedFrom(once, '0003_a.py')).toBe(once)
    expect(once.match(/# biffo:carried-from:/g)).toHaveLength(1)
  })

  /**
   * The residual ambiguity, and the one case where stopping is the answer. It
   * looks like a carried migration that was renamed *and* edited, but it could
   * equally be an unrelated instance migration describing the same thing.
   * Skipping leaves the instance with models and no schema; carrying runs DDL
   * against a live database. Neither is guessable, so it refuses.
   */
  it('refuses rather than guess when the description matches but the body does not', () => {
    write(templateDir, '0003_create_orchestration_tables.py', migration('0003', null, ddl('orch')))
    write(
      instanceDir,
      '0007_create_orchestration_tables.py',
      migration('0007', null, ddl('something_else')),
    )

    expect(() => planMigrationCarry({ templateDir, instanceDir })).toThrow(
      /Refusing to guess[\s\S]*biffo:carried-from: 0003_create_orchestration_tables\.py/,
    )
  })

  it('the refusal is resolvable by stamping the marker the message asks for', () => {
    write(templateDir, '0003_create_orchestration_tables.py', migration('0003', null, ddl('orch')))
    const instanceFile = '0007_create_orchestration_tables.py'
    write(instanceDir, instanceFile, migration('0007', null, ddl('something_else')))
    expect(() => planMigrationCarry({ templateDir, instanceDir })).toThrow()

    const path = join(instanceDir, MIGRATIONS_VERSIONS_DIR, instanceFile)
    writeFileSync(
      path,
      stampCarriedFrom(readFileSync(path, 'utf8'), '0003_create_orchestration_tables.py'),
    )

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.entries).toEqual([])
    expect(plan.recognised[0]?.how).toBe('provenance')
  })

  /**
   * Body identity is evidence only when the body discriminates. Two no-op
   * migrations share one, and treating that as "already carried" would silently
   * skip a migration the instance needs — models with no schema, which fails at
   * runtime rather than at upgrade time.
   */
  it('does not treat an indistinct body as evidence', () => {
    write(templateDir, '0001_a.py', migration('0001', null))
    write(templateDir, '0002_b.py', migration('0002', '0001'))
    write(instanceDir, '0009_unrelated.py', migration('0009', null))

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.entries.map((e) => e.file)).toEqual(['0001_a.py', '0002_b.py'])
    expect(plan.recognised).toEqual([])
  })

  /**
   * The realistic shape of a renamed carry, and the case that motivated
   * ignoring prose: an instance forced to renumber a carried migration
   * documents why, in the docstring. Every carried migration in
   * `tabsii-platform` is DDL-identical to the template's and differs only in
   * that explanation. Treating it as a different migration penalised precisely
   * the operators who documented their divergence.
   */
  it('an instance annotating a carried migration is not a difference', () => {
    const template = migration('0003', '0002', ddl('orch'))
    const annotated = template.replace(
      'a migration',
      'a migration\n\nPorted from the template and re-chained onto our head, because revision\nid "0003" was already taken here.',
    )
    expect(migrationBodyHash(annotated)).toBe(migrationBodyHash(template))
  })

  it('a whole-line comment is commentary too', () => {
    const template = migration('0003', null, ddl('orch'))
    const commented = template.replace('def upgrade', '# ported by hand, see #366\ndef upgrade')
    expect(migrationBodyHash(commented)).toBe(migrationBodyHash(template))
  })

  it('negative control: a real DDL change IS a difference', () => {
    // Ignoring prose must not slide into ignoring schema — otherwise the
    // comparison would call every migration the same and skip them all.
    expect(migrationBodyHash(migration('0003', null, ddl('orch')))).not.toBe(
      migrationBodyHash(migration('0003', null, ddl('something_else'))),
    )
  })

  it('recognises a renamed carry whose only difference is its annotation', () => {
    write(templateDir, '0003_create_orchestration_tables.py', migration('0003', null, ddl('orch')))
    write(instanceDir, '0001_own.py', migration('0001', null, ddl('own')))
    write(
      instanceDir,
      '0007_create_orchestration_tables.py',
      migration('0007', '0001', ddl('orch')).replace(
        'a migration',
        'a migration\n\nRenumbered on carry; the id 0003 was taken.',
      ),
    )

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.entries).toEqual([])
    expect(plan.recognised[0]?.how).toBe('body')
  })

  it('a base migration hashes like any other — empty Revises is not a difference', () => {
    // `Revises: ` on a base migration is chaining metadata, not DDL. Leaving it
    // in gave every base migration a hash of its own, which made an indistinct
    // body look distinct and re-enabled the false match this guards.
    const base = migration('0001', null, ddl('thing'))
    const chained = migration('0007', '0006', ddl('thing'))
    expect(migrationBodyHash(base)).toBe(migrationBodyHash(chained))
  })

  it('a file already claimed by another template migration is not an ambiguous match', () => {
    write(templateDir, '0003_tables.py', migration('0003', null, ddl('a')))
    write(templateDir, '0004_tables.py', migration('0004', '0003', ddl('b')))
    // The instance's copy of 0003 — same slug as 0004, but it says what it is.
    write(
      instanceDir,
      '0009_tables.py',
      stampCarriedFrom(migration('0009', null, ddl('a')), '0003_tables.py'),
    )

    const plan = planMigrationCarry({ templateDir, instanceDir })
    expect(plan.skipped).toEqual(['0003_tables.py'])
    expect(plan.entries.map((e) => e.file)).toEqual(['0004_tables.py'])
  })

  it('provenance survives a renumber that also changes the revision id', () => {
    const carried = stampCarriedFrom(migration('core_abc12345', '0009', ddl('x')), '0003_x.py')
    expect(parseCarriedFrom(carried)).toBe('0003_x.py')
    // ...and re-chaining does not disturb it.
    expect(parseCarriedFrom(rechainMigration(carried, '0012', '0011'))).toBe('0003_x.py')
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
