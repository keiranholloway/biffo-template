import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { RealCommandRunner } from '../lib/plugin-compose/command-runner.js'
import { realComposeDeps } from '../lib/plugin-compose/compose-stack.js'
import { resolveCoreRootForCli } from '../lib/plugin-compose/core-source.js'
import { installInterruptSignal } from '../lib/plugin-compose/interrupt.js'
import { log } from '../lib/logger.js'
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
  .option('--core-root <path>', 'A biffo-template checkout to run Core from (or BIFFO_CORE_ROOT)')
  .option(
    '--config-file <path>',
    'Local plugin config JSON for the real_core composition (default: biffo.dev.json if present)',
  )
  .option(
    '--no-real-core',
    'SKIP the real_core seam (Core + plugin host composition) — loud, never silent',
  )
  .action(
    async (options: {
      cwd?: string
      listChecks?: boolean
      coreRoot?: string
      configFile?: string
      realCore: boolean
    }) => {
      const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
      const here = dirname(fileURLToPath(import.meta.url))
      const runner = new RealCommandRunner()
      const findScript = (relativePath: string) => findPackagedScript(here, relativePath)
      // Installed before anything starts: the composition's servers are detached and
      // would be orphaned by an unhandled signal (see interrupt.ts).
      const interrupt = installInterruptSignal()
      const exitCode = await runPluginVerify(
        {
          cwd,
          listChecks: options.listChecks ?? false,
          realCore: options.realCore,
          ...(options.configFile ? { configFile: resolve(options.configFile) } : {}),
          signal: interrupt.signal,
        },
        {
          runner,
          findScript,
          realCore: {
            coreRoot: () => resolveCoreRootForCli(options.coreRoot, runner),
            compose: realComposeDeps(runner, findScript, (l) => log.info(l)),
          },
        },
      )
      interrupt.dispose()
      process.exit(exitCode)
    },
  )
