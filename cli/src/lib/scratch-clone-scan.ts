/**
 * Estate-root scan for plain `git clone` directories doctor's worktree-based
 * model cannot see at all (#1949).
 *
 * ## Why `git worktree list` misses these entirely
 *
 * Every doctor check in `lib/doctor.ts` / `lib/doctor-reaper.ts` starts from
 * `git worktree list`, walked from one repo's own primary checkout. A
 * directory created with a plain `git clone` (a one-off PR review, a bug
 * repro) is a wholly independent `.git` history that no primary's `git
 * worktree list` will ever mention — invisible by construction, not by a gap
 * in the classification logic. Measured 2026-09-07: 115 such directories
 * across `~/code` and `/tmp`, ~9GB, some accumulated over months.
 *
 * ## The structural signal: `.git` file vs. directory
 *
 * `git worktree add` leaves a `.git` FILE (a `gitdir:` pointer into the
 * owning repo's `.git/worktrees/<name>`). `git clone` leaves a `.git`
 * DIRECTORY (a full, independent object store). That is exactly the
 * distinction the issue draws ("git-clone (not worktree) checkouts"), and it
 * needs no cooperation from whatever created the directory — checking
 * `.git`'s file type on disk is enough to tell the two apart, with no git
 * subprocess needed for this first pass.
 *
 * ## Distinguishing a scratch clone from a real, ongoing primary checkout
 *
 * A plain-clone directory is not automatically scratch garbage — `~/code`
 * also holds the real, actively-developed primary checkouts of every repo
 * this estate works in (`biffo-template`, `tabsii-platform`, ...), and those
 * are ALSO `git clone` results with a directory `.git`. Two independent,
 * corpus-grounded signals distinguish them, and BOTH must hold before a
 * directory is excluded as "a known repo's real checkout":
 *
 *  1. its basename matches the repo name from its own `origin` remote
 *     (`biffo-template` clones `.../biffo-template.git`) — every scratch
 *     name in the 2026-09-07 measurement (`prosecute-1234`, `gate-556`,
 *     `verify-9999-repro`, `scratch-explore`, `tcrm-471`, `bf1255`) fails
 *     this on its face, because a task-shaped name is exactly the point of
 *     naming it that way instead of after the repo; and
 *  2. it is currently on the integration branch (`dev` in every Biffo repo,
 *     AGENTS.md §2) — a real primary momentarily parked on a feature branch
 *     is a DIFFERENT, already-covered doctor finding
 *     (`checkCheckoutCurrency`'s `checkout-off-integration`), not this
 *     scan's job.
 *
 * Requiring both, rather than either alone, is deliberate: a directory named
 * after a repo but sitting on a feature branch, or one sitting on `dev` but
 * named for a task (the issue's own "clean mirror of dev" category), is
 * exactly the ambiguous case this scan should still surface rather than
 * silently exclude — see below for why getting that wrong costs nothing
 * worse than an extra report line.
 *
 * ## Classification, and read-only by construction
 *
 * Every remaining candidate is classified with the SAME judgement
 * `doctor-reaper.ts` already established for worktrees —
 * `GithubCliAdapter.prVerdictForBranch` plus `classifyReapCandidate` —
 * rather than re-deriving it. `hasFleetClaim` is always `false`: a
 * `.fleet-worktree-claim` lock is only ever written into a path fleet
 * dispatch itself creates (always under a repo's own `.worktrees/`), never
 * into an ad hoc clone.
 *
 * This module never deletes anything. `git worktree remove` is a git-safe
 * operation that refuses on git's own terms (dirty tree, locked worktree);
 * the equivalent here would be an unconditional `rm -rf` of a whole
 * independent directory — and a false "known repo" exclusion above is
 * recoverable (a line missing from a report) in a way a wrongly-deleted
 * directory is not. Automatic removal is deliberately left as follow-up
 * work, not something this scan claims to have proven safe.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GitAdapter } from '../adapters/git/index.js'
import type { GithubCliAdapter, PrVerdict } from '../adapters/github-cli/index.js'
import { classifyReapCandidate, type ReapVerdict } from './doctor-reaper.js'

/** The integration branch in every Biffo repo (AGENTS.md §2). */
const INTEGRATION_BRANCH = 'dev'

export interface ScratchCloneCandidate {
  path: string
  branch: string
}

/**
 * True when `path/.git` exists and is a plain clone's directory, rather than
 * a linked worktree's `gitdir:` pointer FILE. False (not a candidate at all)
 * for anything that is not a git checkout of either shape.
 */
function isPlainCloneDir(path: string): boolean {
  try {
    return statSync(join(path, '.git')).isDirectory()
  } catch {
    return false
  }
}

/**
 * The repo name a remote URL clones — the last path segment, minus a
 * trailing `.git` — from either SSH (`git@github.com:owner/repo.git`) or
 * HTTPS (`https://github.com/owner/repo.git`) form. `null` when the URL is
 * empty or has no path segment to read (never expected from a real `git
 * remote get-url`, but this is read from disk, not asserted).
 */
export function repoNameFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed === '') return null
  const match = /\/([^/]+?)(\.git)?\/?$/.exec(trimmed)
  return match?.[1] && match[1] !== '' ? match[1] : null
}

export interface ScratchCloneScanDeps {
  git: Pick<GitAdapter, 'currentBranch' | 'getRemoteUrl'>
}

/**
 * Every top-level directory under `estateRoot` that is a plain git clone and
 * for which neither "known repo" signal above holds.
 *
 * Top-level only, matching the 2026-09-07 measurement this scan is built
 * from — every scratch clone found there sat directly under `~/code`, never
 * nested. A repo's own legitimate nesting (`.worktrees/<name>`) is a `.git`
 * FILE, already excluded by `isPlainCloneDir` before any nesting question
 * arises.
 */
export async function findScratchCloneCandidates(
  estateRoot: string,
  deps: ScratchCloneScanDeps,
): Promise<ScratchCloneCandidate[]> {
  let names: string[]
  try {
    names = readdirSync(estateRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const candidates: ScratchCloneCandidate[] = []
  for (const name of names) {
    const path = join(estateRoot, name)
    if (!isPlainCloneDir(path)) continue

    const branch = await deps.git.currentBranch(path)
    const remoteUrl = await deps.git.getRemoteUrl(path).catch(() => '')
    const repoName = remoteUrl === '' ? null : repoNameFromRemoteUrl(remoteUrl)

    const looksLikeKnownRepoCheckout =
      repoName !== null &&
      repoName.toLowerCase() === name.toLowerCase() &&
      branch === INTEGRATION_BRANCH
    if (looksLikeKnownRepoCheckout) continue

    candidates.push({ path, branch })
  }
  return candidates
}

export interface ScratchCloneReport {
  candidate: ScratchCloneCandidate
  verdict: ReapVerdict
}

export interface ScratchCloneClassifyDeps {
  git: Pick<GitAdapter, 'hasUncommittedChanges' | 'headSha' | 'isAncestor'>
  github: Pick<GithubCliAdapter, 'prVerdictForBranch' | 'mergedHeadSha'>
}

/**
 * Classifies every candidate with `doctor-reaper.ts`'s own table
 * (`classifyReapCandidate`) — never re-derived here. All GitHub and git
 * lookups run with `cwd` set to the CANDIDATE's own path, not the invoking
 * repo's: a scratch clone can be of any repo in the estate, and both
 * `prVerdictForBranch` and `mergedHeadSha` infer which GitHub repo to ask
 * from the git remote at `cwd` — the invoking repo's remote would ask about
 * the wrong repo entirely.
 */
export async function classifyScratchClones(
  candidates: ScratchCloneCandidate[],
  deps: ScratchCloneClassifyDeps,
): Promise<ScratchCloneReport[]> {
  const reports: ScratchCloneReport[] = []

  for (const candidate of candidates) {
    const isDetached = candidate.branch === 'HEAD' || candidate.branch === ''
    const isDirty = await deps.git.hasUncommittedChanges(candidate.path)

    const prVerdict: PrVerdict =
      isDetached || isDirty
        ? 'unknown'
        : await deps.github.prVerdictForBranch(candidate.path, candidate.branch)

    // Unused by classifyReapCandidate unless prVerdict === 'merged' — see
    // that field's doc comment in doctor-reaper.ts. `true` is a harmless
    // default for every other row of the table.
    let mergeContainsHead: boolean | null = true
    if (prVerdict === 'merged') {
      const [headSha, mergedHeadSha] = await Promise.all([
        deps.git.headSha(candidate.path),
        deps.github.mergedHeadSha(candidate.path, candidate.branch),
      ])
      mergeContainsHead =
        headSha === null || mergedHeadSha === null
          ? null
          : await deps.git.isAncestor(candidate.path, headSha, mergedHeadSha)
    }

    const verdict = classifyReapCandidate({
      isDetached,
      isDirty,
      hasFleetClaim: false,
      prVerdict,
      mergeContainsHead,
    })
    reports.push({ candidate, verdict })
  }

  return reports
}
