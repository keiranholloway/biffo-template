/**
 * `gh`-CLI-backed GitHub reads for `biffo doctor --fix` (#1682).
 *
 * Deliberately NOT the Octokit-based `GitHubAdapter` in
 * `adapters/source-control/github/`: that one needs a token threaded in by the
 * caller (repo creation, branch protection — privileged, deliberate
 * operations). `doctor` runs opportunistically from a git hook on an ordinary
 * developer machine, where the thing already authenticated is the `gh` CLI
 * itself — the same assumption `scripts/claim.sh` and
 * `scripts/wait-for-checks.sh` make. Shelling to `gh` reuses that session
 * rather than asking for a second credential.
 *
 * ## Why this exists at all
 *
 * #1682's own measurement is the reason: `git log HEAD --not --remotes` is NOT
 * a safe reap signal by itself. Branch auto-delete plus squash merges mean a
 * legitimately merged branch's local commits exist on no remote — 118 of 179
 * worktrees measured across `~/code` looked "unpushed" by that test while
 * being entirely landed. The only signal that is actually safe is the PR
 * **verdict**, read from GitHub: `merged` means the content landed however the
 * SHAs were rewritten; `closed` means it did not.
 */
import { execa } from '../../lib/exec.js'

export type PrVerdict = 'merged' | 'closed' | 'open' | 'none' | 'unknown'

interface PrListEntry {
  state?: unknown
}

export class GithubCliAdapter {
  /**
   * What GitHub says happened to `branch`'s pull request(s), in this repo.
   *
   * `--state all` so a merged or closed PR is not filtered out before we see
   * it. `open` wins over any other state present (an open PR is never safe to
   * touch regardless of history), `merged` wins over `closed` next (a branch
   * can carry more than one PR across its life — a reopened one, say — and
   * "was ever merged" is the fact that matters). `none` means no PR was ever
   * opened from this branch; `unknown` means the lookup itself could not be
   * trusted (no network, `gh` unauthenticated, unparseable output) and is
   * handled identically to a hard "keep" by the caller — never as license to
   * guess.
   */
  async prVerdictForBranch(cwd: string, branch: string): Promise<PrVerdict> {
    const { stdout, exitCode } = await execa(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state', '--limit', '20'],
      { cwd, reject: false },
    )
    if (exitCode !== 0) return 'unknown'

    let parsed: PrListEntry[]
    try {
      const value: unknown = JSON.parse(stdout)
      if (!Array.isArray(value)) return 'unknown'
      parsed = value as PrListEntry[]
    } catch {
      return 'unknown'
    }

    const states = new Set(
      parsed.map((p) => (typeof p.state === 'string' ? p.state : '')).filter((s) => s !== ''),
    )
    if (states.size === 0) return 'none'
    if (states.has('OPEN')) return 'open'
    if (states.has('MERGED')) return 'merged'
    if (states.has('CLOSED')) return 'closed'
    // A state GitHub has never actually returned for `gh pr list`; treat as
    // unknown rather than assume it is safe.
    return 'unknown'
  }

  /**
   * The head commit SHA (`headRefOid`) GitHub recorded for `branch`'s merged
   * pull request, or `null` when there is none or the lookup could not be
   * trusted.
   *
   * This is the fact `prVerdictForBranch` alone cannot supply, and #1810 is
   * the reason it must be asked for separately: "a PR merged for this branch
   * name" proves the branch's history at *some* point merged, never that the
   * worktree's *current* tip is that same point — a worktree can carry real,
   * committed, unpushed commits on top of an already-merged branch, and nothing
   * about the branch name changes. GitHub keeps `headRefOid` pointing at the
   * PR's last pushed commit even after the remote branch itself is deleted
   * post-merge (nothing can push to a deleted ref again), so it stays a stable
   * "this is what actually shipped" marker for the caller to check the
   * worktree's HEAD against via `GitAdapter.isAncestor`.
   *
   * Deliberately a second call rather than folding `headRefOid` into
   * `prVerdictForBranch`'s existing `--json state` query: that function's
   * return type and every existing caller are already covered by tests
   * written against `Promise<PrVerdict>`, and this fact is only ever needed
   * once a verdict of `'merged'` is already in hand.
   */
  async mergedHeadSha(cwd: string, branch: string): Promise<string | null> {
    const { stdout, exitCode } = await execa(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'merged',
        '--json',
        'headRefOid',
        '--limit',
        '20',
      ],
      { cwd, reject: false },
    )
    if (exitCode !== 0) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return null
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null

    const first = parsed[0] as { headRefOid?: unknown }
    return typeof first.headRefOid === 'string' && /^[0-9a-f]{7,40}$/i.test(first.headRefOid)
      ? first.headRefOid
      : null
  }
}
