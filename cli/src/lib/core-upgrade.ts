import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { type CoreManifest, listTemplateOwnedFiles } from './core-manifest.js'
import { readDivergenceConfig } from './core-ownership-guard.js'

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
  | 'restored' // template-owned file the instance deleted — re-added (#395)
  | 'removed' // upstream removed it and the instance hadn't touched it
  | 'remove-conflict' // upstream removed it but the instance had modified it

export interface MergeEntry {
  path: string
  status: MergeStatus
  /** Whether this entry needs human resolution before the upgrade is safe. */
  conflicted: boolean
  /** Resolved content to write for the upgrade, when the status produces one
   * (take-theirs / merged / conflict / added / add-conflict / restored). Undefined
   * for unchanged / keep-ours (leave the instance file as-is) and removed (delete). */
  content?: string
}

export interface UpgradePlan {
  entries: MergeEntry[]
  /** Entries that change the instance (everything except 'unchanged'/'keep-ours'). */
  changes: MergeEntry[]
  conflicts: MergeEntry[]
  summary: Record<MergeStatus, number>
  /** Template-owned files the instance deleted that would have been restored
   * (#395) but were left absent because the instance declared the path an
   * intentional divergence in `biffo.divergence.json`. Reported, not acted on. */
  divergenceSkips?: string[]
}

/** Runs a three-way merge of three file contents, returning the merged text and
 * whether it conflicted. Injectable so the planner is unit-testable without git. */
export type MergeFileFn = (
  base: string,
  ours: string,
  theirs: string,
) => Promise<{ conflicted: boolean; content: string }>

/** Default MergeFileFn: shells `git merge-file -p` (diff3), the same binary the
 * rest of the CLI uses. Exit code 0 = clean, >0 = conflict count.
 *
 * `stripFinalNewline: false` is load-bearing (#392). execa strips the final
 * newline from stdout by default, which is right for a value you are about to
 * parse and wrong for one you are about to write to a file — and this one is
 * written verbatim into the instance. Left on, every merged file lands without
 * its trailing newline: ruff W292 for Python, prettier --check for everything
 * else, and a spurious "\ No newline at end of file" hunk in a diff a human has
 * to review.
 *
 * It is invisible here, because the template never upgrades itself. The first
 * place it shows up is an instance's PR, where it reads like the instance's
 * fault. */
export const gitMergeFile: MergeFileFn = async (base, ours, theirs) => {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-merge-'))
  try {
    const b = join(dir, 'base')
    const o = join(dir, 'ours')
    const t = join(dir, 'theirs')
    writeFileSync(b, base)
    writeFileSync(o, ours)
    writeFileSync(t, theirs)
    const result = await execa('git', ['merge-file', '-p', o, b, t], {
      reject: false,
      stripFinalNewline: false,
    })
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
  restored: 0,
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

  // A template-owned file the instance deleted is drift (#370 blocks instances
  // from editing these paths), so an upgrade restores it (#395) — unless the
  // instance declared that path an intentional divergence, which is the governed
  // way to keep it deleted. Reuse the same biffo.divergence.json the ownership
  // guard reads; a malformed file throws here too, which is the right failure.
  const divergentPrefixes = readDivergenceConfig(options.oursDir).warnOnly.map((e) => e.prefix)
  const isDeclaredDivergent = (path: string): boolean =>
    divergentPrefixes.some((prefix) => path.startsWith(prefix))

  const paths = [...new Set([...base, ...ours, ...theirs])].sort()
  const entries: MergeEntry[] = []
  const divergenceSkips: string[] = []

  for (const path of paths) {
    entries.push(
      await classify(path, base, ours, theirs, options, mergeFile, isDeclaredDivergent, (p) =>
        divergenceSkips.push(p),
      ),
    )
  }

  const summary = EMPTY_SUMMARY()
  for (const e of entries) summary[e.status]++

  const changes = entries.filter((e) => e.status !== 'unchanged' && e.status !== 'keep-ours')
  const conflicts = entries.filter((e) => e.conflicted)
  return { entries, changes, conflicts, summary, divergenceSkips }
}

async function classify(
  path: string,
  base: Set<string>,
  ours: Set<string>,
  theirs: Set<string>,
  opts: PlanCoreUpgradeOptions,
  mergeFile: MergeFileFn,
  isDeclaredDivergent: (path: string) => boolean,
  noteDivergenceSkip: (path: string) => void,
): Promise<MergeEntry> {
  const inBase = base.has(path)
  const inOurs = ours.has(path)
  const inTheirs = theirs.has(path)

  // Present only in the instance — added locally under a template-owned path
  // (e.g. an instance-specific ADR or a file the template never shipped). There
  // is no base or upstream version to merge against, so leave it untouched
  // rather than trying to read a non-existent base/theirs copy.
  if (!inBase && !inTheirs) {
    return { path, status: 'keep-ours', conflicted: false }
  }

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

  // In base and theirs.
  const baseContent = read(opts.baseDir, path)
  const theirsContent = read(opts.theirsDir, path)

  if (!inOurs) {
    // The instance deleted a template-owned file the template still ships. That
    // is drift by definition — the ownership boundary says the template owns this
    // path and #370 stops instances from editing it — so restore it (#395),
    // listed distinctly so it is visible in the PR rather than silently absent.
    // The one exception: a path the instance declared an intentional divergence
    // in biffo.divergence.json is deliberately kept deleted; record the skip so
    // the state is reported, not invisible.
    if (isDeclaredDivergent(path)) {
      noteDivergenceSkip(path)
      return { path, status: 'removed', conflicted: false }
    }
    return { path, status: 'restored', conflicted: false, content: theirsContent }
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

export interface ApplyResult {
  written: string[]
  deleted: string[]
}

/**
 * Apply an upgrade plan to the instance working tree (ADR-0006 Phase 3b).
 * Writes resolved content (take-theirs / merged / added, and conflict entries
 * *with their conflict markers* so the PR surfaces them), and deletes cleanly-
 * removed files. Leaves unchanged / keep-ours / remove-conflict files as they
 * are. The caller is responsible for staging/committing the result.
 */
export function applyUpgradePlan(
  instanceDir: string,
  plan: UpgradePlan,
  theirsDir?: string,
): ApplyResult {
  const written: string[] = []
  const deleted: string[] = []
  for (const e of plan.entries) {
    const abs = join(instanceDir, e.path)
    if (e.status === 'removed') {
      if (existsSync(abs)) {
        rmSync(abs)
        deleted.push(e.path)
      }
      continue
    }
    if (e.content !== undefined) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, e.content)
      // Mirror the executable bit from upstream. `writeFileSync` creates 0644,
      // so without this a shell script delivered by an upgrade arrives
      // non-executable and every `./script.sh` invocation in the instance dies
      // with "Permission denied". Latent until #440 shipped the first
      // executable an upgrade had ever *added* (scripts/biffo.sh) — one an
      // instance's CI runs on every job.
      if (theirsDir !== undefined) {
        const source = join(theirsDir, e.path)
        if (existsSync(source) && (statSync(source).mode & 0o111) !== 0) {
          chmodSync(abs, 0o755)
        }
      }
      written.push(e.path)
    }
  }
  return { written, deleted }
}

/** Parse a GitHub owner/repo from an SSH or HTTPS remote URL (tokenised HTTPS
 * userinfo, if present, is ignored). Throws if it isn't a recognisable GitHub URL. */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } {
  const ssh = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl)
  if (ssh && ssh[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl)
  if (https && https[1] && https[2]) return { owner: https[1], repo: https[2] }
  throw new Error(`Could not parse a GitHub owner/repo from remote URL: ${remoteUrl}`)
}

/**
 * Prefix of every core-upgrade branch. Exported because the ownership guard
 * (core-ownership-guard.ts) exempts these branches — a core upgrade is precisely
 * when template-owned paths are meant to change — and a guard that recognises a
 * *different* prefix from the one the upgrade actually creates would block the
 * one workflow it must let through.
 */
export const UPGRADE_BRANCH_PREFIX = 'biffo/core-upgrade-'

/** Branch name for a core-upgrade PR, sanitised to safe git ref characters. */
export function upgradeBranchName(from: string, to: string): string {
  return `${UPGRADE_BRANCH_PREFIX}${from}-to-${to}`.replace(/[^a-zA-Z0-9._/-]/g, '-')
}
