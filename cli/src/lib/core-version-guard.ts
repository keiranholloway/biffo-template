import { type CoreManifest, isTemplateOwned } from './core-manifest.js'
import { CORE_VERSION_FILE } from './core-version.js'

/**
 * The versioning discipline behind ADR-0006: any change to a template-owned path
 * must be accompanied by a `core.version` bump, so instances can tell they're
 * behind and `biffo core upgrade` has a real version delta to work from. Without
 * this the version silently sticks (it sat at 0.1.0 through many releases),
 * making core status a permanent "up to date" and core upgrade a no-op.
 *
 * The discipline applies to the *template* repo only. In an instance, the same
 * check is not merely redundant but structurally unsatisfiable: a `biffo core
 * upgrade` PR rewrites template-owned paths by definition (that is the sync),
 * and it records the result in `biffo.core.json` — the version the instance
 * *received* — rather than `core.version`, which is the version the template
 * *emits* and is not an instance's to move. Left ungated, the guard fails every
 * core upgrade PR in every instance. So an instance skips the check entirely,
 * detected by the presence of `biffo.core.json` (the instance marker; it is
 * absent in the template).
 *
 * This is the pure decision function; the CI runner
 * (scripts/check-core-version-bump.ts) supplies the changed-file list, whether
 * `core.version` itself changed, and whether the repo is an instance.
 */

export interface BumpCheckResult {
  /** Template-owned paths changed in this diff (excluding core.version itself). */
  templateOwnedChanges: string[]
  /** True when template-owned paths changed but core.version was not bumped. */
  bumpRequired: boolean
  /** True when the check was skipped because this is an instance, not the template. */
  skippedAsInstance: boolean
}

export function checkCoreVersionBump(
  changedFiles: string[],
  coreVersionChanged: boolean,
  manifest: CoreManifest,
  /** Defaults to false — fail-closed, so a caller that cannot tell still enforces. */
  isInstance = false,
): BumpCheckResult {
  const templateOwnedChanges = changedFiles.filter(
    (f) => f !== CORE_VERSION_FILE && isTemplateOwned(f, manifest),
  )
  return {
    templateOwnedChanges,
    bumpRequired: !isInstance && templateOwnedChanges.length > 0 && !coreVersionChanged,
    skippedAsInstance: isInstance,
  }
}
