import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { type CoreManifest, listTemplateOwnedFiles } from './core-manifest.js'

/**
 * The three-way merge engine for `biffo core upgrade` (ADR-0006 Phase 3).
 *
 * Given three trees of template-owned files — `base` (the template at the
 * instance's *current* core version), `ours` (the instance's working tree), and
 * `theirs` (the template at the *target* version) — it decides, per file, what
 * an upgrade should do, preserving instance-local edits to core files wherever
 * they don't collide with upstream changes.
 *
 * This module is pure planning: it computes the merged content and flags
 * conflicts but writes nothing to the instance repo. Applying the plan to a
 * branch and opening a PR is Phase 3b.
 */

export type MergeStatus =
  | 'unchanged' // identical in ours and theirs — nothing to do
  | 'take-theirs' // ours never diverged from base; fast-forward to theirs
  | 'keep-ours' // upstream didn't change it; instance's edit stands
  | 'merged' // ours and theirs both changed, merged cleanly
  | 'conflict' // ours and theirs changed and overlap — needs human resolution
  | 'added' // new upstream file, absent in the instance
  | 'add-conflict' // both sides added the path with different content
  | 'removed' // upstream removed it and the instance hadn't touched it
  | 'remove-conflict' // upstream removed it but the instance had modified it

export interface MergeEntry {
  path: string
  status: MergeStatus
  /** Whether this entry needs human resolution before the upgrade is safe. */
  conflicted: boolean
  /** Resolved content to write for the upgrade, when the status produces one
   * (take-theirs / merged / conflict / added / add-conflict). Undefined for
   * unchanged / keep-ours (leave the instance file as-is) and removed (delete). */
  content?: string
}

export interface UpgradePlan {
  entries: MergeEntry[]
  /** Entries that change the instance (everything except 'unchanged'/'keep-ours'). */
  changes: MergeEntry[]
  conflicts: MergeEntry[]
  summary: Record<MergeStatus, number>
}

/** Runs a three-way merge of three file contents, returning the merged text and
 * whether it conflicted. Injectable so the planner is unit-testable without git. */
export type MergeFileFn = (
  base: string,
  ours: string,
  theirs: string,
) => Promise<{ conflicted: boolean; content: string }>

/** Default MergeFileFn: shells `git merge-file -p` (diff3), the same binary the
 * rest of the CLI uses. Exit code 0 = clean, >0 = conflict count. */
export const gitMergeFile: MergeFileFn = async (base, ours, theirs) => {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-merge-'))
  try {
    const b = join(dir, 'base')
    const o = join(dir, 'ours')
    const t = join(dir, 'theirs')
    writeFileSync(b, base)
    writeFileSync(o, ours)
    writeFileSync(t, theirs)
    const result = await execa('git', ['merge-file', '-p', o, b, t], { reject: false })
    if (typeof result.exitCode !== 'number' || result.exitCode < 0) {
      throw new Error(`git merge-file failed: ${result.stderr}`)
    }
    return { conflicted: result.exitCode > 0, content: result.stdout }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

export interface PlanCoreUpgradeOptions {
  /** Template checkout at the instance's current core version. */
  baseDir: string
  /** The instance repo working tree. */
  oursDir: string
  /** Template checkout at the target core version. */
  theirsDir: string
  manifest: CoreManifest
  mergeFile?: MergeFileFn
}

const EMPTY_SUMMARY: () => Record<MergeStatus, number> = () => ({
  unchanged: 0,
  'take-theirs': 0,
  'keep-ours': 0,
  merged: 0,
  conflict: 0,
  added: 0,
  'add-conflict': 0,
  removed: 0,
  'remove-conflict': 0,
})

/**
 * Compute the upgrade plan. Reads all three trees, classifies each
 * template-owned path, and three-way-merges the ones that changed on both
 * sides. Nothing is written.
 */
export async function planCoreUpgrade(options: PlanCoreUpgradeOptions): Promise<UpgradePlan> {
  const mergeFile = options.mergeFile ?? gitMergeFile
  const base = new Set(listTemplateOwnedFiles(options.baseDir, options.manifest))
  const ours = new Set(listTemplateOwnedFiles(options.oursDir, options.manifest))
  const theirs = new Set(listTemplateOwnedFiles(options.theirsDir, options.manifest))

  const paths = [...new Set([...base, ...ours, ...theirs])].sort()
  const entries: MergeEntry[] = []

  for (const path of paths) {
    entries.push(await classify(path, base, ours, theirs, options, mergeFile))
  }

  const summary = EMPTY_SUMMARY()
  for (const e of entries) summary[e.status]++

  const changes = entries.filter((e) => e.status !== 'unchanged' && e.status !== 'keep-ours')
  const conflicts = entries.filter((e) => e.conflicted)
  return { entries, changes, conflicts, summary }
}

async function classify(
  path: string,
  base: Set<string>,
  ours: Set<string>,
  theirs: Set<string>,
  opts: PlanCoreUpgradeOptions,
  mergeFile: MergeFileFn,
): Promise<MergeEntry> {
  const inBase = base.has(path)
  const inOurs = ours.has(path)
  const inTheirs = theirs.has(path)

  // Added upstream (not in base).
  if (!inBase && inTheirs) {
    const theirsContent = read(opts.theirsDir, path)
    if (!inOurs) return { path, status: 'added', conflicted: false, content: theirsContent }
    const oursContent = read(opts.oursDir, path)
    if (oursContent === theirsContent) return { path, status: 'unchanged', conflicted: false }
    // Both added the same path with different content.
    return { path, status: 'add-conflict', conflicted: true, content: theirsContent }
  }

  // Removed upstream (in base, not in theirs).
  if (inBase && !inTheirs) {
    if (!inOurs) return { path, status: 'removed', conflicted: false } // already gone
    const baseContent = read(opts.baseDir, path)
    const oursContent = read(opts.oursDir, path)
    if (oursContent === baseContent) return { path, status: 'removed', conflicted: false }
    // Upstream deleted a file the instance had modified — needs a human.
    return { path, status: 'remove-conflict', conflicted: true }
  }

  // In base and theirs. (If also not in ours, the instance deleted a core file;
  // treat that like an unmodified take of theirs is wrong — respect the deletion
  // unless theirs changed it, in which case re-add theirs for review.)
  const baseContent = read(opts.baseDir, path)
  const theirsContent = read(opts.theirsDir, path)

  if (!inOurs) {
    if (baseContent === theirsContent) return { path, status: 'removed', conflicted: false }
    return { path, status: 'added', conflicted: false, content: theirsContent }
  }

  const oursContent = read(opts.oursDir, path)
  const oursChanged = oursContent !== baseContent
  const theirsChanged = theirsContent !== baseContent

  if (!theirsChanged) {
    // Upstream didn't touch it; keep whatever the instance has.
    return { path, status: oursChanged ? 'keep-ours' : 'unchanged', conflicted: false }
  }
  if (!oursChanged) {
    // Instance never diverged; fast-forward to theirs.
    return { path, status: 'take-theirs', conflicted: false, content: theirsContent }
  }
  if (oursContent === theirsContent) {
    // Both made the identical change.
    return { path, status: 'unchanged', conflicted: false }
  }
  // Both changed differently — three-way merge.
  const { conflicted, content } = await mergeFile(baseContent, oursContent, theirsContent)
  return { path, status: conflicted ? 'conflict' : 'merged', conflicted, content }
}
