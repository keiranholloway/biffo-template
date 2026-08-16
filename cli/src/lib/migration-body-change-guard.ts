import {
  type BodyChangeClassification,
  BODY_CHANGE_MARKER,
  migrationBodyHash,
  parseBodyChangeDeclaration,
} from './core-migrations.js'

/**
 * The enforcement half of #751's option B — a CI guard, template-only, that
 * refuses a PR editing an already-released migration's *hashed* body without a
 * `# biffo:body-change:` declaration.
 *
 * #751's decision memo measured that the unpark condition it set for acting on
 * the declaration ("two or three more real body changes to classify by hand")
 * cannot accrue on its own: the one post-policy edit found on `origin/dev`
 * (`9715636d` / #931, a 14-line docstring addendum to migration `0010`) carried
 * no marker, because nothing asked for one. This guard is that ask. It does
 * NOT act on the classification — `planMigrationCarry` still leaves every
 * already-carried file alone, declared or not (see `DivergedMigrationBody`'s
 * doc in `core-migrations.ts`) — it only makes the marker's absence loud at
 * the one point a template author can still cheaply add it: before merge.
 *
 * ## Why "hashed body", not "any diff"
 *
 * A migration file's `revision` assignment, its docstrings, its whole-line `#`
 * comments and its blank lines are not schema — {@link migrationBodyHash}
 * already established that, for exactly this reason (#764: a docstring
 * addendum to `0010` reported `body drift` forever in every instance that had
 * already carried it, even though the two databases were identical). A guard
 * that fired on any byte difference would have blocked #931's own commit —
 * the worked example the memo used to argue the guard is *safe*, not just
 * useful. This guard reuses {@link migrationBodyHash} directly rather than a
 * second implementation of its normalisation, so the two can never drift
 * apart the way two independent parsers of the same marker format would.
 *
 * ## Why "already-released", not "any migration this PR touches"
 *
 * A migration this PR *adds* has never shipped in a `core-v*` tag, so no
 * instance could possibly have carried it yet — there is nothing for a body
 * edit to silently fail to reach, and requiring a marker on a file's very
 * first commit would be pure noise. The guard only examines migrations that
 * existed before this PR (i.e. modified, not added) — the ones an instance
 * may already have applied.
 */
export interface MigrationBodyChangeDiff {
  /** Repo-relative path, e.g. `services/api/migrations/versions/0010_x.py`. */
  file: string
  /**
   * `added` — new in this PR, never released, exempt.
   * `modified` — existed before this PR; the guard examines these.
   * `deleted` / `renamed` — out of scope for this guard (#751 built body-change
   * detection only; a deletion or a rename is a different question with its
   * own remedy under `alreadyCarried`'s body-hash matching).
   */
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Content at the merge base. Absent for `added`. */
  oldContent: string | null
  /** Content at the PR tip. Absent for `deleted`. */
  newContent: string | null
}

export interface MigrationBodyChangeViolation {
  file: string
  reason: string
}

export interface MigrationBodyChangeCheckResult {
  /**
   * How many already-released migration files this run actually compared —
   * `unchanged.length + declared.length + violations.length`. Printed
   * unconditionally by the caller: a check that passes having examined zero
   * files is indistinguishable from one that never ran, and this repo has
   * sixteen recorded instances of exactly that failure shape (#1363).
   */
  examined: number
  /** Newly added in this PR — never released, so exempt from the marker requirement. */
  exemptAdded: string[]
  /** Hash-identical to the merge base — a docstring/comment-only edit, #931's shape. */
  unchanged: string[]
  /** Hash-changed, with a valid declaration. */
  declared: { file: string; classification: BodyChangeClassification }[]
  /** Hash-changed, with no declaration or a malformed one. */
  violations: MigrationBodyChangeViolation[]
}

/**
 * Pure decision function — no git, no filesystem. The caller resolves the diff
 * (see `check-migration-body-change.ts`); this only classifies it, so the
 * decision is unit-testable without a real repository.
 */
export function checkMigrationBodyChangeMarkers(
  diffs: MigrationBodyChangeDiff[],
): MigrationBodyChangeCheckResult {
  const exemptAdded: string[] = []
  const unchanged: string[] = []
  const declared: { file: string; classification: BodyChangeClassification }[] = []
  const violations: MigrationBodyChangeViolation[] = []

  for (const d of diffs) {
    if (d.status === 'added') {
      exemptAdded.push(d.file)
      continue
    }
    if (d.status !== 'modified') {
      // Deleted or renamed — not this guard's question. See the interface doc.
      continue
    }

    const oldHash = migrationBodyHash(d.oldContent ?? '')
    const newHash = migrationBodyHash(d.newContent ?? '')
    if (oldHash === newHash) {
      unchanged.push(d.file)
      continue
    }

    let decl
    try {
      decl = parseBodyChangeDeclaration(d.newContent ?? '')
    } catch (err) {
      violations.push({ file: d.file, reason: (err as Error).message })
      continue
    }

    if (decl) {
      declared.push({ file: d.file, classification: decl.classification })
    } else {
      violations.push({
        file: d.file,
        reason:
          "this edit changes the migration's hashed body (DDL, not just a docstring or " +
          `comment) with no \`${BODY_CHANGE_MARKER}\` declaration.`,
      })
    }
  }

  return {
    examined: unchanged.length + declared.length + violations.length,
    exemptAdded,
    unchanged,
    declared,
    violations,
  }
}
