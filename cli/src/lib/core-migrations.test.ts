import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCoreManifest } from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'
import {
  MIGRATIONS_VERSIONS_DIR,
  applyMigrationCarry,
  findMigrationTestPairings,
  migrationBodyHash,
  parseBodyChangeDeclaration,
  parseCarriedFrom,
  stampCarriedFrom,
  parseMigration,
  planMigrationCarry,
  readMigrations,
  rechainMigration,
  reissuedRevisionId,
  stripPythonDocstrings,
  validateChain,
} from './core-migrations.js'
import { listTemplateOwnedFiles } from './core-manifest.js'
import { makeTmpDir } from '../test-utils/tmp.js'

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
    templateDir = makeTmpDir('tmpl')
    instanceDir = makeTmpDir('inst')
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
    templateDir = makeTmpDir('tmpl')
    instanceDir = makeTmpDir('inst')
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
    templateDir = makeTmpDir('tmpl')
    instanceDir = makeTmpDir('inst')
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

  /**
   * #983. Only the MODULE docstring used to be stripped, so prose on a function
   * inside the migration still counted as schema. That is where #764's paragraph
   * went, and every instance holding migration 0010 was told for ever after that
   * the template had changed it and the change would never reach them — pointing
   * the reader at writing a forward migration for a difference that is not there.
   */
  it('a paragraph added to a FUNCTION docstring is not a difference', () => {
    const guarded = (doc: string) =>
      migration(
        '0010',
        '0009',
        `if _has_users():\n        op.add_column("users", sa.Column("phone", sa.String(32)))\n\n\ndef _has_users() -> bool:\n    """${doc}"""\n    return sa.inspect(op.get_bind()).has_table("users")`,
      )
    expect(migrationBodyHash(guarded('Whether this instance has a Core users table.'))).toBe(
      migrationBodyHash(
        guarded(
          'Whether this instance has a Core users table.\n\n    What that rests on (#764): migrations/env.py passes no connect_args,\n    while api/database.py passes connect_args=_connect_args_for(...).',
        ),
      ),
    )
  })

  it('a class docstring is prose too', () => {
    const withClass = (doc: string) =>
      migration('0003', null, `pass\n\n\nclass _Helper:\n    """${doc}"""\n\n    x = 1`)
    expect(migrationBodyHash(withClass('One line.'))).toBe(migrationBodyHash(withClass('Another.')))
  })

  it('negative control: SQL inside op.execute is substance, not prose', () => {
    // The dangerous over-reach. A triple-quoted string is a docstring only in a
    // docstring POSITION; the block form of op.execute opens one at the start of
    // a line, and stripping it would make two different migrations identical.
    const sql = (table: string) =>
      migration(
        '0003',
        null,
        `op.execute(\n        """\n        CREATE TABLE ${table} (id int);\n        """\n    )`,
      )
    expect(migrationBodyHash(sql('alpha'))).not.toBe(migrationBodyHash(sql('beta')))
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

  // #739. The carry treats an applied migration as immutable — correctly — but
  // the merge engine happily brings in the test asserting its new body. Green
  // upstream, red in every instance that already carried it.
  describe('body drift on an already-carried migration', () => {
    it('flags a template edit to a migration the instance already has', () => {
      write(templateDir, '0001_base.py', migration('0001', null))
      write(templateDir, '0010_orgs.py', migration('0010', '0001', ddl('with_guard')))
      write(instanceDir, '0001_base.py', migration('0001', null))
      write(
        instanceDir,
        '0010_orgs.py',
        stampCarriedFrom(migration('0010', '0001', ddl('no_guard')), '0010_orgs.py'),
      )

      const plan = planMigrationCarry({ templateDir, instanceDir })
      expect(plan.skipped).toContain('0010_orgs.py')

      expect(plan.divergedBodies).toEqual([
        { file: '0010_orgs.py', instanceFile: '0010_orgs.py', how: 'provenance' },
      ])
    })

    it('does not flag a copy that only differs by re-chaining', () => {
      // The common case: the instance's copy was re-chained onto its own head
      // and renumbered. Same DDL, different revision metadata — not drift, and
      // reporting it would train everyone to ignore the warning.
      write(templateDir, '0001_base.py', migration('0001', null))
      write(templateDir, '0010_orgs.py', migration('0010', '0001', ddl('same')))
      write(instanceDir, '0001_base.py', migration('0001', null))
      write(instanceDir, '0013_local.py', migration('0013', '0001'))
      write(
        instanceDir,
        '0014_orgs.py',
        stampCarriedFrom(migration('0014', '0013', ddl('same')), '0010_orgs.py'),
      )

      const plan = planMigrationCarry({ templateDir, instanceDir })

      expect(plan.skipped).toContain('0010_orgs.py')
      expect(plan.divergedBodies).toEqual([])
    })

    it('does not flag a docstring-only edit as a convergence gap (#983)', () => {
      // The reported case, end to end: the instance carried 0010, the template
      // later added a paragraph to a function docstring inside it, and every
      // subsequent upgrade reported a permanent schema divergence that did not
      // exist. Both files produce an identical database.
      const body = (doc: string) =>
        `op.create_table("organizations")\n\n\ndef _has_users() -> bool:\n    """${doc}"""\n    return True`
      write(templateDir, '0001_base.py', migration('0001', null))
      write(
        templateDir,
        '0010_orgs.py',
        migration(
          '0010',
          '0001',
          body(
            'Whether Core owns users here.\n\n    Rests on env.py passing no connect_args (#764).',
          ),
        ),
      )
      write(instanceDir, '0001_base.py', migration('0001', null))
      write(
        instanceDir,
        '0010_orgs.py',
        stampCarriedFrom(
          migration('0010', '0001', body('Whether Core owns users here.')),
          '0010_orgs.py',
        ),
      )

      const plan = planMigrationCarry({ templateDir, instanceDir })
      expect(plan.skipped).toContain('0010_orgs.py')
      expect(plan.divergedBodies).toEqual([])
      // Carried silently: it is not re-issued as a new migration either.
      expect(plan.entries).toEqual([])
    })

    it('reports nothing when the instance has not carried the migration at all', () => {
      write(templateDir, '0010_orgs.py', migration('0010', null, ddl('x')))
      const plan = planMigrationCarry({ templateDir, instanceDir })
      expect(plan.entries.map((e) => e.file)).toEqual(['0010_orgs.py'])
      expect(plan.divergedBodies).toEqual([])
    })

    // #751. A declaration changes what the operator reads, not what the carry
    // does — the file stays exactly as untouched as an undeclared drift.
    describe('a declared classification (#751)', () => {
      it('attaches a replay-safe declaration to the reported drift', () => {
        write(templateDir, '0001_base.py', migration('0001', null))
        write(
          templateDir,
          '0010_orgs.py',
          migration(
            '0010',
            '0001',
            `# biffo:body-change: replay-safe — guards a table Core doesn't always own\n${ddl('with_guard')}`,
          ),
        )
        write(instanceDir, '0001_base.py', migration('0001', null))
        write(
          instanceDir,
          '0010_orgs.py',
          stampCarriedFrom(migration('0010', '0001', ddl('no_guard')), '0010_orgs.py'),
        )

        const plan = planMigrationCarry({ templateDir, instanceDir })

        // Reported exactly as before, plus the declaration — not carried,
        // not re-issued, not written anywhere.
        expect(plan.skipped).toContain('0010_orgs.py')
        expect(plan.entries).toEqual([])
        expect(plan.divergedBodies).toEqual([
          {
            file: '0010_orgs.py',
            instanceFile: '0010_orgs.py',
            how: 'provenance',
            declared: {
              classification: 'replay-safe',
              reason: "guards a table Core doesn't always own",
            },
          },
        ])
      })

      it('attaches an outcome-changing declaration to the reported drift', () => {
        write(templateDir, '0001_base.py', migration('0001', null))
        write(
          templateDir,
          '0010_orgs.py',
          migration(
            '0010',
            '0001',
            `# biffo:body-change: outcome-changing — corrected a wrong column type\n${ddl('with_guard')}`,
          ),
        )
        write(instanceDir, '0001_base.py', migration('0001', null))
        write(
          instanceDir,
          '0010_orgs.py',
          stampCarriedFrom(migration('0010', '0001', ddl('no_guard')), '0010_orgs.py'),
        )

        const plan = planMigrationCarry({ templateDir, instanceDir })

        expect(plan.divergedBodies).toEqual([
          {
            file: '0010_orgs.py',
            instanceFile: '0010_orgs.py',
            how: 'provenance',
            declared: {
              classification: 'outcome-changing',
              reason: 'corrected a wrong column type',
            },
          },
        ])
      })

      it('omits `declared` when nobody has classified the edit', () => {
        write(templateDir, '0001_base.py', migration('0001', null))
        write(templateDir, '0010_orgs.py', migration('0010', '0001', ddl('with_guard')))
        write(instanceDir, '0001_base.py', migration('0001', null))
        write(
          instanceDir,
          '0010_orgs.py',
          stampCarriedFrom(migration('0010', '0001', ddl('no_guard')), '0010_orgs.py'),
        )

        const plan = planMigrationCarry({ templateDir, instanceDir })
        expect(plan.divergedBodies[0]).not.toHaveProperty('declared')
      })

      it('aborts loudly on a malformed marker rather than silently ignoring it', () => {
        write(templateDir, '0001_base.py', migration('0001', null))
        write(
          templateDir,
          '0010_orgs.py',
          migration('0010', '0001', `# biffo:body-change: not-a-real-class\n${ddl('with_guard')}`),
        )
        write(instanceDir, '0001_base.py', migration('0001', null))
        write(
          instanceDir,
          '0010_orgs.py',
          stampCarriedFrom(migration('0010', '0001', ddl('no_guard')), '0010_orgs.py'),
        )

        expect(() => planMigrationCarry({ templateDir, instanceDir })).toThrow(
          /Malformed # biffo:body-change: marker/,
        )
      })
    })
  })

  it('provenance survives a renumber that also changes the revision id', () => {
    const carried = stampCarriedFrom(migration('core_abc12345', '0009', ddl('x')), '0003_x.py')
    expect(parseCarriedFrom(carried)).toBe('0003_x.py')
    // ...and re-chaining does not disturb it.
    expect(parseCarriedFrom(rechainMigration(carried, '0012', '0011'))).toBe('0003_x.py')
  })

  // #735. A migration an instance deliberately did not carry is otherwise
  // indistinguishable from one it has simply not reached yet, so the tool
  // re-offered it on every upgrade — and re-pointed the chain *through* it.
  describe('declined migrations', () => {
    const decline = (
      file: string,
      reason = 'assumes a public.users table this instance dropped',
    ) => ({
      file,
      reason,
    })

    it('does not carry a declined migration, and reports why', () => {
      write(templateDir, '0001_a.py', migration('0001', null))
      write(templateDir, '0010_orgs.py', migration('0010', '0001'))
      write(instanceDir, '0001_a.py', migration('0001', null))

      const plan = planMigrationCarry({
        templateDir,
        instanceDir,
        declined: [{ ...decline('0010_orgs.py'), upstream: 'acme/repo#670' }],
      })

      expect(plan.entries).toEqual([])
      expect(plan.declined).toEqual([
        {
          file: '0010_orgs.py',
          reason: 'assumes a public.users table this instance dropped',
          upstream: 'acme/repo#670',
        },
      ])
      // Not "skipped" — that bucket means "the instance already has it", which
      // is the opposite situation and would read as converged.
      expect(plan.skipped).toEqual(['0001_a.py'])
    })

    // The actual failure in #735: the plan reported 0 conflicts and produced a
    // chain that dies on `alembic upgrade head`, because later migrations were
    // re-pointed through the revision the instance never took.
    it('closes the chain over the gap so later migrations do not revise a missing id', () => {
      write(templateDir, '0001_a.py', migration('0001', null))
      write(templateDir, '0010_orgs.py', migration('0010', '0001'))
      write(templateDir, '0012_agent.py', migration('0012', '0010'))
      write(instanceDir, '0001_a.py', migration('0001', null))
      write(instanceDir, '0011_local.py', migration('0011', '0001'))

      const plan = planMigrationCarry({
        templateDir,
        instanceDir,
        declined: [decline('0010_orgs.py')],
      })

      expect(plan.entries.map((e) => e.file)).toEqual(['0012_agent.py'])
      const [entry] = plan.entries
      // The instance's real head — NOT 0010, which it does not have.
      expect(entry?.downRevision).toBe('0011')
      expect(entry?.content).toContain('down_revision: str | None = "0011"')
      // planMigrationCarry validates the post-carry chain, so a revision
      // pointing at the declined id would have thrown before reaching here.
      expect(plan.entries.every((e) => e.downRevision !== '0010')).toBe(true)
    })

    it('flags a decline that matches no migration in the target template', () => {
      // Either a typo — declining nothing at all, silently — or a decline whose
      // cause was fixed upstream and which should now be deleted.
      write(templateDir, '0001_a.py', migration('0001', null))
      write(instanceDir, '0001_a.py', migration('0001', null))

      const plan = planMigrationCarry({
        templateDir,
        instanceDir,
        declined: [decline('0010_typo.py')],
      })

      expect(plan.staleDeclines).toEqual(['0010_typo.py'])
      expect(plan.declined).toEqual([])
    })

    it('carries normally when nothing is declined', () => {
      write(templateDir, '0001_a.py', migration('0001', null))
      write(templateDir, '0010_orgs.py', migration('0010', '0001'))
      write(instanceDir, '0001_a.py', migration('0001', null))

      const plan = planMigrationCarry({ templateDir, instanceDir, declined: [] })

      expect(plan.entries.map((e) => e.file)).toEqual(['0010_orgs.py'])
      expect(plan.declined).toEqual([])
      expect(plan.staleDeclines).toEqual([])
    })
  })
})

describe('parseBodyChangeDeclaration (#751)', () => {
  it('returns null when the migration carries no declaration', () => {
    expect(parseBodyChangeDeclaration(migration('0010', '0001', 'pass'))).toBeNull()
  })

  it('parses a replay-safe declaration, whatever its indentation', () => {
    const content = migration(
      '0010',
      '0001',
      '# biffo:body-change: replay-safe — no-op against an already-migrated database\npass',
    )
    expect(parseBodyChangeDeclaration(content)).toEqual({
      classification: 'replay-safe',
      reason: 'no-op against an already-migrated database',
    })
  })

  it('parses an outcome-changing declaration', () => {
    const content = migration(
      '0010',
      '0001',
      '# biffo:body-change: outcome-changing — fixes a wrong default value\npass',
    )
    expect(parseBodyChangeDeclaration(content)).toEqual({
      classification: 'outcome-changing',
      reason: 'fixes a wrong default value',
    })
  })

  it('accepts a plain colon separator, not only an em dash', () => {
    expect(
      parseBodyChangeDeclaration('# biffo:body-change: replay-safe: idempotent guard\n'),
    ).toEqual({ classification: 'replay-safe', reason: 'idempotent guard' })
  })

  it('throws on an unrecognised classification word', () => {
    expect(() =>
      parseBodyChangeDeclaration('# biffo:body-change: sort-of-safe — a reason\n'),
    ).toThrow(/Malformed # biffo:body-change: marker/)
  })

  it('throws when the marker has a classification but no reason', () => {
    expect(() => parseBodyChangeDeclaration('# biffo:body-change: replay-safe\n')).toThrow(
      /Malformed # biffo:body-change: marker/,
    )
  })
})

describe('findMigrationTestPairings (#739)', () => {
  // The real case, named as it actually occurred: the test and the migration
  // share only a revision prefix, and the test reads the migration by full
  // filename. Filename-convention matching would miss this entirely.
  const MIGRATION = '0010_add_organizations_and_user_profile_fields.py'
  const TEST_PATH = 'services/api/tests/test_migration_0010_optional_users.py'
  const diverged = [{ file: MIGRATION, instanceFile: MIGRATION, how: 'provenance' as const }]

  const testBody = `source = (_REAL_VERSIONS / "${MIGRATION}").read_text()`

  it('pairs an arriving test with the migration body it will not receive', () => {
    const pairings = findMigrationTestPairings([{ path: TEST_PATH, content: testBody }], diverged)
    expect(pairings).toEqual([
      { testPath: TEST_PATH, migration: MIGRATION, instanceFile: MIGRATION },
    ])
  })

  it('ignores an arriving test that does not name a diverged migration', () => {
    const pairings = findMigrationTestPairings(
      [{ path: 'services/api/tests/test_auth.py', content: 'assert True' }],
      diverged,
    )
    expect(pairings).toEqual([])
  })

  it('ignores non-test files that happen to mention the migration', () => {
    // The upgrade legitimately carries the migration's own docs and the chain
    // itself; only an arriving *test* predicts a red CI run.
    const pairings = findMigrationTestPairings(
      [
        { path: 'docs/guides/core-upgrade.md', content: `see ${MIGRATION}` },
        { path: `services/api/migrations/versions/${MIGRATION}`, content: 'op.create_table("x")' },
      ],
      diverged,
    )
    expect(pairings).toEqual([])
  })

  it('reports nothing when no migration body has diverged', () => {
    // The overwhelmingly common case — this must stay silent, or the warning
    // becomes noise everyone learns to skip past.
    expect(findMigrationTestPairings([{ path: TEST_PATH, content: testBody }], [])).toEqual([])
  })

  it('skips entries with no resolved content (keep-ours / removed)', () => {
    expect(findMigrationTestPairings([{ path: TEST_PATH, content: undefined }], diverged)).toEqual(
      [],
    )
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
    const instanceDir = makeTmpDir('fresh')
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

describe('stripPythonDocstrings (#983)', () => {
  it('drops a module docstring', () => {
    expect(stripPythonDocstrings('"""Doc."""\nimport os\n').trim()).toBe('import os')
  })

  it('drops a module docstring preceded by a shebang and comments', () => {
    // The old regex anchored at the start of the file, so a leading comment
    // hid the docstring from it entirely.
    const out = stripPythonDocstrings('#!/usr/bin/env python\n# note\n"""Doc."""\nimport os\n')
    expect(out).not.toContain('Doc.')
    expect(out).toContain('import os')
  })

  it('drops a function docstring, one-line or multi-line', () => {
    expect(stripPythonDocstrings('def f():\n    """One."""\n    return 1\n')).toBe(
      'def f():\n    return 1\n',
    )
    expect(
      stripPythonDocstrings('def f():\n    """One.\n\n    Two.\n    """\n    return 1\n'),
    ).toBe('def f():\n    return 1\n')
  })

  it('drops a docstring after a multi-line signature', () => {
    const src = 'def f(\n    x: int,\n) -> bool:\n    """Doc."""\n    return True\n'
    expect(stripPythonDocstrings(src)).toBe('def f(\n    x: int,\n) -> bool:\n    return True\n')
  })

  it('drops a class docstring and its methods’ docstrings', () => {
    const out = stripPythonDocstrings(
      'class A:\n    """C."""\n\n    def m(self):\n        """M."""\n        return 1\n',
    )
    expect(out).not.toContain('"""')
    expect(out).toContain('def m(self):')
  })

  it('drops a docstring separated from its header by a comment', () => {
    const out = stripPythonDocstrings('def f():\n    # why\n    """Doc."""\n    return 1\n')
    expect(out).not.toContain('Doc.')
  })

  it('KEEPS a triple-quoted string that is not in a docstring position', () => {
    // The whole safety of this: `op.execute("""...""")` in block form opens a
    // triple quote at the start of a line, and it is DDL.
    const src =
      'def upgrade() -> None:\n    """Doc."""\n    op.execute(\n        """\n        CREATE TABLE t (id int);\n        """\n    )\n'
    const out = stripPythonDocstrings(src)
    expect(out).not.toContain('Doc.')
    expect(out).toContain('CREATE TABLE t (id int);')
  })

  it('KEEPS a triple-quoted assignment, which is a value not a docstring', () => {
    const src =
      'def upgrade() -> None:\n    sql = (\n        """\n        SELECT 1;\n        """\n    )\n    op.execute(sql)\n'
    expect(stripPythonDocstrings(src)).toContain('SELECT 1;')
  })

  it('handles single-quoted triple strings the same way', () => {
    expect(stripPythonDocstrings("def f():\n    '''Doc.'''\n    return 1\n")).toBe(
      'def f():\n    return 1\n',
    )
  })

  it('leaves source with no docstrings untouched', () => {
    const src = 'import os\n\n\ndef f():\n    return os.sep\n'
    expect(stripPythonDocstrings(src)).toBe(src)
  })
})
