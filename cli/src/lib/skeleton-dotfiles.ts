import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * npm silently drops `.gitignore` from every published tarball — unconditionally,
 * at every depth, and an explicit `files` entry does not override it (verified by
 * `npm pack`, not assumed).
 *
 * That matters because `_skeletons/sibling-template/.gitignore` is content we
 * ship, not packaging metadata: it becomes the scaffolded repo's `.gitignore`.
 * Left unhandled, `biffo init` would produce a *superficially working* sibling
 * repo whose very first commit is free to include `node_modules/`, `.terraform/`,
 * `.env` and Terraform state — a worse failure than #315's loud crash, because
 * nothing announces it.
 *
 * So the packaging copy stores the file under a name npm will carry
 * (`_gitignore`), and the scaffolders rename it back on the way out. The
 * repo-root skeleton keeps the real `.gitignore`, so a template checkout is
 * unaffected and the rename is a no-op there.
 *
 * See `cli/scripts/sync-packaged-assets.mjs` (the outbound half) and #315.
 */
export const PACKAGED_GITIGNORE = '_gitignore'
export const REAL_GITIGNORE = '.gitignore'

/**
 * Rename every `_gitignore` back to `.gitignore` beneath `dir`, recursively.
 * Idempotent, and a no-op when scaffolding from a template checkout (where the
 * files are already correctly named).
 */
export function restorePackagedDotfiles(dir: string): string[] {
  const restored: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      restored.push(...restorePackagedDotfiles(full))
    } else if (entry.name === PACKAGED_GITIGNORE) {
      const target = join(dir, REAL_GITIGNORE)
      renameSync(full, target)
      restored.push(target)
    }
  }
  return restored
}
