import { type CoreManifest, isTemplateOwned } from './core-manifest.js'
import { CORE_VERSION_FILE } from './core-version.js'

/**
 * The versioning discipline behind ADR-0006: any change to a template-owned path
 * must be accompanied by a `core.version` bump, so instances can tell they're
 * behind and `biffo core upgrade` has a real version delta to work from. Without
 * this the version silently sticks (it sat at 0.1.0 through many releases),
 * making core status a permanent "up to date" and core upgrade a no-op.
 *
 * This is the pure decision function; the CI runner
 * (scripts/check-core-version-bump.ts) supplies the changed-file list and
 * whether `core.version` itself changed.
 */

export interface BumpCheckResult {
  /** Template-owned paths changed in this diff (excluding core.version itself). */
  templateOwnedChanges: string[]
  /** True when template-owned paths changed but core.version was not bumped. */
  bumpRequired: boolean
}

export function checkCoreVersionBump(
  changedFiles: string[],
  coreVersionChanged: boolean,
  manifest: CoreManifest,
): BumpCheckResult {
  const templateOwnedChanges = changedFiles.filter(
    (f) => f !== CORE_VERSION_FILE && isTemplateOwned(f, manifest),
  )
  return {
    templateOwnedChanges,
    bumpRequired: templateOwnedChanges.length > 0 && !coreVersionChanged,
  }
}
