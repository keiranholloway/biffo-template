import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

/**
 * "What does git actually track here?", for the trees `biffo core diff` and
 * `biffo core upgrade` plan from (#1006).
 *
 * Those planners used to enumerate a template checkout by walking the
 * filesystem, which cannot tell a released file from whatever the operator
 * happened to build locally. A `pnpm build` leaves `apps/portal/
 * tsconfig.tsbuildinfo`; a `terraform init` leaves `.terraform.lock.hcl` in
 * every module. Both are gitignored, both live inside a `templateOwned` prefix,
 * and both were proposed as `added` files to commit into an instance — files
 * with no upstream counterpart, that a later upgrade could never converge.
 *
 * The consequence is worse than the noise: the change set an instance receives
 * depends on the operator's local build state, so the same `core upgrade
 * X -> Y` is not reproducible between two machines.
 *
 * Consulting the index makes the answer a property of the *ref*, not of the
 * working directory.
 */

/** Injectable git runner so the lookup is unit-testable without a real repo. */
export type GitRunner = (args: string[]) => string

/**
 * The real git runner, exported so other callers needing the same
 * shell-out-with-injectable-fake pattern (e.g. core-upgrade.ts's divergence-
 * trailer history lookup) share one implementation rather than each hand-rolling
 * `execFileSync` with its own flags.
 */
export const defaultGit: GitRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * The set of files git tracks at `root`, as repo-relative posix paths — or
 * `null` when the question does not apply and the caller should fall back to
 * whatever is on disk.
 *
 * `null` is returned when:
 *
 * - `root` is not inside a git worktree at all. The common case is a tree
 *   extracted by `git archive <tag>` into a temp dir: it contains *only*
 *   tracked files by construction, so there is nothing to filter.
 * - `root` is inside a git worktree but is not its top level. `git ls-files`
 *   run from a subdirectory reports only that subdirectory's entries, so a
 *   temp dir that happens to sit under someone's repo would otherwise come
 *   back empty and silently filter the entire tree away.
 * - the index is empty, for the same fail-open reason: an empty answer is far
 *   more likely to be a broken assumption than a genuinely empty repository,
 *   and the failure mode of filtering everything out is an upgrade that
 *   proposes deleting the core.
 */
export function gitTrackedFiles(root: string, git: GitRunner = defaultGit): Set<string> | null {
  let top: string
  try {
    top = git(['-C', root, 'rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
  if (!top) return null
  try {
    if (realpathSync(top) !== realpathSync(root)) return null
  } catch {
    return null
  }

  let out: string
  try {
    out = git(['-C', root, 'ls-files', '-z'])
  } catch {
    return null
  }
  const files = out.split('\0').filter((p) => p !== '')
  if (files.length === 0) return null
  return new Set(files)
}
