import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { findPackagedScript } from '../lib/packaged-scripts.js'
import { RealCommandRunner } from '../lib/plugin-compose/command-runner.js'
import { realComposeDeps } from '../lib/plugin-compose/compose-stack.js'
import { resolveCoreRootForCli } from '../lib/plugin-compose/core-source.js'
import { pickConfigFile, runDevUp } from '../lib/plugin-compose/dev-up.js'
import { installInterruptSignal } from '../lib/plugin-compose/interrupt.js'
import { log } from '../lib/logger.js'

const devUpCommand = new Command('up')
  .description(
    'Bring up Postgres + Core + the plugin host + this plugin locally (off real AWS), with a ' +
      'dev-minted token, plugin config from a local file, and hot reload of the plugin ' +
      '(biffo-template#1525). Shares its composition with `biffo plugin verify`.',
  )
  .option('--cwd <path>', 'Plugin repo root (defaults to the current directory)')
  .option('--core-root <path>', 'A biffo-template checkout to run Core from (or BIFFO_CORE_ROOT)')
  .option(
    '--config-file <path>',
    'Local plugin config JSON { "<name>": "<value>" } (default: biffo.dev.json if present)',
  )
  .option('--no-reload', 'Do not hot-reload the plugin host on source changes')
  .option('--check', 'Compose, run the route probes (incl. the known-bad control), tear down, exit')
  .action(
    async (options: {
      cwd?: string
      coreRoot?: string
      configFile?: string
      reload: boolean
      check?: boolean
    }) => {
      const pluginRoot = options.cwd ? resolve(options.cwd) : process.cwd()
      const here = dirname(fileURLToPath(import.meta.url))
      const runner = new RealCommandRunner()
      let coreRoot: string
      try {
        coreRoot = resolveCoreRootForCli(options.coreRoot, runner)
      } catch (err) {
        log.error(`dev up: ${(err as Error).message}`)
        process.exit(1)
      }
      const deps = realComposeDeps(
        runner,
        (p) => findPackagedScript(here, p),
        (l) => log.info(l),
      )
      // Installed before anything starts: the servers are detached, so a signal that
      // kills this process unhandled would orphan them (see interrupt.ts).
      const interrupt = installInterruptSignal()
      const exitCode = await runDevUp(
        {
          pluginRoot,
          coreRoot,
          configFile: pickConfigFile(
            pluginRoot,
            options.configFile ? resolve(options.configFile) : undefined,
          ),
          reload: options.reload,
          check: options.check ?? false,
          signal: interrupt.signal,
        },
        deps,
        {
          write: (line) => console.log(line),
          untilInterrupted: () =>
            new Promise<void>((done) => {
              if (interrupt.signal.aborted) done()
              else interrupt.signal.addEventListener('abort', () => done(), { once: true })
            }),
        },
      )
      interrupt.dispose()
      process.exit(exitCode)
    },
  )

export const devCommand = new Command('dev').description('Local development composition')
devCommand.addCommand(devUpCommand)
