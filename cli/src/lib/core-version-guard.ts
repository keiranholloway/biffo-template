import { type CoreManifest, isTemplateOwned } from './core-manifest.js'
import { CORE_VERSION_FILE } from './core-version.js'
import { parseConventionalSubject } from './release-version.js'

/**
 * The versioning discipline behind ADR-0006, now enforced from the other side
 * (issues #423, #422).
 *
 * ## What changed, and why
 *
 * This guard used to demand that every template-owned PR bump `core.version` by
 * hand. That worked, and it made a conflict between concurrent PRs **certain**:
 * `core.version` is a single global counter, branch protection requires branches
 * to be up to date, so the second PR to merge always had to rebase, re-bump and
 * wait for another CI cycle. Four concurrent PRs cost four rebases, every one
 * resolved the same way.
 *
 * Worse, it never actually checked the number. It asked "did `core.version`
 * appear in the diff?", not "is it greater?" — so a revert restoring an
 * already-released version passed every required check (#422). Since
 * `core-v<version>` is published to npm and npm versions are immutable, two
 * commits carrying one released version disagree for ever.
 *
 * So the version is no longer written by hand at all. The release job derives it
 * from the conventional-commit types commitlint already enforces
 * (lib/release-version.ts) and commits it after the merge. This guard's job
 * inverts accordingly:
 *
 *   - a PR **must not** change `core.version` — it belongs to the release job,
 *     and a hand-edit is the only way to move it backwards;
 *   - a PR that changes template-owned paths **must** carry a subject the
 *     derivation can read, because squash-merge makes the PR title the commit
 *     subject, and that subject is what decides the released version.
 *
 * Neither condition can conflict between concurrent PRs, which is the point.
 *
 * The template-only rule is unchanged. In an instance the check is not merely
 * redundant but unsatisfiable: a `biffo core upgrade` PR rewrites template-owned
 * paths by definition and records the result in `biffo.core.json`, not
 * `core.version`. An instance is detected by `biffo.core.json`, absent in the
 * template.
 *
 * This is the pure decision function; the CI runner
 * (scripts/check-core-version-bump.ts) supplies the changed files, the subjects
 * and whether the repo is an instance.
 */

export interface BumpCheckResult {
  /** Template-owned paths changed in this diff (excluding core.version itself). */
  templateOwnedChanges: string[]
  /**
   * True when the PR edits `core.version` itself. The release job owns that
   * file; a hand-edit is how it could move backwards onto a published version.
   */
  handEdited: boolean
  /**
   * Subjects the derivation cannot classify, when this PR changes
   * template-owned paths. Squash-merge makes the PR title the commit subject,
   * so an unclassifiable one decides the release by accident.
   */
  unclassifiableSubjects: string[]
  /** True when the check was skipped because this is an instance, not the template. */
  skippedAsInstance: boolean
  /** True when the PR must not merge as it stands. */
  blocked: boolean
}

export interface BumpCheckInput {
  changedFiles: string[]
  manifest: CoreManifest
  /**
   * Commit subjects this PR would contribute. Under squash-merge that is
   * effectively the PR title, which is why it is checked at all.
   */
  subjects?: string[]
  /** Defaults to false — fail-closed, so a caller that cannot tell still enforces. */
  isInstance?: boolean
}

export function checkCoreVersionBump({
  changedFiles,
  manifest,
  subjects = [],
  isInstance = false,
}: BumpCheckInput): BumpCheckResult {
  const templateOwnedChanges = changedFiles.filter(
    (f) => f !== CORE_VERSION_FILE && isTemplateOwned(f, manifest),
  )
  const handEdited = changedFiles.includes(CORE_VERSION_FILE)

  // Only worth complaining about when this PR actually releases something. A
  // PR touching nothing template-owned changes no version, so its subject
  // decides nothing.
  const unclassifiableSubjects =
    templateOwnedChanges.length > 0
      ? subjects.filter((s) => parseConventionalSubject(s) === null)
      : []

  return {
    templateOwnedChanges,
    handEdited: !isInstance && handEdited,
    unclassifiableSubjects: isInstance ? [] : unclassifiableSubjects,
    skippedAsInstance: isInstance,
    blocked: !isInstance && (handEdited || unclassifiableSubjects.length > 0),
  }
}
