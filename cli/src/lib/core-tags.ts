import type { CoreManifest } from './core-manifest.js'

/**
 * The `core-v<version>` tag contract behind ADR-0006 (issue #294).
 *
 * ## The property
 *
 * `biffo core upgrade` resolves the template tree for a version *by tag*: it
 * materialises `core-v<version>` and three-way-merges the template-owned paths
 * into an instance. So the tag must satisfy:
 *
 *   **`core-v<V>` resolves to the template-owned tree as it stood at version V.**
 *
 * ## Why this file is now four lines of logic
 *
 * It used to hold a four-state tag machine (`create` / `keep` / `drifted` /
 * `conflict`), an audit that re-derived every historical tag from `main`, and a
 * baseline listing the versions that audit had to write off. All of it existed
 * to defend one weakness: the version came from a committed `core.version`
 * file, and a file can name a version that has already been tagged and
 * published. Two commits could then ship one version, and since npm versions
 * are immutable the tag could not be moved to fix it (#342).
 *
 * Since #423 the version is derived — the highest `core-v*` tag, bumped by the
 * commit's conventional type (`release-version.ts`) — and the tag is created in
 * the same step that derives it. A derived version is strictly greater than
 * every tag that exists, so it cannot collide, no tag is ever revisited, and
 * the property above holds by construction. The states those tools detected
 * became unreachable, so they were deleted rather than left as reassurance.
 *
 * The one hand-editing fault that survives derivation — a `core-v*` tag pushed
 * outside `main`'s history, since tags are not covered by branch protection —
 * is checked in `../scripts/sync-core-tag.ts`, where it can act on it.
 */

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
