import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Refresh an instance's lockfiles after a core upgrade rewrites the manifests
 * they lock (issue #393).
 *
 * ## Why this is needed at all
 *
 * The ownership boundary splits a dependency declaration from its resolution:
 *
 *   - `package.json` / `pyproject.toml` are **template-owned**, so an upgrade
 *     rewrites them;
 *   - `pnpm-lock.yaml` / `uv.lock` are **user-owned**, so an upgrade must not,
 *     and does not, touch them.
 *
 * Both halves of that are correct — a lockfile records what *this instance*
 * resolved, from its own registries — and together they leave the two files
 * disagreeing after every dependency-changing upgrade. CI then does not degrade
 * gracefully; it fails outright:
 *
 *     ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen
 *     installation. The current "overrides" configuration doesn't match the
 *     value found in the lockfile
 *
 * A failed install takes `node_modules` with it, so every later step fails on a
 * missing binary and buries the real cause in a different job. Hit on the first
 * upgrade after the security overrides landed (biffo-platform#2).
 *
 * ## Why regenerating is not a boundary violation
 *
 * A lockfile is a *derived* artifact of the manifest. Regenerating it is not the
 * template overwriting the instance's choices — it is the instance re-resolving
 * its own dependencies against a manifest that legitimately changed, which is
 * exactly what a maintainer would do by hand. The commands are run **in the
 * instance**, so its registry config, mirrors and platform decide the result.
 *
 * ## Failure is soft, and loud
 *
 * The tools may not be installed on the machine running the upgrade. Aborting
 * would leave a created branch and no PR; silently skipping would produce a PR
 * that is red for a reason nobody can see. So a failure warns with the exact
 * command to run, and is reported into the PR body — the upgrade still opens,
 * and the gap is stated rather than discovered in CI.
 */

export interface LockfileTrigger {
  /** Manifest whose change invalidates the lockfile. */
  manifest: string
  lockfile: string
  /** Argv to regenerate the lockfile *without* installing packages. */
  command: readonly string[]
  /** Named in warnings, so the message is actionable without reading this file. */
  ecosystem: string
}

/**
 * `--lockfile-only` / `uv lock` deliberately: the upgrade needs the lockfile to
 * agree with the manifest, not a populated `node_modules`. Resolving without
 * installing is faster and cannot execute a dependency's install scripts on the
 * machine running the upgrade.
 */
export const LOCKFILE_TRIGGERS: readonly LockfileTrigger[] = [
  {
    manifest: 'package.json',
    lockfile: 'pnpm-lock.yaml',
    command: ['pnpm', 'install', '--lockfile-only'],
    ecosystem: 'pnpm',
  },
  {
    manifest: 'pyproject.toml',
    lockfile: 'uv.lock',
    command: ['uv', 'lock'],
    ecosystem: 'uv',
  },
]

/**
 * Trees that contain manifests describing a *different* repo, not this one.
 *
 * `_skeletons/` is scaffolding source: the tree `biffo sibling create` /
 * `biffo plugin create` copies into a brand-new repository. Its
 * `package.json` / `pyproject.toml` are deliberately **not** pnpm or uv
 * workspace members here (see `pnpm-workspace.yaml`, `[tool.uv.workspace]`
 * and each skeleton's own README), so this repo's `pnpm-lock.yaml` and
 * `uv.lock` do not resolve them and changing them cannot invalidate either.
 *
 * Any other vendored tree of foreign manifests belongs here for the same
 * reason.
 */
export const NON_WORKSPACE_TREES: readonly string[] = ['_skeletons']

/** True when the path lives inside a tree whose manifests belong to another repo. */
function isForeignManifest(path: string): boolean {
  return path.split('/').some((segment) => NON_WORKSPACE_TREES.includes(segment))
}

/**
 * Which lockfiles a set of changed paths invalidates.
 *
 * Matches a manifest **anywhere** in the tree, not just at the root: a workspace
 * member's `package.json` or `pyproject.toml` is locked by the root lockfile
 * too, and adding one (as the agent-runtime plugin did) is precisely a change
 * that makes `uv lock --check` fail.
 *
 * Except when the manifest is not this repo's to resolve. `_skeletons/` holds
 * the manifests of repos that do not exist yet, and matching them fired a
 * refresh — and printed "the upgrade changed a dependency manifest they lock" —
 * on an upgrade that changed no root manifest at all (issue #393, reopened).
 * See `NON_WORKSPACE_TREES`.
 *
 * `changedPaths` must be what the upgrade actually *wrote or deleted*, not what
 * it considered: see `refreshInstanceLockfiles` in `commands/core-upgrade.ts`.
 *
 * A lockfile the instance does not have is not created — its absence means that
 * ecosystem is not locked here, and inventing one would be a bigger change than
 * the upgrade is entitled to make.
 */
export function lockfilesNeedingRefresh(
  changedPaths: string[],
  instanceDir: string,
  triggers: readonly LockfileTrigger[] = LOCKFILE_TRIGGERS,
): LockfileTrigger[] {
  const locked = changedPaths.filter((p) => !isForeignManifest(p))
  return triggers.filter((t) => {
    const touched = locked.some((p) => p === t.manifest || p.endsWith(`/${t.manifest}`))
    return touched && existsSync(join(instanceDir, t.lockfile))
  })
}

export interface LockfileRefreshOutcome {
  trigger: LockfileTrigger
  ok: boolean
  /** Why it failed, for the warning and the PR body. */
  error?: string
}

/** Runs a command in a directory. Injected so the refresh is testable without
 * pnpm or uv on the machine. */
export type RunCommandFn = (
  command: readonly string[],
  cwd: string,
) => Promise<{ ok: boolean; error?: string }>

/** Regenerate each lockfile, continuing past failures so one missing toolchain
 * does not hide the other's result. */
export async function refreshLockfiles(
  instanceDir: string,
  triggers: readonly LockfileTrigger[],
  run: RunCommandFn,
): Promise<LockfileRefreshOutcome[]> {
  const outcomes: LockfileRefreshOutcome[] = []
  for (const trigger of triggers) {
    const result = await run(trigger.command, instanceDir)
    const outcome: LockfileRefreshOutcome = { trigger, ok: result.ok }
    if (result.error !== undefined) outcome.error = result.error
    outcomes.push(outcome)
  }
  return outcomes
}

/** One line per failure, naming the command to run by hand. */
export function describeFailures(outcomes: LockfileRefreshOutcome[]): string[] {
  return outcomes
    .filter((o) => !o.ok)
    .map(
      (o) =>
        `${o.trigger.lockfile} could not be refreshed (${o.trigger.ecosystem}): ` +
        `${o.error ?? 'unknown error'}. Run \`${o.trigger.command.join(' ')}\` in the instance ` +
        `and commit the result, or CI will fail on a lockfile that disagrees with ` +
        `${o.trigger.manifest}.`,
    )
}
