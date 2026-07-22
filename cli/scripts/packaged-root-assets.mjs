/**
 * The inventory of repo-root assets the published CLI package must carry, and
 * the registry of every module that resolves an asset by walking UP from its own
 * location.
 *
 * ## The bug class this exists to close
 *
 * Several parts of the CLI locate a companion asset by walking up from
 * `import.meta.url` to the nearest match. Inside the template checkout that walk
 * lands on the repo root, where `_skeletons/` lives. Once the
 * CLI is installed from npm there is nothing above `node_modules/@biffo/cli/dist/`,
 * so any such asset must be copied into the package at `prepack` AND listed in
 * package.json `files`.
 *
 * Miss either half and the failure is invisible in CI: every in-repo test still
 * passes, because the upward walk still reaches the repo root. Only a real
 * `npm install` breaks. That happened twice —
 *
 *   - #259: `core.version` was not shipped; `biffo core status` failed for every
 *     npm user. Fixed with a prepack copy plus a guard test — and since #423 the
 *     version comes from the package's own `package.json`, stamped at publish,
 *     so that asset is retired rather than merely packaged correctly.
 *   - #315: `_skeletons/` was not shipped; `biffo init` created both repos and
 *     then died at step 6/6 with an empty app sibling. Same bug, same mechanism
 *     — the earlier fix was applied to one asset and not the other.
 *
 * So the inventory below is the single source of truth, consumed by:
 *   - `sync-packaged-assets.mjs` (the prepack copy and the postpack clean),
 *   - `cli/src/lib/root-asset-packaging.test.ts` (the drift guard),
 * and RESOLVER_SITES makes the guard fail when a *new* module starts resolving
 * something this way without declaring it here.
 */

/**
 * Repo-root assets copied into the package at prepack.
 *
 * `path` is relative to the repo root and lands at the same relative path inside
 * the package, so the existing upward walk finds it one level up from `dist/`.
 * Every entry must also appear in package.json `files`.
 */
export const PACKAGED_ROOT_ASSETS = [
  {
    path: '_skeletons',
    kind: 'dir',
    /** A file that must exist inside the copy for it to count as complete. */
    sentinel: '_skeletons/sibling-template/biffo.sibling.json',
    resolvedBy:
      'src/commands/sibling-create.ts — defaultSiblingTemplateRoot(); src/commands/plugin-create.ts',
    why: 'biffo init step 6/6 and biffo sibling create copy _skeletons/sibling-template into the new repo; biffo plugin create copies _skeletons/plugin-template (#315).',
  },
]

/**
 * Repo-root assets that are deliberately NOT packaged. Listed so the guard can
 * tell "considered and excluded" apart from "forgotten".
 */
export const UNPACKAGED_ROOT_ASSETS = [
  {
    path: 'core-manifest.json',
    resolvedBy: 'src/lib/core-manifest.ts — resolveTemplateRoot()',
    why:
      'Shipping it would be actively harmful: findTemplateRoot() accepts any directory holding ' +
      'a core-manifest.json without a biffo.core.json, so a packaged copy would make the CLI ' +
      'package itself look like a template root while none of the trees it indexes ' +
      '(services/api, packages/, modules/) are present. `biffo core upgrade` must resolve a real ' +
      'biffo-template checkout via --template instead (ADR-0006 Phase 3).',
  },
]

/**
 * Every non-test module under `cli/src/` that resolves something by walking up
 * from `import.meta.url`. The guard asserts this list matches reality, so a new
 * resolver cannot be added without classifying the asset it seeks as packaged or
 * deliberately unpackaged above.
 */
export const RESOLVER_SITES = [
  { file: 'src/lib/core-manifest.ts', asset: 'core-manifest.json', packaged: false },
  {
    file: 'src/lib/core-version.ts',
    // Walks up for the nearest package.json — the package's own, whose version
    // IS the core version (stamped at publish from the tag, #423) — falling back
    // to the repo's core-v* tags in a checkout. Both travel with the package or
    // the checkout, so there is no repo-root asset to ship.
    asset: null,
    packaged: false,
  },
  { file: 'src/commands/sibling-create.ts', asset: '_skeletons', packaged: true },
  { file: 'src/commands/plugin-create.ts', asset: '_skeletons', packaged: true },
  {
    file: 'src/lib/build-freshness.ts',
    // Compares dist/ against src/, both inside the package/checkout — it resolves
    // no repo-root asset, and is inert once installed from npm (no src/ to be
    // stale against).
    asset: null,
    packaged: false,
  },
]
