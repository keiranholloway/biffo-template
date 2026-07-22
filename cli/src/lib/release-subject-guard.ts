import { type CoreManifest, isTemplateOwned } from './core-manifest.js'
import { type BumpKind, bumpKindFor, parseConventionalSubject } from './release-version.js'

/**
 * The guard that replaced the `core.version` bump requirement (#423).
 *
 * ## What changed
 *
 * A template-owned change used to have to carry a hand-written `core.version`
 * bump, and this guard failed the PR when it did not. Since #423 the version is
 * derived on `main` — the highest `core-v*` tag, bumped by the released commit's
 * conventional type — so there is nothing left to bump, and nothing left to
 * forget.
 *
 * ## What replaced it
 *
 * The derivation reads *one input*: the subject line of the commit that lands on
 * `main`. Under squash-merge that subject is **the pull request title**, not any
 * commit message on the branch — commitlint never sees it, and a title it cannot
 * parse fails nothing. It simply falls through to a patch bump.
 *
 * So the failure mode moved rather than vanished: a feature merged under "Update
 * the API" ships as a patch, and the minor line instances watch never moves.
 * That is quieter than a forgotten bump, which at least stopped the release
 * outright. This guard makes it loud again — on a PR touching template-owned
 * paths, the title has to parse as a Conventional Commits subject.
 *
 * Template-only, like the guard it replaces: an instance (detected by
 * `biffo.core.json`) cuts no `core-v*` release, so its PR titles are not release
 * inputs.
 */
export interface SubjectCheckResult {
  /** Template-owned paths this change touches — empty means nothing to release. */
  templateOwnedChanges: string[]
  /** True when a release would be derived from a subject that cannot be parsed. */
  unparseable: boolean
  /** The bump this subject would produce, or null when it is unparseable. */
  bump: BumpKind | null
  skippedAsInstance: boolean
}

export function checkReleaseSubject(
  changedFiles: string[],
  subject: string,
  manifest: CoreManifest,
  isInstance: boolean,
): SubjectCheckResult {
  const templateOwnedChanges = changedFiles.filter((f) => isTemplateOwned(f, manifest))
  const parsed = parseConventionalSubject(subject)
  const releases = !isInstance && templateOwnedChanges.length > 0
  return {
    templateOwnedChanges,
    unparseable: releases && parsed === null,
    bump: parsed === null ? null : bumpKindFor([subject]),
    skippedAsInstance: isInstance,
  }
}
