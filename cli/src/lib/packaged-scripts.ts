import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Locate a shell script the CLI ships, from either a template checkout or the
 * published package (#1109).
 *
 * ## Why this exists
 *
 * The estate distributed its guards by **copying** them: `shared-files.json`
 * held 16 files, `scripts/shared-sync.sh` pushed them into 15 repos, and the
 * result was roughly 240 copies that had to stay byte-identical by hand. Drift
 * was not an anomaly in that design, it was the default state — and about ten
 * of the estate's guards existed only to police it (`shared-sync --check`,
 * `--backfill`, `--candidates`, the `mustBeUniform` ratchet, `hook-audit`,
 * `gate-coverage`, `ci-wiring-audit`, the skeleton parity and drift tests).
 *
 * Instances already escaped this: `cli/src/commands/check.ts` moved the repo
 * guards to CLI subcommands so an instance runs them from the published,
 * version-pinned package instead of carrying `cli/`. That worked, and its own
 * docstring gives the reason — *"one code path rather than two that can
 * drift"*. Satellites never got the same treatment because
 * `scripts/biffo.sh` was not distributed to them, so they kept receiving
 * copies.
 *
 * This is the other half: ship the canonical script inside the package, and let
 * a satellite reach it through the same bridge.
 *
 * ## Why walk up rather than resolve a fixed path
 *
 * The same reason `findSkeletonRoot` does. In a template checkout this module
 * lives at `cli/src/lib/` (dev) or `cli/dist/lib/` (built) and the script is at
 * the repo root; in the published package it lives at
 * `node_modules/@biffo/cli/dist/lib/` and the script is at
 * `node_modules/@biffo/cli/scripts/`. Nothing exists above that, which is why
 * `cli/scripts/sync-packaged-assets.mjs` copies the file beside `dist/` at
 * prepack time — the same mechanism, and the same failure mode if forgotten,
 * as `_skeletons` in #259 and #315: invisible in CI, broken only on a real
 * npm install.
 */
export function findPackagedScript(startDir: string, relativePath: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, relativePath)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The message a caller shows when resolution fails.
 *
 * Deliberately names the packaging step rather than saying "not found": a
 * missing packaged asset means `prepack` did not run or the entry is absent
 * from `PACKAGED_ROOT_ASSETS`, and that is what the reader needs to check. An
 * error that names the symptom instead of the precondition is what #1160
 * records the cost of.
 */
export function packagedScriptMissing(relativePath: string): string {
  return (
    `biffo: cannot find ${relativePath}.\n` +
    `It ships with this package via cli/scripts/packaged-root-assets.mjs; if you are running ` +
    `from a checkout, run from inside the template repo. If you are running the published ` +
    `package, this is a packaging bug — the asset was not copied at prepack.`
  )
}
