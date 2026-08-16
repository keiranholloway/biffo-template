import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkMigrationBodyChangeMarkers,
  type MigrationBodyChangeDiff,
} from './migration-body-change-guard.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function migration(body: string): string {
  return `"""a migration

Revision ID: abc
Revises:
Create Date: 2026-07-19

"""

from alembic import op
import sqlalchemy as sa

revision = "abc"
down_revision = None


def upgrade() -> None:
    ${body}
`
}

describe('checkMigrationBodyChangeMarkers', () => {
  // #751. This is the case the whole guard exists for: an already-released
  // migration's DDL changed and nobody said whether that is safe. Written
  // first, and proven to fail BEFORE the marker exists in the fixture below —
  // AGENTS.md §4's "reproduce the actual failure, not a theory of it", applied
  // to a guard rather than a bug fix.
  it('FAILS an already-released migration whose hashed body changed with no marker', () => {
    const oldContent = migration('op.add_column("t", sa.Column("a", sa.String()))')
    const newContent = migration('op.add_column("t", sa.Column("a", sa.Integer()))')
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0010_x.py', status: 'modified', oldContent, newContent },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.file).toBe('0010_x.py')
    expect(result.declared).toEqual([])
    expect(result.examined).toBe(1)
  })

  it('PASSES the identical case once a replay-safe marker is added — same DDL edit, marker only', () => {
    const oldContent = migration('op.add_column("t", sa.Column("a", sa.String()))')
    const newContent = migration(
      '# biffo:body-change: replay-safe — widens a column, no-op on an applied database\n' +
        '    op.add_column("t", sa.Column("a", sa.Integer()))',
    )
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0010_x.py', status: 'modified', oldContent, newContent },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.violations).toEqual([])
    expect(result.declared).toEqual([{ file: '0010_x.py', classification: 'replay-safe' }])
    expect(result.examined).toBe(1)
  })

  it('PASSES an outcome-changing declaration too, and reports the classification', () => {
    const oldContent = migration('op.add_column("t", sa.Column("a", sa.String()))')
    const newContent = migration(
      '# biffo:body-change: outcome-changing — column type was wrong\n' +
        '    op.add_column("t", sa.Column("a", sa.Integer()))',
    )
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0010_x.py', status: 'modified', oldContent, newContent },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.violations).toEqual([])
    expect(result.declared).toEqual([{ file: '0010_x.py', classification: 'outcome-changing' }])
  })

  it('FAILS a malformed marker exactly like an absent one — an unreviewable label is worse than none', () => {
    const oldContent = migration('op.add_column("t", sa.Column("a", sa.String()))')
    const newContent = migration(
      '# biffo:body-change: definitely-fine\n' +
        '    op.add_column("t", sa.Column("a", sa.Integer()))',
    )
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0010_x.py', status: 'modified', oldContent, newContent },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.reason).toMatch(/Malformed/)
  })

  // The exact shape #931 is: a docstring-only addendum to an already-released
  // migration. migrationBodyHash strips docstrings, so this must never fire —
  // proven directly against the real commit below, and here as the minimal
  // synthetic case so the reasoning is legible without checking out history.
  it('does NOT fire on a docstring-only addition — the #931 shape', () => {
    const oldContent = `"""short docstring"""


from alembic import op

revision = "abc"
down_revision = None


def upgrade() -> None:
    """Also short."""
    op.add_column("t", sa.Column("a", sa.String()))
`
    const newContent = `"""short docstring"""


from alembic import op

revision = "abc"
down_revision = None


def upgrade() -> None:
    """Also short.

    Fourteen more lines of prose explaining an invariant this function's
    correctness silently depended on, added after the migration shipped,
    touching not one line of the DDL below.
    """
    op.add_column("t", sa.Column("a", sa.String()))
`
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0010_x.py', status: 'modified', oldContent, newContent },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.violations).toEqual([])
    expect(result.unchanged).toEqual(['0010_x.py'])
    expect(result.examined).toBe(1)
  })

  it('exempts a migration added in this same PR — never released, nothing for a marker to protect', () => {
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0099_new.py', status: 'added', oldContent: null, newContent: migration('pass') },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.violations).toEqual([])
    expect(result.exemptAdded).toEqual(['0099_new.py'])
    // Not counted in the examined denominator — it was never a candidate for
    // an undeclared body change, having no prior released body to compare.
    expect(result.examined).toBe(0)
  })

  it("does not examine a deleted or renamed file — out of this guard's scope", () => {
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0010_x.py', status: 'deleted', oldContent: migration('pass'), newContent: null },
      {
        file: '0011_y.py',
        status: 'renamed',
        oldContent: migration('pass'),
        newContent: migration('x'),
      },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.examined).toBe(0)
    expect(result.violations).toEqual([])
  })

  it('prints a truthful zero denominator rather than silently passing over nothing (#1363)', () => {
    const result = checkMigrationBodyChangeMarkers([])
    expect(result.examined).toBe(0)
    expect(result.violations).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.declared).toEqual([])
  })

  it('examines several files independently in one run', () => {
    const clean = migration('op.add_column("t", sa.Column("a", sa.String()))')
    const dirty = migration('op.add_column("t", sa.Column("b", sa.String()))')
    const diffs: MigrationBodyChangeDiff[] = [
      { file: '0009_a.py', status: 'modified', oldContent: clean, newContent: clean },
      { file: '0010_b.py', status: 'modified', oldContent: clean, newContent: dirty },
    ]

    const result = checkMigrationBodyChangeMarkers(diffs)

    expect(result.examined).toBe(2)
    expect(result.unchanged).toEqual(['0009_a.py'])
    expect(result.violations.map((v) => v.file)).toEqual(['0010_b.py'])
  })
})

/**
 * The worked example named in #751's decision memo, run against the REAL
 * commit rather than a synthetic stand-in — the strongest evidence available
 * that this guard would not have blocked the one real edit it was measured
 * against. `9715636d` (#931, 2026-07-30) added fourteen lines to a function
 * docstring in migration 0010 and touched no DDL.
 */
describe('the #931 worked example, against the real repository history', () => {
  const SHA = '9715636d0a385e0073b26326717e2d299317fef0'
  const PATH = 'services/api/migrations/versions/0010_add_organizations_and_user_profile_fields.py'

  function showAt(ref: string): string {
    return execFileSync('git', ['show', `${ref}:${PATH}`], { cwd: repoRoot, encoding: 'utf8' })
  }

  it('touches the migration file (guards the fixture itself against going stale)', () => {
    // --stat abbreviates a long path with a leading "…", so assert on the
    // filename's tail rather than the full path.
    const stat = execFileSync('git', ['show', '--stat', SHA], { cwd: repoRoot, encoding: 'utf8' })
    expect(stat).toContain('user_profile_fields.py')
    // And the change list itself, which does carry the full path.
    const files = execFileSync('git', ['show', '--name-only', '--format=', SHA], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(files.split('\n')).toContain(PATH)
  })

  it('does NOT fire on the real #931 diff', () => {
    const oldContent = showAt(`${SHA}^`)
    const newContent = showAt(SHA)
    // Fails loudly rather than silently passing over nothing, if the fixture
    // ever stops actually differing (e.g. a future history rewrite).
    expect(oldContent).not.toBe(newContent)

    const result = checkMigrationBodyChangeMarkers([
      { file: PATH, status: 'modified', oldContent, newContent },
    ])

    expect(result.violations).toEqual([])
    expect(result.unchanged).toEqual([PATH])
    expect(result.examined).toBe(1)
  })
})
