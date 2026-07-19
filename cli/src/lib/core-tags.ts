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
 * ## The two mechanisms here
 *
 * 1. `decideTagAction` — the tag workflow runs on *every* push to `main` (no
 *    path filter, since the failure case is precisely a push that does not
 *    touch `core.version`) and moves the tag forward when, and only when, the
 *    template-owned tree has changed underneath a tag that stayed put. So the
 *    tag tracks the tree, which is what the property is about.
 * 2. `auditCoreTags` — an assertion, run after tagging, that the property holds
 *    across `main`'s recent history and not merely for the commit just pushed.
 *    Detection as well as prevention: if a future change to the tagging path
 *    regresses, this reddens `main` immediately instead of the drift being
 *    found days later by hand.
 */

/**
 * Versions before this one are not audited.
 *
 * `main` carries two pre-existing violations of the property — 0.3.14 and
 * 0.23.6, where template-owned changes merged without a version bump and the
 * tag stayed on the introducing commit — plus 0.1.0, which predates tagging
 * entirely. They are history: repairing them means moving tags that instances
 * may have resolved against, to fix releases long superseded (main is well past
 * 0.30 by now). Auditing from 0.24.0 covers everything since and is green
 * today, so the check starts enforcing immediately rather than only for
 * versions shipped after it lands.
 */
export const AUDIT_BASELINE_VERSION = '0.24.0'

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
  /** Tag exists but the template tree moved underneath it — move it to HEAD. */
  | 'move'
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
 * `keep` on an unchanged template tree is what stops the tag chasing every
 * user-owned commit on `main`; `move` on a changed one is what closes the
 * collision hole. `conflict` is deliberate: a tag pointing somewhere HEAD does
 * not descend from means either history was rewritten or the tag was created
 * by hand off-branch, and quietly force-pushing over it would destroy the only
 * record of which tree a released version meant.
 */
export function decideTagAction(state: TagState): TagAction {
  if (!state.tagExists) return 'create'
  if (!state.taggedCommitIsAncestorOfHead) return 'conflict'
  return state.templateTreeDiffers ? 'move' : 'keep'
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
