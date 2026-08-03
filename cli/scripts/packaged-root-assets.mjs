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
  {
    path: 'scripts/hook-audit.sh',
    kind: 'file',
    sentinel: 'scripts/hook-audit.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why: 'Retired from copy-based distribution (#1109 phase 0d).',
  },
  {
    path: 'scripts/pg-test-db.sh',
    kind: 'file',
    sentinel: 'scripts/pg-test-db.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why: 'Retired from copy-based distribution (#1109 phase 0d).',
  },
  {
    path: 'scripts/rewrite-scope-check.sh',
    kind: 'file',
    sentinel: 'scripts/rewrite-scope-check.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why: 'Retired from copy-based distribution (#1109 phase 0d).',
  },
  {
    path: 'scripts/gate-coverage.sh',
    kind: 'file',
    sentinel: 'scripts/gate-coverage.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why: 'Retired from copy-based distribution (#1109 phase 0e).',
  },
  {
    path: 'scripts/verify.sh',
    kind: 'file',
    sentinel: 'scripts/verify.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why: 'The local gate, 978 lines that existed 15 times over (#1109). Which version a repo runs is now its .biffo-shared-version rather than whenever it last received a copy -- the #855 class, closed structurally.',
  },
  {
    path: 'scripts/runner-drop-forensics.mjs',
    kind: 'file',
    sentinel: 'scripts/runner-drop-forensics.mjs',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why:
      'Adjudicates a red check against the fleet spot-eviction record (#1238). Of the 22 ' +
      'runner-killed jobs it was validated against, 17 were in satellites -- the repos that ' +
      'could not reach it until #1240 taught packagedScriptCommand to run a .mjs via node ' +
      'instead of sh.',
  },
  {
    path: 'scripts/practices-metrics.mjs',
    kind: 'file',
    sentinel: 'scripts/practices-metrics.mjs',
    resolvedBy: 'scripts/runner-drop-forensics.mjs — relative import of isRunnerKill()',
    why:
      'Not reached through findPackagedScript() itself, but runner-drop-forensics.mjs imports ' +
      "it by relative path (\"./practices-metrics.mjs\"), which Node resolves against the " +
      'FILE that ships next to it rather than the upward walk. Registered here so it travels ' +
      'to the same directory in the tarball -- omitting it leaves the checkout working (the ' +
      'sibling is right there on disk) while a real npm install throws ERR_MODULE_NOT_FOUND, ' +
      'the exact "invisible in CI, breaks only on install" shape #259 and #315 already are.',
  },
  {
    path: 'scripts/practices-corpus.mjs',
    kind: 'file',
    sentinel: 'scripts/practices-corpus.mjs',
    resolvedBy: 'scripts/practices-metrics.mjs — relative import of readCorpusStrict()',
    why:
      'The next link in the same chain: practices-metrics.mjs imports this by relative path too. ' +
      'Its own imports are Node built-ins only, so the closure ends here -- verified by running ' +
      'the packaged script from a directory holding nothing but these three files plus node_modules.',
  },
  {
    path: 'scripts/branch-health.sh',
    kind: 'file',
    sentinel: 'scripts/branch-health.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why:
      'Retired from copy-based distribution with claim.sh (#1109 phase 0c). AGENTS.md section 6 ' +
      'mandates it after a merge; it was one of 15 identical copies.',
  },
  {
    path: 'scripts/claim.sh',
    kind: 'file',
    sentinel: 'scripts/claim.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why:
      'Retired from copy-based distribution with branch-health.sh (#1109 phase 0c). AGENTS.md ' +
      'section 1 mandates it before starting an issue; it was one of 15 identical copies.',
  },
  {
    path: 'scripts/wait-for-checks.sh',
    kind: 'file',
    sentinel: 'scripts/wait-for-checks.sh',
    resolvedBy: 'src/lib/packaged-scripts.ts — findPackagedScript()',
    why:
      'The first guard moved off copy-based distribution (#1109). Satellites received this as ' +
      'one of 16 files copied into 15 repos -- roughly 240 copies kept byte-identical by hand, ' +
      'with about ten of the estate guards written to police them. Shipping the canonical copy ' +
      'INSIDE the versioned package means a satellite runs it via `scripts/biffo.sh ' +
      'wait-for-checks`, pinned to its own .biffo-shared-version, and there is one copy rather ' +
      'than fifteen. Packaged as a single FILE rather than all of scripts/: that directory also ' +
      'holds template-only tooling (practices-*, bootstrap, setup-oidc) an instance has no use ' +
      'for, and UNPACKAGED_ROOT_ASSETS records that shipping a root asset can be actively ' +
      'harmful when something resolves it by walking up.',
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
  {
    path: 'scripts/shared-sync.sh',
    resolvedBy: 'src/test-utils/shared-sync-template.ts -- realSharedSync (test fixtures only)',
    why:
      'The distribution mechanism itself, and it runs only from a template checkout: it reads ' +
      'this repo shared-files.json and _skeletons/, walks an --estate of sibling clones, and ' +
      'refuses to run from a checkout behind origin/dev. None of that means anything inside an ' +
      'installed package, and the satellites it ships TO are targets rather than callers -- they ' +
      'reach the estate guards through scripts/biffo.sh instead (#1109). The only upward walk to ' +
      'it is a test fixture builder copying it into a throwaway template (#1252), which never ' +
      'runs from an installed package at all.',
  },
]

/**
 * Every module under `cli/src/` that resolves something by walking up from
 * `import.meta.url`, excluding `*.test.ts` files themselves. The guard asserts
 * this list matches reality, so a new resolver cannot be added without
 * classifying the asset it seeks as packaged or deliberately unpackaged above.
 *
 * That includes test *helpers*, which are not `*.test.ts` and so are scanned:
 * `src/test-utils/shared-sync-template.ts` is here for that reason. Declaring
 * it is deliberate rather than widening the scan to skip `test-utils/` -- an
 * exclusion is a place a real resolver could later hide, and the classification
 * it forces (shared-sync.sh is template-only, see UNPACKAGED_ROOT_ASSETS) is
 * worth having written down.
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
  {
    file: 'src/lib/packaged-script-command.ts',
    // Resolves EVERY packaged shell script through findPackagedScript() — one
    // factory builds wait-for-checks, branch-health and claim, so the upward
    // walk exists once rather than once per command. Declared
    // here so the guard fails if the asset is ever un-packaged: the upward walk
    // still reaches the repo root in a checkout, so a missing `files` entry is
    // invisible in CI and breaks only on a real npm install (#259, #315, #1109).
    asset: 'scripts/wait-for-checks.sh',
    packaged: true,
  },
  { file: 'src/commands/sibling-create.ts', asset: '_skeletons', packaged: true },
  { file: 'src/commands/plugin-create.ts', asset: '_skeletons', packaged: true },
  {
    file: 'src/test-utils/shared-sync-template.ts',
    // Test-only. Locates this repo's real scripts/shared-sync.sh to COPY into a
    // throwaway fixture template, because executing it where it sits makes the
    // developer's own checkout the template under test (#1252).
    asset: 'scripts/shared-sync.sh',
    packaged: false,
  },
  {
    file: 'src/lib/build-freshness.ts',
    // Compares dist/ against src/, both inside the package/checkout — it resolves
    // no repo-root asset, and is inert once installed from npm (no src/ to be
    // stale against).
    asset: null,
    packaged: false,
  },
]
