import { execa } from './exec.js'

/**
 * The paths touched by a core-upgrade branch's OWN mechanical commit — the
 * one `biffo core upgrade --apply` itself writes — so `core-ownership-guard.ts`
 * can exempt exactly those paths rather than the whole branch (#1993).
 *
 * ## Why this is not just "diff the whole branch"
 *
 * Before this, both callers of the guard (the CI diff runner and the local
 * commit-msg hook) exempted a changed path the instant the BRANCH name
 * matched `biffo/core-upgrade-*`, regardless of which commit touched it. That
 * let a second, human/agent-authored commit pushed onto the same branch edit
 * a user-owned path with no check at all — reproduced live on
 * tabsii-platform#1420: a divergence-declaration fix landed as a second
 * commit on an upgrade branch, touching a path `core-manifest.json` marks
 * user-owned, and the required "Core ownership guard" check reported SUCCESS
 * anyway because it never looked past the branch name.
 *
 * The fix scopes the exemption to the FIRST commit ahead of `base` — the
 * mechanical commit, always made before any human/agent touches the branch —
 * and lets every subsequent commit be checked exactly as it would be
 * anywhere else.
 *
 * ## The two callers this serves
 *
 *   - CI diff mode: `base` is `origin/<pr-base>`, HEAD is the PR tip, and
 *     there is always at least one commit already made — `stagedFallbackFiles`
 *     is omitted.
 *   - The local commit-msg hook: the commit being checked has not been made
 *     yet (this runs pre-commit, on staged changes), so when the branch has
 *     NO commits yet ahead of `base` the currently-staged files ARE what is
 *     about to become the first commit — `stagedFallbackFiles` supplies them
 *     so the mechanical commit is still recognised as its own first commit.
 *
 * ## Fails closed, always
 *
 * Returns `null` — never an empty array read as "nothing to exempt is fine"
 * vs. "everything is fine to exempt" — on any git failure (unresolvable
 * `base`, a detached/shallow history, a timeout). `core-ownership-guard.ts`
 * treats `null` as "could not determine" and exempts nothing, the same
 * fail-closed posture `fetchTemplateShippedPaths` established for the
 * analogous "could not tell" case (#1912) — never the old fail-OPEN default
 * of skipping the whole branch, which is the bug #1993 exists to close.
 */

export interface GitCommandResult {
  stdout: string
  exitCode: number | null
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>

const defaultRunner: GitCommandRunner = async (args, cwd) => {
  const result = await execa('git', args, { cwd, reject: false, timeout: 15_000 })
  return { stdout: String(result.stdout ?? ''), exitCode: result.exitCode ?? null }
}

const splitLines = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

export async function resolveUpgradeCommitFiles(
  repoRoot: string,
  base: string,
  opts: { stagedFallbackFiles?: string[] } = {},
  runner: GitCommandRunner = defaultRunner,
): Promise<string[] | null> {
  let rev: GitCommandResult
  try {
    rev = await runner(['rev-list', '--reverse', `${base}..HEAD`], repoRoot)
  } catch {
    return null
  }
  if (rev.exitCode !== 0) return null
  const commits = splitLines(rev.stdout)

  if (commits.length === 0) {
    // Nothing has landed on this branch beyond `base` yet, so the commit
    // about to be made (the staged files) IS the branch's first commit. In
    // CI mode there is no such thing as "about to be made" — a real PR
    // always has at least one commit — so `undefined` here correctly reads
    // as "could not tell" rather than "exempt everything".
    return opts.stagedFallbackFiles ?? null
  }

  const first = commits[0] as string
  let diff: GitCommandResult
  try {
    diff = await runner(['diff-tree', '--no-commit-id', '--name-only', '-r', first], repoRoot)
  } catch {
    return null
  }
  if (diff.exitCode !== 0) return null
  return splitLines(diff.stdout)
}
