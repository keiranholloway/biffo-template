/**
 * Template-owned workflows that `biffo deploy` dispatches from a FIXED branch,
 * independent of which environment is being deployed.
 *
 * `deploy-global.yml` provisions shared DNS + ACM — one set for the whole
 * instance — so it runs from the single integration branch, `dev`, rather than
 * any per-environment branch. Since #559 made `dev` the integration/default
 * branch in every repo (production is not built yet, so a deployable repo's
 * `main` is reserved and unused), the fixed dispatch ref and the instance's
 * default branch are the *same* branch, `dev`.
 *
 * That convergence closes the gap issue #328 was about: when the dispatch ref
 * was `main` but `biffo core upgrade` landed its PR on the default branch
 * (`dev`), a template fix to one of these workflows reached `dev` but kept
 * executing from `main` until a separate `dev` → `main` promotion — a silent
 * staleness the two guards below existed to surface. With the ref now equal to
 * the default branch there is nothing to promote, so those guards no longer
 * fire in the unified model; they are kept as defense in case a repo ever
 * reintroduces a branch split:
 *   - `biffo deploy` warns at dispatch time when the fixed ref is behind the
 *     branch being deployed (`warnIfDispatchRefStale` in `commands/deploy.ts`).
 *   - `biffo core upgrade` adds a "promotion required" note to the PR body when
 *     the upgrade touches one of these workflows but lands on another branch
 *     (`buildPrBody` in `commands/core-upgrade.ts`).
 */

/** The branch `biffo deploy` dispatches the global workflows from (#559: `dev`). */
export const GLOBAL_DISPATCH_REF = 'dev'

/**
 * Repo-relative paths of the workflows dispatched from {@link GLOBAL_DISPATCH_REF}.
 * Used by `core upgrade` to detect when an upgrade diff touches one of them.
 */
export const GLOBAL_DISPATCH_WORKFLOW_PATHS: readonly string[] = [
  '.github/workflows/deploy-global.yml',
]

/** The workflow file ids (basenames) `biffo deploy` actually dispatches. */
export const GLOBAL_DISPATCH_WORKFLOW_IDS: readonly string[] = ['deploy-global.yml']
