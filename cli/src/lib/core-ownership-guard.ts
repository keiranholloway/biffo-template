import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type CoreManifest, isTemplateOwned } from './core-manifest.js'
import { UPGRADE_BRANCH_PREFIX } from './core-upgrade.js'

/**
 * Refuse changes to template-owned paths *in an instance* (issue #370).
 *
 * `core-manifest.json` declares the ownership boundary and `biffo core upgrade`
 * fail-closes on paths it does not own — but nothing stops an instance editing a
 * template-owned path, and that is where the drift actually comes from. Editing
 * one breaks nothing today; it becomes a merge conflict at the next upgrade,
 * long after the reasoning is gone.
 *
 * The evidence this exists for: `tabsii-platform` sat on core 0.23.3 while the
 * template reached 0.42.0, having taken 98 non-upgrade commits in template-owned
 * paths over six months, with two upgrade branches abandoned partway because
 * each deferral made the next attempt bigger. The upgrade that closed the gap
 * was 316 changes with 41 conflict hunks across 20 files, one of which would
 * have run `CREATE TABLE` against a live database (#366). Every one of those
 * conflicts began as an ordinary commit nobody flagged at the time.
 *
 * ## Direction of the check
 *
 * This is the mirror image of the core.version guard (core-version-guard.ts),
 * and the asymmetry is the whole point:
 *
 *   - **template** — every PR here legitimately edits template-owned paths; that
 *     is what the template is. The guard is inert, and `core.version` is guarded
 *     instead.
 *   - **instance** — template-owned paths arrive by upgrade and leave by
 *     upgrade. Editing them locally is the defect.
 *
 * So a naive `existsSync('core-manifest.json')` probe is wrong: the template has
 * one too, and the guard would block every commit in the repo it ships from.
 * `isInstanceRepo()` (biffo.core.json, written only at `biffo init`) is the
 * correct discriminator.
 *
 * ## Ways past, all of which leave a trace
 *
 *   1. Put the change in a user-owned path — usually the right answer.
 *   2. A `Core-Divergence: <reason>` trailer, so the exception lands in history
 *      rather than being argued about later.
 *   3. A core-upgrade branch, which is exactly when these paths are meant to move.
 *   4. A `biffo.divergence.json` warn-only prefix, for a boundary the instance
 *      knowingly sits astride pending an upstream fix.
 *
 * This is the pure decision function; the runner
 * (scripts/check-core-ownership.ts) supplies the changed files, the branch, the
 * commit message and whether the repo is an instance.
 */

export const DIVERGENCE_FILE = 'biffo.divergence.json'

/**
 * A template-owned prefix this instance knowingly diverges in. Such a path
 * *warns* rather than blocking — a hard block on something that legitimately
 * changes every day only teaches people to reach for `--no-verify`, which costs
 * the guard its meaning everywhere else.
 *
 * `upstream` is not optional by accident: an entry without an issue to close it
 * is permanent drift wearing a temporary label.
 */
const DivergenceEntrySchema = z.object({
  prefix: z.string().min(1),
  reason: z.string().min(1),
  upstream: z.string().min(1),
})

const DivergenceConfigSchema = z.object({
  note: z.string().optional(),
  warnOnly: z.array(DivergenceEntrySchema).default([]),
})

export type DivergenceEntry = z.infer<typeof DivergenceEntrySchema>
export type DivergenceConfig = z.infer<typeof DivergenceConfigSchema>

/**
 * Read `biffo.divergence.json` from an instance root. Absent is the normal case
 * and yields an empty list.
 *
 * A malformed file THROWS rather than degrading to "no warn-only prefixes". The
 * failure modes are not symmetric: silently ignoring a broken config turns
 * every warn into a block, the guard starts refusing commits it was configured
 * to allow, and the reason is invisible. Better to say so.
 */
export function readDivergenceConfig(repoRoot: string): DivergenceConfig {
  const path = join(repoRoot, DIVERGENCE_FILE)
  if (!existsSync(path)) return { warnOnly: [] }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${DIVERGENCE_FILE} is not valid JSON: ${(err as Error).message}`)
  }

  const parsed = DivergenceConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`${DIVERGENCE_FILE} is invalid:\n${issues}`)
  }
  return parsed.data
}

/**
 * Extract the reason from a `Core-Divergence:` trailer, or null.
 *
 * Anchored per-line (`m`) rather than searched loosely, so the trailer must be
 * its own line — a passing mention of the words inside prose is not an opt-out.
 */
export function parseDivergenceTrailer(commitMessage: string): string | null {
  // Comment lines are git's own scissors/help text in the editor buffer, never
  // part of the recorded message.
  const body = commitMessage
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
  const match = /^Core-Divergence:[ \t]*(\S.*?)[ \t]*$/m.exec(body)
  return match?.[1] ?? null
}

export type OwnershipSkipReason = 'template' | 'upgrade-branch' | 'divergence-trailer'

export interface OwnershipCheckInput {
  changedFiles: string[]
  manifest: CoreManifest
  /**
   * Required, deliberately — unlike the core.version guard, this one's polarity
   * is inverted (an *instance* is the enforcing side), so either default is a
   * trap: defaulting to template silently disables the guard where it matters,
   * defaulting to instance blocks every commit in the template. `isInstanceRepo`
   * answers it from the filesystem, so no caller genuinely cannot tell.
   */
  isInstance: boolean
  /** Current branch, if resolvable. A detached HEAD or fresh repo yields ''. */
  branch?: string
  /** Commit message, when checking a commit rather than a PR diff. */
  commitMessage?: string
  warnOnly?: DivergenceEntry[]
}

export interface OwnershipCheckResult {
  /** Why the check let everything through, or null if it actually ran. */
  skipped: OwnershipSkipReason | null
  /** Template-owned changes that block. */
  blocked: string[]
  /** Template-owned changes matched by a warn-only prefix. */
  warned: { path: string; entry: DivergenceEntry }[]
  /** Reason from the `Core-Divergence:` trailer, when one allowed the change. */
  divergenceReason: string | null
}

export function checkCoreOwnership({
  changedFiles,
  manifest,
  isInstance,
  branch = '',
  commitMessage = '',
  warnOnly = [],
}: OwnershipCheckInput): OwnershipCheckResult {
  const empty = { blocked: [], warned: [], divergenceReason: null }

  // The template owns these paths; editing them is its purpose.
  if (!isInstance) return { skipped: 'template', ...empty }

  // A core upgrade is precisely when template-owned paths are meant to change.
  if (branch.startsWith(UPGRADE_BRANCH_PREFIX)) return { skipped: 'upgrade-branch', ...empty }

  const templateOwned = changedFiles.filter((f) => isTemplateOwned(f, manifest))

  // Longest matching prefix, so a specific entry can sit inside a broad one and
  // the more specific reason is the one reported.
  const acknowledged = (path: string): DivergenceEntry | undefined =>
    warnOnly
      .filter((entry) => path.startsWith(entry.prefix))
      .reduce<DivergenceEntry | undefined>(
        (best, entry) => (!best || entry.prefix.length > best.prefix.length ? entry : best),
        undefined,
      )

  const warned: OwnershipCheckResult['warned'] = []
  const offending: string[] = []
  for (const path of templateOwned) {
    const entry = acknowledged(path)
    if (entry) warned.push({ path, entry })
    else offending.push(path)
  }

  // The explicit, recorded opt-out. Warnings still surface — the trailer excuses
  // the block, it does not make the drift stop existing.
  const divergenceReason = parseDivergenceTrailer(commitMessage)
  if (offending.length > 0 && divergenceReason !== null) {
    return { skipped: 'divergence-trailer', blocked: [], warned, divergenceReason }
  }

  return { skipped: null, blocked: offending, warned, divergenceReason: null }
}
