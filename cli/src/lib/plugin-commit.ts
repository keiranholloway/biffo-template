import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PluginMigrationsAdapter } from '../adapters/plugin-migrations/index.js'
import type { GitAdapter } from '../adapters/git/index.js'

/**
 * The one place a `biffo plugin` command commits into an instance's checkout (biffo-template#2108).
 *
 * ## The class this closes
 *
 * `uv.lock` is a derived artifact of the instance's uv workspace, and every plugin command changes that workspace: `create`
 * adds a member, `install` adds one, `uninstall` removes one. `sync-migrations` runs `uv run` in it. Each command used to
 * hand-pick its own `git add` paths, and nothing asked "did the lock change, and is it in the commit?" — so `create`,
 * `uninstall` and `sync-migrations` (and, until #2107, a no-tables `install`) each committed a tree on which
 * `uv lock --check` fails. The lock was then rewritten on disk by the next `uv run`, leaving ` M uv.lock` behind.
 *
 * ## Why one shared step rather than a fix per command
 *
 * A fix per command is a fifth copy of the same step, and the next command written will forget it exactly as four did.
 * `commitPluginChange` makes the lock part of committing: a command hands over the paths it changed and cannot commit
 * without the lock being re-resolved and staged. `plugin-commit-guard.test.ts` fails if a plugin command reaches
 * `git.commit` any other way, so the bypass is a red test rather than a silent stale lock.
 *
 * The lock refresh is a no-op when the lock is already current, and is skipped only when the checkout carries no `uv.lock`
 * at all (a non-uv project, which has no stale lock to commit).
 */

export interface PluginCommitDeps {
  git: Pick<GitAdapter, 'add' | 'commit'>
  /**
   * Defaults to the real adapter rather than being required-and-optional-to-mock: a caller that forgets to pass it still
   * re-locks, instead of silently skipping the step.
   */
  migrations?: Pick<PluginMigrationsAdapter, 'refreshLock'>
}

/**
 * Re-resolves the instance's `uv.lock` and returns `stagePaths` with `uv.lock` included. Call this AFTER the last file that
 * feeds the lock (any `pyproject.toml`, any removed/added member) is written, and BEFORE staging. Use `commitPluginChange`
 * unless the caller has its own staging state to keep (`plugin install`).
 */
export async function withRefreshedLock(
  deps: Pick<PluginCommitDeps, 'migrations'>,
  cwd: string,
  stagePaths: string[],
): Promise<string[]> {
  if (!existsSync(join(cwd, 'uv.lock'))) return stagePaths
  await (deps.migrations ?? new PluginMigrationsAdapter()).refreshLock(cwd)
  return stagePaths.includes('uv.lock') ? stagePaths : [...stagePaths, 'uv.lock']
}

/**
 * Re-locks, stages `stagePaths` plus `uv.lock`, and commits exactly those paths (#2119: `GitAdapter.commit` takes an explicit
 * pathspec and never sweeps in whatever else is staged). Returns the paths that were committed.
 */
export async function commitPluginChange(
  deps: PluginCommitDeps,
  cwd: string,
  stagePaths: string[],
  message: string,
): Promise<string[]> {
  const paths = await withRefreshedLock(deps, cwd, stagePaths)
  await deps.git.add(cwd, paths)
  await deps.git.commit(cwd, message, paths)
  return paths
}
