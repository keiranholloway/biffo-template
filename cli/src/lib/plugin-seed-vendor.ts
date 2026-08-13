/**
 * Vendors a plugin's declared baseline-row seed DDL (`manifest.seed`,
 * biffo-template#1554) into the instance's `db/imports/` — the same
 * "vendor and commit" model `plugin-source-copy.ts` already uses for a
 * plugin's own source, applied to its seed `.sql` files instead.
 *
 * ## Why this exists
 *
 * ADR-0005's DDL-import mechanism (`db/imports/<name>/`, applied by the
 * instance's existing "Apply DDL imports" deploy step) already runs on every
 * deploy, is checksum-tracked for idempotency, and needs no admin token or
 * per-tenant API call — it is the working answer to "how does a plugin's
 * tenant-scoped baseline data get seeded" that #1554 formalises. This module
 * is the vendoring half: it copies a plugin's declared `seed.dir` (validated
 * by `plugin-manifest.ts`'s `SeedDeclarationSchema`) into the instance's own
 * `db/imports/`, the same way `copyPluginSource` copies a plugin's source
 * into `services/<name>/`.
 *
 * ## The naming convention, and why it cannot collide
 *
 * Vendored to `db/imports/_plugin-<name>/`. `biffo data import <name>`
 * (`cli/src/commands/data-import.ts`) enforces `NAME_PATTERN =
 * /^[a-z][a-z0-9-]*$/` on the import name it lets a human choose — that
 * pattern requires the FIRST character to be `[a-z]`, so it can never
 * produce a name starting with `_`. A human-authored import can therefore
 * never collide with this prefix through the one CLI path that creates
 * `db/imports/` entries. (A human hand-editing the directory outside the CLI
 * could still choose the same name deliberately — no naming convention can
 * prevent that — but this closes the collision that matters: the two
 * automated writers of `db/imports/` never fighting each other.)
 *
 * ## Full replace on every install/upgrade, and the changed-seed-file edge
 *
 * Like the Terraform module and `services/<name>/` itself, a re-install or
 * upgrade fully replaces `db/imports/_plugin-<name>/` with whatever the new
 * source ships — this does not try to diff old and new seed files. If a
 * plugin author edits an already-shipped `.sql` file rather than adding a
 * new, additively-numbered one, the vendored copy's checksum no longer
 * matches what `ddl_import_history` recorded for it, and ADR-0005 section 4
 * makes that a **hard failure on the next deploy** (not a silent re-apply,
 * not a silent skip) — this module does not try to prevent that mistake, it
 * relies on the mechanism that already catches it, and warns about it at the
 * moment it matters (see the log line in `vendorPluginSeed`).
 *
 * ## Uninstall does not remove the vendored seed
 *
 * `biffo plugin uninstall` deliberately leaves `db/imports/_plugin-<name>/`
 * in place — see `plugin-uninstall.ts`'s docstring for why, which mirrors
 * the reasoning ADR-0005 already gives for having no `biffo data uninstall`
 * at all: dropping rows a seed created is a genuinely destructive, ambiguous
 * operation (other tenants may depend on the same reference data if the
 * plugin is reinstalled later), and the migration-file precedent this
 * codebase already established (`biffo plugin uninstall` never deletes a
 * plugin's generated Alembic migration either) is to leave permanent,
 * already-applied artifacts alone.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './logger.js'
import type { PluginManifest } from './plugin-manifest.js'

/** Prefix guaranteed not to collide with a `biffo data import`-created name — see the module docstring. */
const VENDOR_PREFIX = '_plugin-'

/** Repo-relative `db/imports/<name>/` directory a plugin's seed vendors into. */
export function pluginSeedImportDir(pluginName: string): string {
  return `db/imports/${VENDOR_PREFIX}${pluginName}`
}

export interface VendorPluginSeedResult {
  /** True if `manifest.seed` was declared and something was vendored. */
  vendored: boolean
  /** Repo-relative path to stage for git add, only set when `vendored`. */
  stagedPath?: string
}

/**
 * Vendors `manifest.seed.dir`'s `*.sql` files (non-recursive, matching
 * `biffo data import`'s own convention) from the plugin's source directory
 * into `cwd`'s `db/imports/_plugin-<name>/`.
 *
 * A plugin that declares no `seed` is completely unaffected: no directory is
 * created, nothing is staged, no behaviour changes. This mirrors the
 * Terraform-module vendoring step's own shape (`if (existsSync(tfSourceDir))`)
 * exactly, for the same reason — an optional declaration that a plugin
 * doesn't make must produce zero footprint, not an empty directory that
 * looks like an unfinished install.
 *
 * Always a full replace of the target directory (see the module docstring's
 * "changed-seed-file edge" section) — safe to call on both install and
 * upgrade/refresh.
 */
export function vendorPluginSeed(
  pluginSourceDir: string,
  manifest: Pick<PluginManifest, 'name' | 'seed'>,
  cwd: string,
): VendorPluginSeedResult {
  if (!manifest.seed) {
    return { vendored: false }
  }

  const sourceSeedDir = join(pluginSourceDir, manifest.seed.dir)
  if (!existsSync(sourceSeedDir)) {
    throw new Error(
      `${manifest.name}'s manifest declares seed.dir '${manifest.seed.dir}', but ` +
        `${sourceSeedDir} does not exist in the plugin's source.`,
    )
  }

  const sqlFiles = readdirSync(sourceSeedDir).filter((f) => f.endsWith('.sql'))
  if (sqlFiles.length === 0) {
    throw new Error(
      `${manifest.name}'s manifest declares seed.dir '${manifest.seed.dir}', but ` +
        `${sourceSeedDir} contains no *.sql files.`,
    )
  }

  const relTargetDir = pluginSeedImportDir(manifest.name)
  const targetDir = join(cwd, relTargetDir)

  // Full replace, like the Terraform module and services/<name>/ itself —
  // see the module docstring for why this is safe (ADR-0005's checksum
  // tracking is what actually enforces the "don't edit an applied file"
  // contract, not this copy).
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  for (const file of sqlFiles) {
    cpSync(join(sourceSeedDir, file), join(targetDir, file))
  }

  log.success(
    `Vendored ${sqlFiles.length} seed file(s) to ${relTargetDir}/ ` +
      `(baseline_tables: ${manifest.seed.baseline_tables.join(', ') || 'none declared'})`,
  )
  log.info(
    `${relTargetDir}/*.sql are checksum-tracked once applied (ADR-0005 section 4) — ` +
      'a later version must ship a new, additively-numbered file for a changed seed, ' +
      'never edit one already released, or the next deploy fails loudly.',
  )

  return { vendored: true, stagedPath: relTargetDir }
}
