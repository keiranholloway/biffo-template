/**
 * Template-owned workflows that `biffo deploy` dispatches from a FIXED branch,
 * independent of which environment is being deployed.
 *
 * `deploy-global.yml` provisions shared DNS + ACM — one set for all of
 * dev/staging/prod — so it runs from the production-most branch, `main`, rather
 * than any single environment's branch.
 *
 * That fixed-branch dispatch is what makes issue #328 possible: `biffo core
 * upgrade` lands its PR on the instance's *default* branch (often `dev`), so a
 * template fix to one of these workflows reaches `dev` but keeps executing from
 * `main` until a separate `dev` → `main` promotion. The upgrade PR is green and
 * merges cleanly, so nothing surfaces the gap and the deploy silently runs the
 * stale workflow.
 *
 * Two guards key off this shared knowledge so they cannot drift apart:
 *   - `biffo deploy` warns at dispatch time when the fixed ref is behind the
 *     branch being deployed (`warnIfDispatchRefStale` in `commands/deploy.ts`).
 *   - `biffo core upgrade` adds a "promotion required" note to the PR body when
 *     the upgrade touches one of these workflows but lands on another branch
 *     (`buildPrBody` in `commands/core-upgrade.ts`).
 */

/** The branch `biffo deploy` dispatches the global workflows from. */
export const GLOBAL_DISPATCH_REF = 'main'

/**
 * Repo-relative paths of the workflows dispatched from {@link GLOBAL_DISPATCH_REF}.
 * Used by `core upgrade` to detect when an upgrade diff touches one of them.
 */
export const GLOBAL_DISPATCH_WORKFLOW_PATHS: readonly string[] = [
  '.github/workflows/deploy-global.yml',
]

/** The workflow file ids (basenames) `biffo deploy` actually dispatches. */
export const GLOBAL_DISPATCH_WORKFLOW_IDS: readonly string[] = ['deploy-global.yml']
