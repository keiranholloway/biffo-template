import { isUtf8 } from 'node:buffer'
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
import { basename, dirname, join } from 'node:path'
import { execa } from './exec.js'
import { z } from 'zod'
import {
  CORE_MANIFEST_FILE,
  type CoreManifest,
  isTemplateOwned,
  listTemplateOwnedFiles,
  readCoreManifest,
} from './core-manifest.js'
import { parseDivergenceTrailer, readDivergenceConfig } from './core-ownership-guard.js'
import { defaultGit, type GitRunner, gitTrackedFiles } from './git-tracked-files.js'

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
 *
 * ## Binary content (#1506)
 *
 * Every file is read as raw bytes (`readFile` below) and decoded to a string
 * ONLY when that decoding is lossless UTF-8 (`node:buffer`'s `isUtf8`, not a
 * latin1 round-trip — latin1 accepts every byte sequence, so it can never
 * tell a binary file from text and would silently "succeed" at corrupting
 * one). A file that is not valid UTF-8 is carried as a `Buffer`, verbatim,
 * through every status that produces content, and is NEVER routed through
 * `mergeFile` — `git merge-file` treats its input as lines of text, and its
 * own stdout capture is a string (execa decodes it), so a binary reaching
 * that path would be corrupted a second time even if the read above hadn't
 * been. A binary cannot be three-way merged in any meaningful sense anyway:
 * the two honest resolutions are take-theirs or keep-ours, and every status
 * below already reduces to one of those for binary content — see `classify`.
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
   * for unchanged / keep-ours (leave the instance file as-is) and removed (delete).
   *
   * `string` for a file whose bytes decode as valid UTF-8 — every existing
   * text-oriented behaviour (three-way merge, conflict markers, trailing
   * newline handling) is unchanged. A `Buffer` here means the file is NOT
   * valid UTF-8 and was never decoded: it is the source bytes, verbatim,
   * exactly as read from disk (#1506). `writeFileSync` accepts both, so
   * `applyUpgradePlan` needs no branch on which one it got — but nothing else
   * may re-derive a string from this Buffer, or the byte-for-byte guarantee
   * breaks the same way it did before the fix. */
  content?: string | Buffer
  /**
   * True only for the subset of `keep-ours` entries produced when a
   * template-owned path exists SOLELY in the instance — no base, no theirs
   * (#1026). That is the unsanctioned-drift case the orphan report exists
   * for: an instance file with no template counterpart at all, sitting under
   * a path the manifest says the template owns. A `keep-ours` produced
   * because the instance merely edited a file the template still ships
   * unchanged (the other origin of this status, below) has a template
   * counterpart and is never flagged — it is ordinary drift the next upstream
   * change will three-way-merge normally, not an orphan.
   *
   * A legitimate instance file under a sanctioned carve-out (e.g.
   * `services/api/tests/instance/`) never reaches `classify()` at all: it
   * resolves user-owned via the manifest's longest-prefix-wins, so it is
   * never enumerated as one of `ours`'s template-owned paths in the first
   * place. This flag is reused, not re-derived, by `planCoreUpgrade`'s
   * `orphaned` list — see there for the gitignore/untracked filter applied on
   * top of it.
   *
   * `false` when the path is instead declared divergent — either a `warnOnly`
   * entry in `biffo.divergence.json` (#1602), or a `Core-Divergence:` trailer
   * recorded against the path in the instance's own git history (#1718). Both
   * are the SAME acceptance the commit-time `checkCoreOwnership` guard already
   * grants the path via its two independent routes, so the ratchet treats
   * either as sanctioned rather than re-deciding the question from a count
   * nobody reads prose against.
   */
  orphaned?: boolean
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
  /**
   * Unsanctioned instance files under a template-owned path with no template
   * counterpart (#1026): the `orphaned` `keep-ours` entries, minus any path
   * that is gitignored or untracked in the instance tree (a build artifact
   * inside a template-owned prefix is not a classification target — same
   * reasoning as the tracked-only filter #1006 applies to the merge itself).
   * Reported by `biffo core upgrade` and ratcheted against a per-instance
   * baseline (`ORPHAN_BASELINE_FILE`); never acted on here.
   */
  orphaned: MergeEntry[]
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

/**
 * One file snapshot, read exactly once as raw bytes (#1506).
 *
 * `buffer` is the single source of truth for both equality and for what
 * eventually gets written back — every comparison below reads `.buffer`,
 * never a decoded string, so it is correct for text and binary alike (for
 * valid UTF-8, byte equality and decoded-string equality are the same fact,
 * since a valid UTF-8 decode is injective; for anything else there IS no
 * string to compare).
 *
 * `text` is the UTF-8 decoding of `buffer`, but ONLY when that decoding is
 * lossless (`isUtf8`, not a latin1 round-trip — see the module docstring).
 * `null` means the file is binary: every branch below must treat a null
 * `text` as "do not decode, do not hand this to the text merge engine."
 */
interface FileRead {
  buffer: Buffer
  text: string | null
}

function readFile(root: string, rel: string): FileRead {
  const buffer = readFileSync(join(root, rel))
  return { buffer, text: isUtf8(buffer) ? buffer.toString('utf8') : null }
}

/** What to hand back as `MergeEntry.content`: the decoded string for text (so
 * every existing string-typed caller — trailing-newline checks, the target
 * fidelity blob-id comparison, tests — keeps working unchanged), the raw
 * Buffer otherwise. Never a lossy re-encoding either way. */
function contentOf(file: FileRead): string | Buffer {
  return file.text ?? file.buffer
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
  /** Injectable git runner, for tests — used only to filter `oursDir` for the
   * `orphaned` report (#1026), never to change what the merge itself sees. */
  git?: GitRunner
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
 * Whether a `Core-Divergence:` trailer somewhere in `path`'s history is
 * actually a declaration *for that path*, not merely a declaration that
 * happened to share a commit with it (#1718, corrected after #1815/#1812).
 *
 * `checkCoreOwnership` (core-ownership-guard.ts) has always accepted a
 * template-owned path via TWO independent routes: a `biffo.divergence.json`
 * `warnOnly` entry, or a bare `Core-Divergence: <reason>` trailer on the commit
 * — and its own printed guidance names the trailer as a way past. #1602/#1717
 * unified the *first* route into this ratchet's `isDeclaredDivergent`, but never
 * the second: an operator who declared divergence exactly the way the guard's
 * own message suggested still hit an "orphan" at the next `biffo core upgrade`,
 * green at commit time and refused later, in front of whoever else was mid
 * upgrade. This closes that gap by reusing `parseDivergenceTrailer` — the same
 * parser the commit-time guard reads — rather than re-deriving trailer parsing
 * a second time, so the two acceptance routes cannot drift onto different
 * definitions of "declared".
 *
 * ## The path-binding problem (#1815)
 *
 * A `Core-Divergence:` trailer is free text with no required binding to any
 * specific path, but a commit's *diff* can touch many paths. The first version
 * of this function conflated "this commit's diff touched `path`" with "this
 * commit's trailer is ABOUT `path`" — so a single, correctly-scoped divergence
 * declared once on an ordinary multi-file `core-upgrade` squash commit (the
 * most common real shape carrying this trailer — see `3f27545e` in
 * `biffo-platform`, which declares divergence for `package.json` alone while
 * its diff also touches 167 other template-owned paths) permanently amnestied
 * every OTHER template-owned path that commit happened to also touch, for the
 * lifetime of the repository. Swept live: 18.6% of `biffo-platform`'s tracked
 * files read as "declared" purely by this coincidence.
 *
 * A commit's trailer is now trusted for `path` only when EITHER:
 *
 * 1. **the commit is unambiguous** — its diff touches exactly one
 *    template-owned path (per `manifest`), so there is nothing else the
 *    trailer could be about; or
 * 2. **the trailer names the path** — its reason text contains `path` (or
 *    just its basename, since that is how every real trailer in this estate's
 *    history actually refers to a file: `"package.json keeps this instance's
 *    bounded undici override"`, `"adds an instance-owned
 *    .github/workflows/rls-tests.yml under a"`) at a token boundary, so
 *    `manifest.json` cannot be read out of `core-manifest.json`.
 *
 * (1) alone covers every fixture in this module's own tests (each commits
 * exactly one file). (2) is what recovers `package.json` from the real
 * `3f27545e`-shaped squash commit without also amnestying its 167
 * co-committed, undeclared neighbours — and is why the reason text must
 * actually name a file for a multi-file commit to count at all.
 *
 * ## Shallow clones (#1812)
 *
 * `orphan-ratchet-report.yml`, the one caller that runs against real,
 * unmodified estate data, clones each instance with `--depth 1`. Against a
 * shallow clone, `git log --follow -- <path>` does not error — instead, with
 * no local parent to diff the boundary commit against, git conservatively
 * reports that lone commit as touching EVERY path in the tree, so criterion
 * (1) above ("exactly one template-owned path") is never satisfied by
 * accident (a shallow boundary commit's apparent diff is essentially the
 * whole tree) but criterion (2) could still fire on a coincidental basename
 * mention. Rather than rely on that, any commit identified as a shallow
 * grafted boundary (`git rev-list --max-parents=0 HEAD` under
 * `--is-shallow-repository`) is excluded from consideration entirely — its
 * file-touch attribution cannot be trusted, so neither criterion may use it.
 * Under a `--depth 1` clone the only commit visible generally IS that
 * boundary, so this — correctly — turns the trailer route into a no-op there
 * rather than a false "declared" for whatever the tip commit's trailer
 * mentions; a deeper or full clone recovers the real behaviour.
 *
 * `git log --follow`, not just the tip commit: the declaration only needs to
 * have been made once, on whichever commit introduced or last touched the
 * path, and `--follow` keeps it findable across a rename the same way
 * `parseNameStatus`'s destination-path convention (core-ownership-guard.ts)
 * already treats a rename's target as the path of record.
 *
 * Fails CLOSED (returns `false`) whenever git cannot answer — no repo, no
 * history for the path, or any other error. This is the opposite of
 * `gitTrackedFiles`'s fail-OPEN contract: there, silence means "don't filter",
 * which is the safe default for a filter. Here, silence must NOT be read as
 * "declared" — that would turn every un-inspectable tree (exactly the plain
 * temp directories this module's own tests build) into a free pass for the
 * orphan ratchet this function feeds, which is the opposite of what #1602
 * fixed and what #1718 extends.
 */
export function pathHasDivergenceTrailerInHistory(
  oursDir: string,
  path: string,
  manifest: CoreManifest,
  git: GitRunner = defaultGit,
): boolean {
  let out: string
  try {
    out = git(['-C', oursDir, 'log', '--follow', '--format=%x02%H%x01%B', '--', path])
  } catch {
    return false
  }
  const entries = out
    .split('\x02')
    .map((entry) => entry.split('\x01'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '')

  // Commits carrying no trailer at all can never satisfy either criterion —
  // filter first so the (comparatively expensive) shallow-graft check below
  // only runs when it could actually change the answer.
  const withTrailer = entries.filter(([, message]) => parseDivergenceTrailer(message) !== null)
  if (withTrailer.length === 0) return false

  const graftedBoundary = shallowGraftCommits(oursDir, git)

  for (const [hash, message] of withTrailer) {
    if (graftedBoundary.has(hash)) continue

    let touched: string[]
    try {
      // `--root` is required or a ROOT commit (no parent) reports NO files at
      // all — diff-tree's default behaviour for a merge/root commit is to
      // print nothing rather than diff against the empty tree — which would
      // silently make criterion (1) below untriggerable for the single most
      // common shape a brand-new fixture (or a squashed repo's own initial
      // commit) produces.
      touched = git([
        '-C',
        oursDir,
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '--root',
        hash,
      ])
        .split('\n')
        .filter((p) => p !== '')
    } catch {
      touched = []
    }
    const templateOwnedTouched = touched.filter((p) => isTemplateOwned(p, manifest))
    // Not just "exactly one template-owned path in the diff" — that path must
    // BE the one being queried. Without this, a commit that touches one
    // template-owned file (e.g. package.json) alongside any number of
    // user-owned ones (README.md, pnpm-lock.yaml — the real `c88e158a` shape)
    // would satisfy criterion (1) for every user-owned path it also touched,
    // not only for the template-owned one it actually applies to.
    if (templateOwnedTouched.length === 1 && templateOwnedTouched[0] === path) return true

    const reason = parseDivergenceTrailer(message)
    if (reason !== null && trailerNamesPath(reason, path)) return true
  }
  return false
}

/**
 * The commit hashes a `--depth`-limited clone has grafted history onto — the
 * ones whose file-touch attribution cannot be trusted (see the shallow-clone
 * section of `pathHasDivergenceTrailerInHistory`'s docstring above). A
 * genuine, non-shallow repository's own initial commit also has no parent and
 * would show up here too, but that is harmless: a real root commit's apparent
 * "touches everything" diff is correct, not an artifact, and `is-shallow-
 * repository` gates this to only the case where it is not.
 *
 * Returns an empty set — trust every commit — whenever git cannot answer, so
 * a failure here never turns into an *additional* false "declared"; it only
 * ever removes trust criterion (1)/(2) above already require.
 */
function shallowGraftCommits(oursDir: string, git: GitRunner): Set<string> {
  let isShallow: string
  try {
    isShallow = git(['-C', oursDir, 'rev-parse', '--is-shallow-repository']).trim()
  } catch {
    return new Set()
  }
  if (isShallow !== 'true') return new Set()
  try {
    const out = git(['-C', oursDir, 'rev-list', '--max-parents=0', 'HEAD'])
    return new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    )
  } catch {
    return new Set()
  }
}

/**
 * Whether a divergence trailer's reason text actually names `path` — either
 * the full path or just its basename (how every real trailer in this
 * estate's history refers to a file), at a token boundary so `manifest.json`
 * cannot be read out of the middle of `core-manifest.json`.
 *
 * `/` is deliberately NOT a boundary-breaking character: a trailer that lists
 * several files as `claim/branch-health/wait-for-checks/practices-daily.sh`
 * (a real shorthand seen in this estate's history) still resolves
 * `practices-daily.sh` correctly, because the character before it is a slash
 * separating list items, not a character that would make it part of a longer,
 * different filename.
 */
function trailerNamesPath(reason: string, path: string): boolean {
  const isBoundary = (ch: string | undefined): boolean =>
    ch === undefined || !/[A-Za-z0-9_.-]/.test(ch)
  const namedAt = (needle: string): boolean => {
    if (needle === '') return false
    let idx = 0
    for (;;) {
      idx = reason.indexOf(needle, idx)
      if (idx === -1) return false
      if (isBoundary(reason[idx - 1]) && isBoundary(reason[idx + needle.length])) return true
      idx += 1
    }
  }
  return namedAt(path) || namedAt(basename(path))
}

/**
 * Compute the upgrade plan. Reads all three trees, classifies each
 * template-owned path, and three-way-merges the ones that changed on both
 * sides. Nothing is written.
 */
export async function planCoreUpgrade(options: PlanCoreUpgradeOptions): Promise<UpgradePlan> {
  const mergeFile = options.mergeFile ?? gitMergeFile
  // The two template-side trees are read as *git* trees, not as directories
  // (#1006). Whatever the operator built locally in a template checkout —
  // `apps/portal/tsconfig.tsbuildinfo` after a build, a `.terraform.lock.hcl`
  // per module after `terraform init` — is gitignored, has no upstream
  // counterpart, and used to be proposed to the instance as an `added` file to
  // commit. That made the change set an instance received a function of the
  // operator's machine rather than of the target version.
  //
  // A `git archive <tag>` extraction (the usual base/target) already holds
  // tracked files only, so this is a no-op there and bites exactly the case it
  // is for: a live checkout used directly, via the `--to-template` override or
  // the "target is the template's own latest tag" fast path.
  //
  // `oursDir` is deliberately NOT filtered: the instance tree is the one thing
  // the merge must see exactly as it is on disk.
  const trackedOnly = { trackedOnly: true }
  // A path can be templateOwned in the CURRENT manifest without ever having
  // been governed by the ownership mechanism at the instance's base version —
  // exactly what a manifest entry that has just been added produces (#1715).
  // `listTemplateOwnedFiles(options.baseDir, options.manifest, ...)` alone
  // would still count such a path as "in base", because it only asks whether
  // TODAY's globs match a file that happens to already exist on disk at the
  // base commit — it never asks whether the base commit's OWN manifest
  // considered the path template-owned at all. That makes a file the instance
  // diverged on entirely outside the upgrade mechanism look identical to
  // ordinary steady-state drift, and both currently resolve to a silent
  // `keep-ours` (excluded from `plan.changes` — no line item, no human ever
  // sees it).
  //
  // Reading the base commit's own core-manifest.json and intersecting on it
  // tells the two cases apart: a path only the CURRENT manifest owns is
  // excluded from `base` here, so `classify()` routes it through the "added
  // upstream" branch instead of the steady-state one — which, when the
  // instance's copy actually diverges from theirs, surfaces as `add-conflict`
  // (a real line item requiring human resolution) rather than disappearing.
  //
  // `baseManifest` is null when the base checkout predates core-manifest.json
  // entirely (pre-ADR-0006 Phase 3) — nothing to intersect against, so every
  // currently-owned path falls back to the prior behavior rather than being
  // reported as newly-owned noise.
  const baseManifestPath = join(options.baseDir, CORE_MANIFEST_FILE)
  const baseManifest: CoreManifest | null = existsSync(baseManifestPath)
    ? readCoreManifest(options.baseDir)
    : null
  const base = new Set(
    listTemplateOwnedFiles(options.baseDir, options.manifest, trackedOnly).filter(
      (path) => baseManifest === null || isTemplateOwned(path, baseManifest),
    ),
  )
  const ours = new Set(listTemplateOwnedFiles(options.oursDir, options.manifest))
  const theirs = new Set(listTemplateOwnedFiles(options.theirsDir, options.manifest, trackedOnly))

  // A template-owned file the instance deleted is drift (#370 blocks instances
  // from editing these paths), so an upgrade restores it (#395) — unless the
  // instance declared that path an intentional divergence, which is the governed
  // way to keep it deleted. Reuse the same biffo.divergence.json the ownership
  // guard reads; a malformed file throws here too, which is the right failure.
  const divergentPrefixes = readDivergenceConfig(options.oursDir).warnOnly.map((e) => e.prefix)
  // Cache the (comparatively expensive) `git log` lookup per path — `classify()`
  // calls `isDeclaredDivergent` at most twice per path, but there is no reason
  // to shell out twice for the same answer.
  const trailerDivergenceCache = new Map<string, boolean>()
  const isDeclaredDivergent = (path: string): boolean => {
    if (divergentPrefixes.some((prefix) => path.startsWith(prefix))) return true
    let viaTrailer = trailerDivergenceCache.get(path)
    if (viaTrailer === undefined) {
      viaTrailer = pathHasDivergenceTrailerInHistory(
        options.oursDir,
        path,
        options.manifest,
        options.git,
      )
      trailerDivergenceCache.set(path, viaTrailer)
    }
    return viaTrailer
  }

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

  // #1026: the orphan report. `oursTracked` is null for a tree git cannot
  // answer the question for (not a repo, not the worktree top) — the same
  // fail-open `gitTrackedFiles` contract `listTemplateOwnedFiles`'s
  // `trackedOnly` option already relies on — in which case nothing is
  // filtered out, matching the "classify everything on disk" behavior the
  // merge itself uses for `oursDir`.
  const oursTracked = gitTrackedFiles(options.oursDir, options.git)
  const orphaned = entries.filter(
    (e) => e.orphaned === true && (oursTracked === null || oursTracked.has(e.path)),
  )

  return { entries, changes, conflicts, summary, divergenceSkips, orphaned }
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
  //
  // Unsanctioned by default (#1026) — UNLESS this exact path is declared
  // divergent via either of the commit-time guard's two independent routes:
  // a `biffo.divergence.json` `warnOnly` prefix (#1602, class #1362), or a
  // `Core-Divergence:` trailer recorded against the path in history (#1718).
  // `checkCoreOwnership` (core-ownership-guard.ts) already accepts a path via
  // either, so counting it as an orphan here re-litigates, from a second
  // document, a question the first document already answered.
  // `isDeclaredDivergent` is the same closure the "instance deleted a template
  // file" branch below already reads — reused, not re-derived, so the two
  // branches (and the two acceptance routes within it) cannot drift onto
  // different sources of truth for the same declaration.
  if (!inBase && !inTheirs) {
    if (isDeclaredDivergent(path)) {
      return { path, status: 'keep-ours', conflicted: false, orphaned: false }
    }
    return { path, status: 'keep-ours', conflicted: false, orphaned: true }
  }

  // Added upstream (not in base).
  if (!inBase && inTheirs) {
    const theirsFile = readFile(opts.theirsDir, path)
    if (!inOurs) return { path, status: 'added', conflicted: false, content: contentOf(theirsFile) }
    const oursFile = readFile(opts.oursDir, path)
    if (oursFile.buffer.equals(theirsFile.buffer))
      return { path, status: 'unchanged', conflicted: false }
    // Both added the same path with different content.
    return { path, status: 'add-conflict', conflicted: true, content: contentOf(theirsFile) }
  }

  // Removed upstream (in base, not in theirs).
  if (inBase && !inTheirs) {
    if (!inOurs) return { path, status: 'removed', conflicted: false } // already gone
    const baseFile = readFile(opts.baseDir, path)
    const oursFile = readFile(opts.oursDir, path)
    if (oursFile.buffer.equals(baseFile.buffer))
      return { path, status: 'removed', conflicted: false }
    // Upstream deleted a file the instance had modified — needs a human.
    return { path, status: 'remove-conflict', conflicted: true }
  }

  // In base and theirs.
  const baseFile = readFile(opts.baseDir, path)
  const theirsFile = readFile(opts.theirsDir, path)

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
    return { path, status: 'restored', conflicted: false, content: contentOf(theirsFile) }
  }

  const oursFile = readFile(opts.oursDir, path)
  const oursChanged = !oursFile.buffer.equals(baseFile.buffer)
  const theirsChanged = !theirsFile.buffer.equals(baseFile.buffer)

  if (!theirsChanged) {
    // Upstream didn't touch it; keep whatever the instance has.
    return { path, status: oursChanged ? 'keep-ours' : 'unchanged', conflicted: false }
  }
  if (!oursChanged) {
    // Instance never diverged; fast-forward to theirs.
    return { path, status: 'take-theirs', conflicted: false, content: contentOf(theirsFile) }
  }
  if (oursFile.buffer.equals(theirsFile.buffer)) {
    // Both made the identical change.
    return { path, status: 'unchanged', conflicted: false }
  }

  // Both changed, differently — the case that would otherwise be a three-way
  // text merge. Binary content cannot go through `mergeFile` (see the module
  // docstring): resolve to the upstream bytes, verbatim — the same choice
  // `restored` above already makes when upstream and the instance disagree —
  // but keep `conflicted: true` so the upgrade still surfaces it for a human
  // to confirm the instance's own change to a binary asset wasn't meant to
  // survive. This never silently drops an instance edit: it is reported in
  // `plan.conflicts` exactly like a text conflict, just without markers a
  // binary has no way to carry.
  if (baseFile.text === null || oursFile.text === null || theirsFile.text === null) {
    return { path, status: 'conflict', conflicted: true, content: contentOf(theirsFile) }
  }

  // All three are text — the normal three-way merge.
  const { conflicted, content } = await mergeFile(baseFile.text, oursFile.text, theirsFile.text)
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

/**
 * Per-instance baseline for the #1026 orphan ratchet.
 *
 * Lives in the instance's own tree, and is `userOwned` (see
 * `core-manifest.json`) for the same reason `biffo.divergence.json` is: a file
 * that records THIS instance's own state must never itself be blocked from
 * being written by the guard it feeds, and it must survive `biffo core
 * upgrade` — which only ever touches template-owned paths — rather than being
 * silently reset by one.
 */
export const ORPHAN_BASELINE_FILE = 'biffo.orphan-baseline.json'

const OrphanBaselineSchema = z.object({
  count: z.number().int().min(0),
})

export type OrphanBaseline = z.infer<typeof OrphanBaselineSchema>

/**
 * Read `biffo.orphan-baseline.json` from an instance root. Absent means no
 * baseline has been recorded yet — the normal state before this instance's
 * first upgrade with this feature — and yields `null`, not a default of `0`:
 * `checkOrphanRatchet` treats `null` as "establish, don't fail" specifically
 * so the pre-existing residue this ratchet was built to tolerate is never
 * hard-blocked (issue #1026's decision).
 *
 * A malformed file THROWS, same as `readDivergenceConfig`: silently treating
 * broken config as "no baseline" would make every future count read as an
 * increase over nothing, turning a config error into a surprise hard block.
 */
export function readOrphanBaseline(instanceRoot: string): OrphanBaseline | null {
  const path = join(instanceRoot, ORPHAN_BASELINE_FILE)
  if (!existsSync(path)) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${ORPHAN_BASELINE_FILE} is not valid JSON: ${(err as Error).message}`)
  }
  const parsed = OrphanBaselineSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `${ORPHAN_BASELINE_FILE} is invalid: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`,
    )
  }
  return parsed.data
}

/** Write (or overwrite) the instance's recorded baseline. Only ever called
 * with `--apply`, alongside the rest of an upgrade's writes, so a dry run
 * changes nothing on disk — same convention as every other write this planner
 * feeds (#1026). */
export function writeOrphanBaseline(instanceRoot: string, count: number): void {
  writeFileSync(join(instanceRoot, ORPHAN_BASELINE_FILE), `${JSON.stringify({ count }, null, 2)}\n`)
}

export interface OrphanRatchet {
  /** Live count of unsanctioned instance files this run found. */
  count: number
  /** Recorded baseline, or null when none has been established yet. */
  baseline: number | null
  /** True once a baseline exists AND the live count exceeds it. Ratchet, not a
   * gate: a count that stayed flat or dropped never fails, and neither does
   * the very first run that establishes the baseline (issue #1026's decision
   * — "fail only when the count increases", never on the pre-existing set). */
  increased: boolean
}

/** Compare a live orphan count against the recorded baseline. Pure so the
 * pass/fail decision is unit-testable without touching a filesystem. */
export function checkOrphanRatchet(count: number, baseline: OrphanBaseline | null): OrphanRatchet {
  return {
    count,
    baseline: baseline?.count ?? null,
    increased: baseline !== null && count > baseline.count,
  }
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
