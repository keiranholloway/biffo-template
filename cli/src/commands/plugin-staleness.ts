import { resolve } from 'node:path'
import { Command } from 'commander'
import { GitAdapter } from '../adapters/git/index.js'
import { RegistryAdapter } from '../adapters/registry/index.js'
import {
  checkPluginStaleness,
  exitCodeForStaleness,
  formatStalenessReport,
} from '../lib/plugin-staleness.js'

/**
 * `biffo plugin staleness` — item (1) from #1547: nothing compared an
 * instance's vendored `services/<name>/` against its source, so drift was
 * invisible until someone ran `diff -rq` by hand. See
 * `cli/src/lib/plugin-staleness.ts` for the measurement itself (provenance
 * SHA comparison, cheap; content-diff fallback when no provenance is on
 * record) and `plugin-provenance.ts` for how the SHA gets recorded in the
 * first place (item (2)).
 *
 * This is a real gate, deliberately, unlike `biffo check plugin-staleness`
 * (check.ts) which wraps the same measurement but is advisory-only and never
 * fails: an instance may legitimately want to pin a plugin version, so the
 * default CI-facing surface must not fail a build over that. This
 * subcommand is for a human, or a script that explicitly wants to gate on
 * drift, and follows the estate's standard three-valued exit contract (see
 * `scripts/claim.sh`'s own comment on why 2 is deliberately not 0):
 *
 *   0 — every vendored plugin is up to date
 *   1 — at least one is behind (the bad, but knowable, condition)
 *   2 — at least one could not be determined (never conflated with 0)
 */
export const pluginStalenessCommand = new Command('staleness')
  .description(
    'Report how far each services/<name>/ vendored plugin has drifted from its source ' +
      '(#1547). Exits 0 up to date, 1 behind, 2 cannot tell — 2 is never a pass.',
  )
  .option('--cwd <path>', 'Project root to check (defaults to the current directory)')
  .action(async (options: { cwd?: string }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const results = await checkPluginStaleness(cwd, {
      registry: new RegistryAdapter(),
      git: new GitAdapter(),
    })
    console.log(formatStalenessReport(results))
    process.exit(exitCodeForStaleness(results))
  })
