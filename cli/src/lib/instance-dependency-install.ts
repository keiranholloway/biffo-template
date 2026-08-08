import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunCommandFn } from './lockfile-refresh.js'

/**
 * Install an instance's dependencies after `biffo core upgrade --apply` writes
 * its changes and before it pushes the upgrade branch (issue #1040).
 *
 * ## Why this exists
 *
 * `applyAndOpenPr` used to go straight from writing files to `git push`, never
 * running `pnpm install` (or `uv sync`, where the instance has Python) in
 * between. `.husky/pre-push` runs `scripts/verify.sh`, which cannot run against
 * a tree with no `node_modules`:
 *
 *     WARN   Local package.json exists, but node_modules missing, did you mean
 *            to install?
 *     verify failed: lint typecheck formatcheck test
 *     error: failed to push some refs
 *
 * git rejects the push at step `[3/4]`, so step `[4/4]` — opening the PR, the
 * only place the `carries-template-prs` marker (#1011) is normally stamped —
 * never runs. This is what a human does by hand between applying and pushing;
 * doing it here means the automated push can actually clear a gate that is
 * correctly checking the tree it is about to let onto a remote branch.
 *
 * Deliberately **not** the fix: `--no-verify`. The gate is right to reject a
 * tree it cannot check.
 *
 * ## Why this always runs `pnpm install`, unconditionally
 *
 * Unlike `refreshInstanceLockfiles` (#393), which only regenerates a lockfile
 * when the upgrade actually rewrote the manifest that locks it, a fresh
 * worktree — the workflow AGENTS.md §1 mandates for every unit of work — has no
 * `node_modules` at all regardless of whether this particular upgrade touched
 * `package.json`. The pre-push gate needs a working tree, not just an
 * up-to-date lockfile, so this step cannot be conditioned on the plan the way
 * the lockfile refresh is.
 *
 * `uv sync` runs only when the instance has Python at all (a root
 * `pyproject.toml`) — inventing a Python toolchain step for an instance that
 * has none would be a bigger change than an upgrade is entitled to make, the
 * same reasoning `lockfilesNeedingRefresh` applies to a lockfile the instance
 * does not have.
 *
 * ## Failure is soft, and loud
 *
 * The tools may not be installed on the machine running the upgrade, or the
 * install itself may fail for an unrelated reason. Aborting the whole upgrade
 * here would throw away a plan that applied cleanly and a commit that already
 * landed; silently continuing would leave the following push to fail with no
 * hint of why. So a failure warns with the exact command to run — and the push
 * step downstream still runs and reports its own failure honestly if the tree
 * genuinely cannot be verified, exactly as it did before this fix, rather than
 * this step papering over a real problem.
 */

export interface DependencyInstallStep {
  ecosystem: string
  command: readonly string[]
}

export interface DependencyInstallOutcome {
  step: DependencyInstallStep
  ok: boolean
  /** Why it failed, for the warning and the PR body. */
  error?: string
}

/**
 * Which install commands this instance needs. `pnpm install` always — every
 * instance is a pnpm workspace. `uv sync` only when a root `pyproject.toml`
 * says this instance has a Python toolchain to install.
 */
export function dependencyInstallSteps(instanceDir: string): DependencyInstallStep[] {
  const steps: DependencyInstallStep[] = [{ ecosystem: 'pnpm', command: ['pnpm', 'install'] }]
  if (existsSync(join(instanceDir, 'pyproject.toml'))) {
    steps.push({ ecosystem: 'uv', command: ['uv', 'sync'] })
  }
  return steps
}

/** Run each install step, continuing past a failure so one missing toolchain
 * does not hide the other's result — same posture as `refreshLockfiles`. */
export async function installInstanceDependencies(
  instanceDir: string,
  run: RunCommandFn,
  steps: readonly DependencyInstallStep[] = dependencyInstallSteps(instanceDir),
): Promise<DependencyInstallOutcome[]> {
  const outcomes: DependencyInstallOutcome[] = []
  for (const step of steps) {
    const result = await run(step.command, instanceDir)
    const outcome: DependencyInstallOutcome = { step, ok: result.ok }
    if (result.error !== undefined) outcome.error = result.error
    outcomes.push(outcome)
  }
  return outcomes
}

/** One line per failure, naming the command to run by hand. */
export function describeInstallFailures(outcomes: DependencyInstallOutcome[]): string[] {
  return outcomes
    .filter((o) => !o.ok)
    .map(
      (o) =>
        `${o.step.ecosystem} dependency install failed: ${o.error ?? 'unknown error'}. Run ` +
        `\`${o.step.command.join(' ')}\` in the instance before pushing, or the pre-push gate ` +
        `(\`scripts/verify.sh\`) will reject the push against a tree with no installed ` +
        `dependencies (#1040).`,
    )
}
