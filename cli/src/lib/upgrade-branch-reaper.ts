/**
 * Finding the local branches `biffo core upgrade` left behind (#758).
 *
 * Every `--apply` run creates a `biffo/core-upgrade-<from>-to-<to>` branch.
 * Its PR is **squash**-merged and `--delete-branch` removes the remote copy,
 * so afterwards the local branch is merged, dead, and — before #761 — provably
 * so by neither standard check:
 *
 *   - `git branch --merged <base>` misses it: a squash merge means the branch
 *     tip is never an ancestor of the base.
 *   - `git branch -vv | grep ': gone]'` misses it: `GitAdapter.push` used a
 *     refspec push with no upstream recorded, so there was nothing to report
 *     gone.
 *
 * `git branch -d` then refuses it as well (not an ancestor), leaving only `-D`,
 * which reads as unsafe — so nobody ran it, and 190 branches accumulated across
 * three repos.
 *
 * #761 fixed the cause by recording an upstream on push. This module closes the
 * loop the issue asks for: it turns "detectable" into "actually swept".
 *
 * ## The two categories are deliberately not merged
 *
 * A branch with a **gone** upstream is safe to delete: an upstream was
 * recorded, the remote copy has since disappeared, and `--delete-branch` only
 * removes it after the PR merges. That is positive evidence.
 *
 * A branch with **no upstream at all** is the pre-#761 fossil. It looks
 * identical to a branch someone created by hand and never pushed — work that
 * has not landed anywhere. Deleting it on suspicion would destroy exactly the
 * thing the user cannot recover. So these are reported and never touched, and
 * the report says why.
 */

import { UPGRADE_BRANCH_PREFIX } from './core-upgrade.js'

/** One `refs/heads` entry, as `parseBranchRefs` reads it. */
export interface BranchRef {
  name: string
  /** Full upstream ref, or '' when the branch tracks nothing. */
  upstream: string
  /** git's `%(upstream:track)`, e.g. '[gone]', '[ahead 1]', or ''. */
  track: string
}

/** How `listBranchRefs` asks git for the fields below. Tab-separated, NUL-free. */
export const BRANCH_REF_FORMAT = '%(refname:short)\t%(upstream)\t%(upstream:track)'

/** Parses `git for-each-ref --format=BRANCH_REF_FORMAT refs/heads` output. */
export function parseBranchRefs(stdout: string): BranchRef[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => {
      const [name = '', upstream = '', track = ''] = line.split('\t')
      return { name, upstream, track }
    })
    .filter((ref) => ref.name !== '')
}

export interface ReapCandidates {
  /** Upgrade branches whose upstream is gone — safe to delete. */
  reapable: string[]
  /**
   * Upgrade branches with no upstream recorded. Created before #761, or never
   * pushed at all; indistinguishable from unlanded local work, so never
   * deleted automatically.
   */
  unverifiable: string[]
}

/**
 * Splits the upgrade branches into what can be proven dead and what cannot.
 *
 * `currentBranch` is always excluded from both: deleting the branch you are
 * standing on fails anyway, and an upgrade run from its own worktree is
 * legitimately sitting on one of these names.
 */
export function classifyUpgradeBranches(refs: BranchRef[], currentBranch: string): ReapCandidates {
  const reapable: string[] = []
  const unverifiable: string[] = []

  for (const ref of refs) {
    if (!ref.name.startsWith(UPGRADE_BRANCH_PREFIX)) continue
    if (ref.name === currentBranch) continue

    if (ref.track.includes('gone')) {
      reapable.push(ref.name)
    } else if (ref.upstream === '') {
      unverifiable.push(ref.name)
    }
    // A branch with a live upstream is an upgrade still in flight — its PR has
    // not merged yet. Neither reapable nor a fossil; leave it out entirely.
  }

  return { reapable, unverifiable }
}
