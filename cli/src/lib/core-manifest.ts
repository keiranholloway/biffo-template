import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { INSTANCE_CORE_FILE } from './core-version.js'
import { type GitRunner, gitTrackedFiles } from './git-tracked-files.js'

/**
 * The ADR-0006 core-owned path boundary (`core-manifest.json` at the template
 * root). Ownership decides which files a `biffo core diff` / `biffo core
 * upgrade` may touch: only template-owned paths, never user-owned ones.
 */

export const CORE_MANIFEST_FILE = 'core-manifest.json'

const CoreManifestSchema = z.object({
  version: z.literal(1),
  note: z.string().optional(),
  templateOwned: z.array(z.string()).min(1),
  userOwned: z.array(z.string()).default([]),
  /**
   * Paths that version the core but are NOT distributed to instances.
   *
   * `cli/` is the case this exists for. The CLI is released from the same
   * `core-v*` tag as everything else — its published version IS the core
   * version (ADR-0006) — but an instance consumes it from npm and must not
   * carry its source. Without this list a CLI-only change would look like "no
   * template-owned change", the release job would cut nothing, and the fix
   * would never reach npm for any instance to install.
   */
  released: z.array(z.string()).default([]),
})

export type CoreManifest = z.infer<typeof CoreManifestSchema>

// Directories never walked, regardless of the manifest — generated/vendored
// trees that are enormous and never part of a core upgrade.
const HARD_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.venv',
  'dist',
  '.next',
  '.turbo',
  '__pycache__',
  'coverage',
  '.pytest_cache',
  '.ruff_cache',
  // A `terraform init` leaves provider binaries (hundreds of MB) under
  // `.terraform/`; walking into it and reading them as text crashes with
  // "Cannot create a string longer than 0x1fffffe8 characters". Never part
  // of a core upgrade — the tracked terraform is the .tf files, not .terraform/.
  '.terraform',
])

/**
 * Walk up from `startDir` for a Biffo **template** root: a directory holding a
 * core-manifest.json but no `biffo.core.json`. Returns it, or null.
 *
 * The second half is what makes it a *template* root. An instance carries a
 * core-manifest.json too (it is template-owned and distributed), so presence
 * alone would match the instance this CLI is installed into — and `biffo core
 * upgrade` would then resolve the instance as its own upgrade source. The
 * marker used to be a `core.version` file beside the manifest, which instances
 * also carry, so it never actually drew that line; `biffo.core.json` is the
 * same instance discriminator the Release Guards job and the tag job use.
 */
export function findTemplateRoot(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, CORE_MANIFEST_FILE)) && !existsSync(join(dir, INSTANCE_CORE_FILE))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export interface ResolveTemplateRootOptions {
  /** Directory to start the upward search from. Defaults to this module's dir. */
  fromDir?: string
  /**
   * Command-specific guidance appended to the not-found error, telling the user
   * how to point *this* command at a template checkout. Different commands
   * expose different flags for it (`core diff` uses `--template`, `core upgrade`
   * uses `--template-repo`), so the caller supplies the exact remedy — naming a
   * flag the command does not have sends the user down a dead end (issue #324).
   */
  guidance?: string
}

/**
 * Locate the Biffo template root this CLI can compare against. In the monorepo
 * that is the template checkout the CLI lives in. A real instance (CLI installed
 * from npm) cannot self-locate one — `core-manifest.json` is excluded from the
 * published package (issue #315) — so the caller must point it at a checkout and
 * pass command-specific `guidance` on how to do so; automating that fetch is
 * ADR-0006 Phase 3.
 */
export function resolveTemplateRoot(options: ResolveTemplateRootOptions = {}): string {
  const start = options.fromDir ?? dirname(fileURLToPath(import.meta.url))
  const root = findTemplateRoot(start)
  if (!root) {
    const guidance =
      options.guidance ?? 'Point this command at a biffo-template checkout at the target version.'
    throw new Error(
      `Could not locate a Biffo template root (a directory with ${CORE_MANIFEST_FILE} and no ${INSTANCE_CORE_FILE}) above ${start}. ` +
        guidance,
    )
  }
  return root
}

export function readCoreManifest(templateRoot: string): CoreManifest {
  const path = join(templateRoot, CORE_MANIFEST_FILE)
  if (!existsSync(path)) {
    throw new Error(`${CORE_MANIFEST_FILE} not found in ${templateRoot}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${CORE_MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`)
  }
  const result = CoreManifestSchema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues[0]?.message ?? 'unexpected shape'
    throw new Error(`${CORE_MANIFEST_FILE} is invalid: ${detail}`)
  }
  return result.data
}

/** Length of the matching prefix, or -1 if it doesn't match. A prefix ending in
 * '/' matches a directory subtree (startsWith); otherwise it matches an exact
 * file path. */
function matchLength(relPath: string, prefix: string): number {
  if (prefix.endsWith('/')) {
    return relPath === prefix.slice(0, -1) || relPath.startsWith(prefix) ? prefix.length : -1
  }
  return relPath === prefix ? prefix.length : -1
}

function longestMatch(relPath: string, prefixes: readonly string[]): number {
  let best = -1
  for (const p of prefixes) {
    const len = matchLength(relPath, p)
    if (len > best) best = len
  }
  return best
}

/**
 * Whether a repo-relative (posix) path is owned by the template. Longest
 * matching prefix wins; on a tie, user-owned wins — so an upgrade is
 * fail-closed and never touches a path the template doesn't unambiguously own.
 */
export function isTemplateOwned(relPath: string, manifest: CoreManifest): boolean {
  const t = longestMatch(relPath, manifest.templateOwned)
  if (t < 0) return false
  const u = longestMatch(relPath, manifest.userOwned)
  return t > u
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

export interface ListTemplateOwnedFilesOptions {
  /**
   * Restrict the listing to files git tracks at `root` (#1006).
   *
   * Set this for every tree that is meant to represent *the template at a
   * version*. Without it the listing is whatever is on disk, so a gitignored
   * build artifact inside a `templateOwned` prefix — `apps/portal/
   * tsconfig.tsbuildinfo` after a build, `.terraform.lock.hcl` after a
   * `terraform init` — is enumerated as part of the core and proposed for
   * commit into instances, and the change set an instance receives depends on
   * what the operator happened to have built locally.
   *
   * It is deliberately NOT set for an instance's own working tree: the
   * three-way merge is supposed to see the instance exactly as it is.
   *
   * No-op when `root` is not the top level of a git worktree — notably a
   * `git archive <tag>` extraction, which holds only tracked files anyway.
   */
  trackedOnly?: boolean
  /** Injectable git runner, for tests. */
  git?: GitRunner
}

/**
 * All template-owned files under `root`, as sorted repo-relative posix paths.
 * Hard-excluded directories are never descended into.
 */
export function listTemplateOwnedFiles(
  root: string,
  manifest: CoreManifest,
  options: ListTemplateOwnedFilesOptions = {},
): string[] {
  const out: string[] = []
  const tracked = options.trackedOnly
    ? options.git
      ? gitTrackedFiles(root, options.git)
      : gitTrackedFiles(root)
    : null

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && HARD_EXCLUDED_DIRS.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile()) {
        const rel = toPosix(relative(root, abs))
        if (tracked && !tracked.has(rel)) continue
        if (isTemplateOwned(rel, manifest)) out.push(rel)
      }
    }
  }

  walk(root)
  return out.sort()
}

export type ChangeKind = 'added' | 'removed' | 'modified' | 'instance-only'

export interface CoreDiffEntry {
  path: string
  kind: ChangeKind
}

export interface CoreDiff {
  added: string[] // present in the template, absent in the instance (upgrade would add)
  /**
   * The template HAD this file and dropped it, so an upgrade deletes it.
   * Only ever populated when a merge base is supplied — without one, "absent
   * from the template" is not enough to know an upgrade would delete it.
   */
  removed: string[]
  /**
   * Present in the instance, never in the template. An upgrade neither carries
   * nor deletes these (#689): `planCoreUpgrade` removes a path only when it is
   * `inBase && !inTheirs`, so a file the template never shipped cannot be
   * deleted by one.
   *
   * These used to be reported as `removed`, which read as imminent data loss
   * for files an instance legitimately authored inside a template-owned tree.
   * It halted a real deploy and produced an incorrect data-loss issue before
   * anyone ran the dry run that disproves it.
   */
  instanceOnly: string[]
  modified: string[] // present in both, content differs
  unchanged: number
  entries: CoreDiffEntry[]
}

function sameFile(a: string, b: string): boolean {
  // Read both and compare buffers directly — no stat-then-read (that's a
  // check-then-use race, CodeQL js/file-system-race). Core-owned files are
  // source-sized, so reading both in full is cheap.
  return readFileSync(a).equals(readFileSync(b))
}

/**
 * Compare the template-owned files of a template tree against an instance tree.
 * Read-only. `added`/`removed` are from the instance's perspective: what an
 * upgrade to `templateRoot`'s version would add to / remove from the instance.
 */
export function computeCoreDiff(
  templateRoot: string,
  instanceRoot: string,
  manifest: CoreManifest,
  baseRoot?: string,
  options: { git?: GitRunner } = {},
): CoreDiff {
  const trackedOnly: ListTemplateOwnedFilesOptions = options.git
    ? { trackedOnly: true, git: options.git }
    : { trackedOnly: true }
  // Both template-side trees list tracked files only (#1006) — a gitignored
  // build artifact in the operator's checkout is not part of the core, and
  // reporting it as `added` invents a difference that does not exist upstream.
  // The instance tree is read as-is: the whole point is to see it as it is.
  const templateFiles = new Set(listTemplateOwnedFiles(templateRoot, manifest, trackedOnly))
  const instanceFiles = new Set(listTemplateOwnedFiles(instanceRoot, manifest))
  // The template at the instance's CURRENT version — the same merge base
  // `planCoreUpgrade` uses. Without it we cannot tell "the template dropped
  // this" from "the instance added this", so everything absent upstream is
  // reported as instance-only, which is the answer that never overstates.
  const baseFiles = baseRoot
    ? new Set(listTemplateOwnedFiles(baseRoot, manifest, trackedOnly))
    : undefined

  const diff: CoreDiff = {
    added: [],
    removed: [],
    instanceOnly: [],
    modified: [],
    unchanged: 0,
    entries: [],
  }

  for (const rel of [...templateFiles].sort()) {
    if (!instanceFiles.has(rel)) {
      diff.added.push(rel)
      diff.entries.push({ path: rel, kind: 'added' })
    } else if (sameFile(join(templateRoot, rel), join(instanceRoot, rel))) {
      diff.unchanged++
    } else {
      diff.modified.push(rel)
      diff.entries.push({ path: rel, kind: 'modified' })
    }
  }
  for (const rel of [...instanceFiles].sort()) {
    if (templateFiles.has(rel)) continue
    // Mirrors planCoreUpgrade's rule exactly: a path is deleted by an upgrade
    // only when the base had it and the target does not.
    if (baseFiles?.has(rel)) {
      diff.removed.push(rel)
      diff.entries.push({ path: rel, kind: 'removed' })
    } else {
      diff.instanceOnly.push(rel)
      diff.entries.push({ path: rel, kind: 'instance-only' })
    }
  }

  return diff
}
