import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { RealCommandRunner } from '../lib/plugin-verify/command-runner.js'
import { runPluginVerify } from '../lib/plugin-verify/run-plugin-verify.js'
import { findPackagedScript } from '../lib/packaged-scripts.js'

/**
 * `biffo plugin verify` — the real-execution conformance harness
 * (biffo-template#1523/#1924): raises a real Postgres via the already-shipped
 * `pg-test-db.sh`, then runs every implemented `biffo_plugin_sdk.conformance`
 * check twice against it. See `cli/src/lib/plugin-verify/run-plugin-verify.ts`
 * for the composition and `packages/python-sdk/src/biffo_plugin_sdk/
 * conformance/` for the checks themselves.
 */
export const pluginVerifyCommand = new Command('verify')
  .description(
    'Real-execution conformance harness for a plugin repo: raises a real Postgres, runs ' +
      'every implemented biffo_plugin_sdk.conformance check twice against it, and exits ' +
      'non-zero on the first failure (biffo-template#1523/#1924).',
  )
  .option('--cwd <path>', 'Plugin repo root to check (defaults to the current directory)')
  .option('--list-checks', 'Print every declared #1523 seam and its implemented state, then exit')
  .action(async (options: { cwd?: string; listChecks?: boolean }) => {
    const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const here = dirname(fileURLToPath(import.meta.url))
    const exitCode = await runPluginVerify(
      { cwd, listChecks: options.listChecks ?? false },
      {
        runner: new RealCommandRunner(),
        findScript: (relativePath) => findPackagedScript(here, relativePath),
      },
    )
    process.exit(exitCode)
  })
