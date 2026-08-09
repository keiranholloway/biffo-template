import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreTag } from './core-template-trees.js'
import type { MergeEntry } from './core-upgrade.js'

/**
 * Assert that what an upgrade is about to distribute really is the target tag
 * (#1399).
 *
 * ## Why this exists
 *
 * `biffo core upgrade --to X` has exactly one contract: *give me template
 * version X*. On 2026-08-09 it gave `tabsii-platform` a `scripts/pg-test-db.sh`
 * that existed in no tag, no release and no other instance — 120 lines that
 * lived only in an unmerged worktree branch belonging to another session
 * (tabsii-com/tabsii-platform#825).
 *
 * **Nothing downstream could have caught it.** The content was good code. It
 * passed every check the instance has, because it is not malformed, not a
 * secret and not a syntax error — it is simply not released yet. The upgrade
 * reported success. It surfaced by accident, because the divergence-pin guard
 * reported one more modified file than recorded and somebody *read* the extra
 * one instead of bumping the number.
 *
 * ## Why the check is worth having even though the mechanism is unknown
 *
 * The issue lists three candidate mechanisms and this module commits to none of
 * them. That is deliberate. An upgrade can assert **its own output** without
 * knowing why a resolution went wrong: every byte it writes verbatim from
 * upstream must equal that path's content at the target tag, and the tag is
 * readable independently, from git, at the moment of the check.
 *
 * That independence is the whole point, and it is the estate's recorded
 * `class:fail-open` posture (#1362) applied to the upgrade itself: **a guard
 * must read a different document from the one that acts.** The planner reads
 * the *tree on disk* at `theirsDir`; this reads the *tag object* from the
 * template repo. When the two agree, the resolution was faithful whatever path
 * produced it. When they disagree, the upgrade stops — loudly, naming the file
 * — instead of shipping unreviewed content behind a green result.
 *
 * ## What is checked, and what is deliberately not
 *
 * Four statuses carry content copied **verbatim** from upstream, so they must
 * equal the tag byte for byte: `take-theirs`, `added`, `add-conflict` and
 * `restored`.
 *
 * `merged` and `conflict` produce a three-way merge result that legitimately
 * differs from the tag — so their *output* is unverifiable here. Their
 * **input** is not, and it is the input the bug corrupts: this reads the
 * `theirsDir` copy for those paths and holds it to the same standard. That
 * matters because a wrong-source upgrade would otherwise be invisible on
 * exactly the paths where an instance has diverged, which is where review
 * attention is scarcest.
 *
 * `unchanged`, `keep-ours`, `removed` and `remove-conflict` write no upstream
 * content, so there is nothing to hold to the tag.
 */

/** Statuses whose `content` is copied verbatim from the target tree. */
const VERBATIM_STATUSES = new Set(['take-theirs', 'added', 'add-conflict', 'restored'])

/** Statuses whose content is derived from — but not equal to — the target. */
const DERIVED_STATUSES = new Set(['merged', 'conflict'])

export type FidelityReason =
  /** The tag has this path, and its content is not what the upgrade resolved. */
  | 'content-differs'
  /** The upgrade resolved content for a path the target tag does not contain. */
  | 'absent-from-tag'

export interface FidelityFinding {
  path: string
  reason: FidelityReason
  /** Which half of the plan surfaced it — verbatim output, or merge input. */
  source: 'output' | 'merge-input'
}

export interface FidelityReport {
  /** Number of paths held to the tag. */
  checked: number
  findings: FidelityFinding[]
  /**
   * Set when there is no tag to check against, so the caller can say so rather
   * than imply a verification that never ran. `null` when the check did run.
   */
  unverifiable: string | null
}

/** Injectable git runner, mirroring `core-template-trees.ts`. */
export type GitRunner = (args: string[]) => string

const defaultGit: GitRunner = (args) => execFileSync('git', args, { encoding: 'utf8' })

/**
 * The git blob id of `content`, computed in process.
 *
 * Lets one `ls-tree` answer for the whole plan instead of spawning `git show`
 * per file. A blob id is `sha1("blob <byte-length>\0" + bytes)` — the same
 * value `git hash-object` prints, and the same one `ls-tree` reports.
 */
function blobId(content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex')
}

/**
 * Every path in the tag, mapped to its blob id.
 *
 * `ls-tree -r` is used without `--format` on purpose: the format flag needs a
 * newer git than the estate's floor, and the default `<mode> <type> <id>\t<path>`
 * line is stable across every version. Paths with unusual bytes come back
 * quoted; `-z` avoids that entirely by NUL-separating records and disabling
 * quoting, so a path is taken literally rather than parsed out of a C-style
 * string.
 */
function tagBlobIds(repo: string, tag: string, git: GitRunner): Map<string, string> {
  const out = git(['-C', repo, 'ls-tree', '-r', '-z', tag])
  const blobs = new Map<string, string>()
  for (const record of out.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const meta = record.slice(0, tab).split(' ')
    const id = meta[2]
    // Only blobs — a submodule entry (`commit`) has an id that names no content
    // and would otherwise read as a path whose bytes never match anything.
    if (meta[1] !== 'blob' || id === undefined) continue
    blobs.set(record.slice(tab + 1), id)
  }
  return blobs
}

export interface AssertTargetFidelityOptions {
  entries: MergeEntry[]
  /** The template repo the tag is read from — the same one the trees came from. */
  templateRepo: string
  /** Target core version; `core-v<version>` must exist in `templateRepo`. */
  toVersion: string
  /** The resolved target tree, for reading merge inputs. */
  theirsDir: string
  /**
   * True when the caller supplied the target tree explicitly (`--to-template`).
   * An arbitrary checkout has no tag to be faithful to, so the check cannot run
   * — and says so, rather than passing silently.
   */
  explicitTargetTree?: boolean
  git?: GitRunner
}

/**
 * Hold an upgrade plan to the target tag. Reports rather than throws, so the
 * caller decides how loud to be and can print the findings before failing.
 */
export function assertTargetFidelity(options: AssertTargetFidelityOptions): FidelityReport {
  const git = options.git ?? defaultGit

  if (options.explicitTargetTree === true) {
    return {
      checked: 0,
      findings: [],
      unverifiable:
        'the target tree was supplied explicitly (--to-template), so there is no tag to ' +
        'compare against. Re-run with --to <version> to have the upgrade verify its own output.',
    }
  }

  const tag = coreTag(options.toVersion)
  let blobs: Map<string, string>
  try {
    blobs = tagBlobIds(options.templateRepo, tag, git)
  } catch (err) {
    // Cannot-tell is never a pass (AGENTS.md §5/§6). The tag was readable
    // moments ago — the trees came from it — so a failure here is a real
    // anomaly, not a routine absence, and it must not read as "verified".
    return {
      checked: 0,
      findings: [],
      unverifiable:
        `could not read ${tag} from ${options.templateRepo} to verify the upgrade's own ` +
        `output: ${(err as Error).message}`,
    }
  }

  const findings: FidelityFinding[] = []
  let checked = 0

  for (const entry of options.entries) {
    let content: string | undefined
    let source: 'output' | 'merge-input'
    if (VERBATIM_STATUSES.has(entry.status)) {
      content = entry.content
      source = 'output'
    } else if (DERIVED_STATUSES.has(entry.status)) {
      const abs = join(options.theirsDir, entry.path)
      content = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined
      source = 'merge-input'
    } else {
      continue
    }
    if (content === undefined) continue

    checked++
    const expected = blobs.get(entry.path)
    if (expected === undefined) {
      findings.push({ path: entry.path, reason: 'absent-from-tag', source })
      continue
    }
    if (blobId(content) === expected) continue

    // A blob-id mismatch can also mean the bytes did not survive being read as
    // UTF-8 — the planner reads every tree that way, so a file that is not
    // valid UTF-8 is already lossy before it reaches here, and reporting it as
    // unreleased content would be a false alarm about the wrong thing.
    // Re-compare through the same encoding on both sides to rule that out.
    let tagText: string
    try {
      tagText = git(['-C', options.templateRepo, 'show', `${tag}:${entry.path}`])
    } catch {
      findings.push({ path: entry.path, reason: 'content-differs', source })
      continue
    }
    if (tagText !== content) {
      findings.push({ path: entry.path, reason: 'content-differs', source })
    }
  }

  return { checked, findings, unverifiable: null }
}

/** The operator-facing failure text for a report that found something. */
export function fidelityFailure(report: FidelityReport, toVersion: string): string {
  const lines = report.findings.map((f) => {
    const why =
      f.reason === 'absent-from-tag'
        ? 'resolved content for a path the tag does not contain'
        : 'content differs from the tag'
    return `  ${f.path} — ${why} (${f.source})`
  })
  return (
    `This upgrade resolved content that is not what core-v${toVersion} ships, for ` +
    `${String(report.findings.length)} of ${String(report.checked)} checked path(s):\n` +
    `${lines.join('\n')}\n\n` +
    'An upgrade must be reproducible from a version number, so this is refused rather ' +
    'than distributed (#1399). The content came from somewhere other than the tag — a ' +
    'stale or wrong template checkout, or an unmerged branch. Verify the template repo ' +
    'is at the target tag and re-run; do not commit the plan as-is.'
  )
}
