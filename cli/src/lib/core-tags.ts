import type { CoreManifest } from './core-manifest.js'
import { compareCoreVersions } from './core-version.js'

/**
 * The `core-v<version>` tag contract behind ADR-0006, and the two mechanisms
 * that make it hold by construction rather than by convention (issue #294).
 *
 * ## The property
 *
 * `biffo core upgrade` resolves the template tree for a version *by tag*: it
 * materialises `core-v<version>` and three-way-merges the template-owned paths
 * into an instance. So the tag must satisfy:
 *
 *   **`core-v<V>` resolves to the template-owned tree as it stood at version V.**
 *
 * Note what that does *not* say: it says nothing about which commit the tag is
 * on. Any commit on `main` whose template-owned tree equals the tree at V is an
 * equally correct target. That matters, because most commits that land while
 * the version sits at V are user-owned (docs, apps/, infra/) and leave the
 * template tree untouched — the tag need not, and should not, chase them.
 *
 * ## How it used to break
 *
 * Two PRs opened against the same base both bumped to the same version; the
 * first merged, the second rebased, resolved the `core.version` conflict by
 * keeping the number, and merged too. `core.version` never changed in that
 * second merge, so the path-filtered tag workflow did not even run — and had it
 * run, it skipped, because the tag already existed. The second commit's
 * template-owned changes were on `main` and reachable at no version at all:
 * invisible to every instance, silently, forever. Observed on 2026-07-19 with
 * a2acf15 (#291) and be4c573 (#292), both carrying 0.32.4.
 *
 * The Core Version Guard cannot catch this and is not meant to: it asks "did
 * this PR bump the version relative to its base?", which the second PR did. The
 * base moved afterwards. The guard is right about the diff it was handed.
 *
 * ## Why the tag is never moved (and used to be)
 *
 * #294's answer was to move the tag forward onto the later commit: if two
 * commits ship the same version, the tag must stand for the *later* template
 * tree or the later commit reaches no instance at all. Given the choice between
 * a surprising tag and silently lost changes, that was right at the time.
 *
 * It is the wrong answer now, for two reasons.
 *
 * 1. **The collision is prevented at the gate.** `main` now requires a branch to
 *    be up to date before it can merge (`required_status_checks.strict`, #342).
 *    The second of two concurrent PRs cannot merge without first rebasing onto
 *    the first, which re-runs the Core Version Guard against the new base —
 *    where `core.version` is no longer changed relative to that base, so the
 *    guard fails until the PR picks a different number.
 * 2. **The tag is a release, and releases are immutable.** `core-tag.yml`
 *    dispatches `publish-cli.yml` against every tag it pushes, so by the time a
 *    later push finds an existing `core-v<V>`, V has already been offered to
 *    npm — and an npm version, once published, cannot be republished. Moving the
 *    tag cannot move the artifact with it; it can only make the two disagree.
 *    That is exactly what #342 recorded: npm held #339's tree as 0.41.9 while
 *    `core-v0.41.9` was moved onto #340's.
 *
 * So reaching that state today means something happened that this repo's rules
 * say cannot. Known routes, none of them ordinary:
 *
 *   - `core.version` moved *backwards* onto an already-released number. The
 *     Core Version Guard asserts only that `core.version` *changed* relative to
 *     the PR's base, never that it increased, so a revert or a hand-edit can
 *     re-use a released number and still pass every required check.
 *   - `core-v*` tags are not protected — one can be deleted, or created by hand
 *     at the wrong commit.
 *   - Branch protection is a repository setting, not code. Turn `strict` off and
 *     the original race is back.
 *
 * Every one of those is a release-integrity question a person has to answer with
 * the registry in front of them ("what is actually inside `@biffo/cli@V`?"), not
 * something a CI job should decide by force-pushing a tag. So `decideTagAction`
 * refuses, loudly, and says what to do instead.
 *
 * ## The two mechanisms here
 *
 * 1. `decideTagAction` — the tag workflow runs on *every* push to `main` (no
 *    path filter, since the failure case is precisely a push that does not touch
 *    `core.version`). It creates a tag that does not exist, keeps one that
 *    already stands for this tree, and refuses everything else.
 * 2. `auditCoreTags` — an assertion, run after tagging, that the property holds
 *    across `main`'s recent history and not merely for the commit just pushed.
 *    Detection as well as prevention: if a future change to the tagging path
 *    regresses, this reddens `main` immediately instead of the drift being
 *    found days later by hand.
 *
 * The two now agree by construction. Under the old behaviour they could not: a
 * move repaired the very drift the audit exists to report, so the audit could
 * never see the case it was written for.
 */

/**
 * Versions before this one are not audited.
 *
 * `main` carried two pre-existing violations of the property — 0.3.14 and
 * 0.23.6, where template-owned changes merged without a version bump and the
 * tag stayed on the introducing commit — plus 0.1.0, which predates tagging
 * entirely. They are history: repairing them means moving tags that instances
 * may have resolved against, to fix releases long superseded.
 *
 * **0.58.0 joins them, and it is worth saying exactly why.** PR #425 tried to
 * derive `core.version` in the release job instead of having authors bump it by
 * hand (#423). The derivation was right — it read 0.58.0 -> 0.59.0 from the
 * merge subject — but the job pushed the result straight to `main`, which is a
 * protected branch that refuses direct pushes even from GITHUB_TOKEN. So #425
 * merged, released nothing, and left its own tree sitting on `main` at 0.58.0,
 * a version already tagged at 5af0180 and already published to npm.
 *
 * The tag is not wrong: `npm view @biffo/cli@0.58.0 gitHead` is 5af0180, so
 * core-v0.58.0 stands for precisely what was published. Repointing or deleting
 * it would contradict a real artifact to tidy a commit that has since been
 * reverted. Raising the baseline is the honest record: the violation is known,
 * bounded to one version, and its cause is written down.
 */
export const AUDIT_BASELINE_VERSION = '0.58.1'

/** The git tag for a core version, e.g. `0.2.0` -> `core-v0.2.0`. */
export function coreVersionTag(version: string): string {
  return `core-v${version}`
}

/**
 * Git pathspecs selecting exactly the template-owned tree, used to ask "did the
 * template change between these two commits?".
 *
 * Ownership in `core-manifest.json` is longest-prefix-wins, so a user-owned
 * entry nested inside a template-owned one (today:
 * `services/api/migrations/versions/`, an append-only per-instance chain) is
 * carved back out — as a git `:(exclude)` pathspec. Top-level user-owned entries
 * need no exclusion: they were never included.
 */
export function templateOwnedPathspecs(manifest: CoreManifest): string[] {
  const nestedUserOwned = manifest.userOwned.filter((u) =>
    manifest.templateOwned.some((t) => t !== u && t.endsWith('/') && u.startsWith(t)),
  )
  return [...manifest.templateOwned, ...nestedUserOwned.map((u) => `:(exclude)${u}`)]
}

/** What the tag workflow should do for the version at the tip of `main`. */
export type TagAction =
  /** No such tag yet — create it at HEAD. */
  | 'create'
  /** Tag exists and already stands for this template tree. Leave it alone. */
  | 'keep'
  /**
   * Tag exists on this branch, but the template tree moved underneath it while
   * `core.version` stayed put — two commits shipping one released version.
   * Refuse: the tag has already been released (see the header). Fix by bumping.
   */
  | 'drifted'
  /** Tag exists off `main` (or on a commit HEAD does not descend from). Refuse. */
  | 'conflict'

export interface TagState {
  /** Whether `core-v<version>` resolves to anything. */
  tagExists: boolean
  /** Whether the tagged commit is HEAD or an ancestor of it — i.e. on this branch. */
  taggedCommitIsAncestorOfHead: boolean
  /**
   * Whether the template-owned tree differs between the tagged commit and HEAD.
   * Only meaningful when the tag exists.
   */
  templateTreeDiffers: boolean
}

/**
 * Decide what to do with `core-v<version>` given where it currently points.
 *
 * Exactly one outcome writes a tag that did not exist (`create`); one leaves a
 * correct tag alone (`keep`); the other two refuse. **No input produces a move.**
 * An existing `core-v*` tag is a published release — `core-tag.yml` pushed it
 * and dispatched `publish-cli.yml` against it — so repointing it can only make
 * the tag and the npm artifact describe different trees (#342).
 *
 * `keep` on an unchanged template tree is what stops the tag chasing every
 * user-owned commit on `main` — most commits that land while the version sits
 * still are user-owned, and the property is about the tree, not the commit.
 *
 * The two refusals differ in diagnosis, which is why they are separate:
 *
 *   - `drifted` — the tag is on this branch but its template tree is not HEAD's.
 *     Two commits carry one version. Remedy: bump `core.version`, so the new
 *     tree gets a version and a release of its own.
 *   - `conflict` — the tag is not an ancestor of HEAD at all: history was
 *     rewritten, or the tag was made by hand off-branch. Nothing here can infer
 *     what was intended.
 */
export function decideTagAction(state: TagState): TagAction {
  if (!state.tagExists) return 'create'
  if (!state.taggedCommitIsAncestorOfHead) return 'conflict'
  return state.templateTreeDiffers ? 'drifted' : 'keep'
}

/** One version's worth of evidence for the audit. */
export interface CoreTagFact {
  /** The core version, e.g. `0.32.4`. */
  version: string
  /** Newest commit on `main` carrying this version — the tree the tag must stand for. */
  headOfVersion: string
  /** Commit the tag points at, or null when the tag does not exist. */
  taggedCommit: string | null
  /**
   * Whether the tagged commit's template-owned tree equals `headOfVersion`'s.
   * False when the tag is missing.
   */
  templateTreeMatches: boolean
}

export interface CoreTagViolation {
  version: string
  tag: string
  kind: 'missing' | 'drifted'
  /** A commit whose template tree the tag must match. */
  expected: string
  actual: string | null
}

/**
 * Assert the ADR-0006 property across `main`: every core version at or above
 * `baseline` has a tag standing for the template tree at that version.
 *
 * Returns the violations, newest version first; empty means the property holds.
 */
export function auditCoreTags(
  facts: CoreTagFact[],
  baseline: string = AUDIT_BASELINE_VERSION,
): CoreTagViolation[] {
  return facts
    .filter((f) => compareCoreVersions(f.version, baseline) >= 0)
    .filter((f) => !f.templateTreeMatches)
    .map((f) => ({
      version: f.version,
      tag: coreVersionTag(f.version),
      kind: f.taggedCommit === null ? ('missing' as const) : ('drifted' as const),
      expected: f.headOfVersion,
      actual: f.taggedCommit,
    }))
    .sort((a, b) => compareCoreVersions(b.version, a.version))
}

/** Human-readable failure report for `auditCoreTags` violations. */
export function formatTagViolations(violations: CoreTagViolation[]): string {
  const lines = violations.map((v) =>
    v.kind === 'missing'
      ? `    - ${v.tag}: no such tag. The template tree at ${v.version} (${v.expected.slice(0, 8)}) is reachable at no version, so \`biffo core upgrade\` can never carry it.`
      : `    - ${v.tag}: points at ${v.actual?.slice(0, 8)}, whose template-owned tree differs from the tree at ${v.version} (${v.expected.slice(0, 8)}).`,
  )
  return (
    `\n✗ core-v<version> tags do not resolve to the template tree at that version (ADR-0006).\n\n` +
    lines.join('\n') +
    `\n\n  A core version's tag must stand for the template-owned tree as it stood at that version.\n` +
    `  Anything on main but not under a tag is invisible to \`biffo core upgrade\` and will never\n` +
    `  reach an instance. See issue #294.\n`
  )
}
