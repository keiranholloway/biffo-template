import { compareCoreVersions, parseCoreVersion } from './core-version.js'

/**
 * Derive the next `core.version` from what was merged (issues #423, #422).
 *
 * ## Why the version stopped being hand-written
 *
 * `core.version` is a single global counter that every template-owned PR had to
 * bump. With branch protection requiring branches to be up to date, that made a
 * conflict between concurrent PRs **certain**: the second to merge always had
 * to rebase, re-bump, force-push and wait for another full CI cycle. Four
 * concurrent PRs cost four rebases. The conflict was trivial and always
 * resolved the same way, which is what made it churn rather than signal — a
 * hand-resolved conflict with one correct answer is a job for a machine.
 *
 * So nothing bumps it by hand any more. The version is derived from the
 * conventional-commit types already enforced by commitlint, and written by the
 * release job. Concurrent PRs no longer touch the file, so they no longer
 * conflict on it.
 *
 * ## Why that also closes the monotonicity hole
 *
 * The old guard asked "did `core.version` appear in the diff?", never "is it
 * greater?" — so a revert that restored a previously released number passed
 * every required check (#422). Two commits on `main` could then carry one
 * released version, and since `core-v<V>` is a published release whose npm
 * artifact cannot move, the two would disagree for ever.
 *
 * Deriving the version removes the hand-edit that made that reachable, and
 * `nextCoreVersion` additionally *asserts* the result is strictly greater than
 * what it started from. The property is now structural rather than policed.
 */

/** Types commitlint accepts. Only `feat` earns a minor; the rest are patches. */
const MINOR_TYPES = new Set(['feat'])

export type BumpKind = 'minor' | 'patch'

export interface ConventionalSubject {
  type: string
  /** `feat!:` or `feat(scope)!:` — a declared breaking change. */
  breaking: boolean
}

/** `type(scope)!: subject` → its type and whether it declares a break. */
const SUBJECT = /^([a-z]+)(?:\([^)]*\))?(!)?:\s+\S/

/**
 * Parse a commit subject, or null when it is not conventional.
 *
 * Null matters: it is how the guard tells a maintainer that the PR title — which
 * squash-merge turns into the commit subject, and which therefore decides the
 * released version — will not produce a bump anyone can predict.
 */
export function parseConventionalSubject(subject: string): ConventionalSubject | null {
  const match = SUBJECT.exec(subject.trim())
  if (!match?.[1]) return null
  return { type: match[1], breaking: match[2] === '!' }
}

/**
 * The bump a set of merged subjects earns.
 *
 * Pre-1.0, a declared breaking change is a **minor**, not a major — which is
 * what this repo has always done by hand (0.50.0 replaced the Cognito pool and
 * deleted every user, and went 0.49.x → 0.50.0). Semver reserves 0.x for
 * exactly this: the leading zero already says the surface can move.
 *
 * Anything unparseable is treated as a patch rather than ignored. A subject
 * nobody can classify must still move the version, or its changes reach no
 * instance at all — the failure ADR-0006 exists to prevent, and worse than
 * bumping too far.
 */
export function bumpKindFor(subjects: string[]): BumpKind {
  for (const subject of subjects) {
    const parsed = parseConventionalSubject(subject)
    if (parsed && (parsed.breaking || MINOR_TYPES.has(parsed.type))) return 'minor'
  }
  return 'patch'
}

/** Apply a bump to a semver triple. */
export function applyBump(current: string, kind: BumpKind): string {
  const [major, minor, patch] = parseCoreVersion(current)
  return kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

/**
 * The next version for a release, given the current one and what was merged.
 *
 * Throws if the result is not strictly greater than *current* — the
 * monotonicity #422 found unenforced. It cannot fail for any input this
 * function produces; it is here so that a future change to the bump rules
 * cannot quietly reintroduce a version that stands still or goes backwards,
 * which is unrecoverable once `core-v<V>` has been published to npm.
 */
export function nextCoreVersion(current: string, subjects: string[]): string {
  const next = applyBump(current, bumpKindFor(subjects))
  if (compareCoreVersions(next, current) <= 0) {
    throw new Error(
      `Derived core version ${next} is not greater than the current ${current}. ` +
        'A released version can never be reissued: core-v<version> is published to npm ' +
        'and npm versions are immutable (#342, #422).',
    )
  }
  return next
}

/** What the release job should do with the commit it is looking at. */
export type ReleaseDecision =
  /** Nothing template-owned changed since the last release. */
  | { kind: 'nothing-to-release' }
  /** HEAD is already the newest release — a re-run, or a user-owned push. */
  | { kind: 'already-released'; version: string }
  /** Tag HEAD as this version. */
  | { kind: 'release'; version: string }

export interface ReleaseState {
  /** Highest existing `core-v*` version, or null for a template with none. */
  latestVersion: string | null
  /** Whether the newest tag already points at HEAD. */
  latestTagIsHead: boolean
  /** Whether any template-owned path differs between the newest tag and HEAD. */
  templateTreeChanged: boolean
  /** Subject of the commit being released — decides minor vs patch. */
  subject: string
}

/**
 * Decide whether HEAD is a release, and at what version.
 *
 * ## Why this cannot repeat or move a version
 *
 * The version is always `latestVersion` bumped, so the tag it names is strictly
 * higher than every tag that exists and therefore cannot already exist. The old
 * design derived the version from a file that could repeat — two commits
 * shipping one version (#294), or a revert restoring a published one (#422) —
 * and needed a state machine to refuse moving a tag that was already an npm
 * release (#342). None of those states is reachable now: nothing here ever
 * writes a tag that exists.
 *
 * ## Why "template tree changed" and not "any commit"
 *
 * Most commits on `main` are user-owned — docs, infra, an instance's app — and
 * reach no instance. Releasing them would mint a version whose tag has a tree
 * identical to the previous one, and every instance would see an upgrade with
 * nothing in it. The property is about the tree, which is the same reasoning
 * the old `keep` action encoded.
 *
 * A template with no tags at all releases its first version from the bump
 * alone, so a fresh template does not need a seed tag created by hand.
 */
export function decideRelease(state: ReleaseState): ReleaseDecision {
  if (state.latestTagIsHead && state.latestVersion) {
    return { kind: 'already-released', version: state.latestVersion }
  }
  if (state.latestVersion !== null && !state.templateTreeChanged) {
    return { kind: 'nothing-to-release' }
  }
  const base = state.latestVersion ?? '0.0.0'
  return { kind: 'release', version: nextCoreVersion(base, [state.subject]) }
}
