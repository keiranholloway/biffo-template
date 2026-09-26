import { log } from '../logger.js'
import { packagedScriptMissing } from '../packaged-scripts.js'
import type { CommandRunner } from '../plugin-compose/command-runner.js'
import { listChecks, runChecksOnce } from './conformance-driver.js'
import type { ComposeDeps } from '../plugin-compose/compose-stack.js'
import { pickConfigFile, runCompositionCheck } from '../plugin-compose/dev-up.js'
import { raisePostgres } from '../plugin-compose/raise-postgres.js'

export interface PluginVerifyOptions {
  cwd: string
  listChecks: boolean
  /** Run the `real_core` seam (#1523 item 3). Default on; `--no-real-core` is a loud opt-out. */
  realCore: boolean
  /** Local plugin-config file for the composition, or undefined for `biffo.dev.json` if present. */
  configFile?: string
  /** Fires on SIGINT/SIGTERM/SIGHUP so a mid-startup composition still tears down. */
  signal?: AbortSignal
}

/** What the `real_core` seam needs to consume `plugin-compose`'s composition. */
export interface RealCoreDeps {
  /** Resolves the biffo-template checkout Core runs from; may throw (nothing to fetch, offline). */
  coreRoot: () => string
  compose: ComposeDeps
}

export interface PluginVerifyDeps {
  runner: CommandRunner
  /** Resolves a packaged script's path (e.g. `scripts/pg-test-db.sh`), or `null` if missing. */
  findScript: (relativePath: string) => string | null
  /** Required unless `options.realCore` is false — a missing one is refused, never skipped. */
  realCore?: RealCoreDeps
}

const REAL_CORE_LABEL = 'plugin verify (real_core)'

const PG_TEST_DB_SCRIPT = 'scripts/pg-test-db.sh'

/**
 * `biffo plugin verify` (biffo-template#1523/#1924): the spine that composes
 * the pieces this milestone builds. It owns no check logic of its own —
 * `packages/python-sdk/src/biffo_plugin_sdk/conformance/` does — only:
 *
 * 1. raising a real Postgres via the already-distributed `pg-test-db.sh`;
 * 2. running the discovered checks TWICE against that same database, so a
 *    check that is not re-runnable fails the job rather than passing once and
 *    hiding a state leak (mirrors `scripts/verify.sh`'s RLS lane discipline);
 * 3. `--list-checks`, a read-only bypass that never touches Postgres;
 * 4. the `real_core` seam (#1523 item 3, #2105): Core + the shared plugin host,
 *    composed by `plugin-compose/compose-stack.ts` — the SAME composition
 *    `biffo dev up` runs, called through `runCompositionCheck`. Nothing here
 *    starts a process or knows a start order, so a change to that module that
 *    breaks Core start-up is red in this lane and cannot drift from the dev loop.
 *
 * Local and CI invoke this exact function — CI's own step is
 * `sh scripts/biffo.sh plugin verify` and contains no logic of its own.
 */
export async function runPluginVerify(
  options: PluginVerifyOptions,
  deps: PluginVerifyDeps,
): Promise<number> {
  if (options.listChecks) {
    const status = listChecks(deps.runner, options.cwd)
    log.info(
      'real_core            composition-owned: run by `biffo plugin verify` itself via ' +
        'plugin-compose/compose-stack (not by `conformance run`); --no-real-core skips it',
    )
    return status
  }

  // Refused up front: a seam that is required but not wired must not degrade to a skip.
  if (options.realCore && !deps.realCore) {
    log.error('plugin verify: the real_core seam is required but no composition was wired in')
    return 2
  }

  const script = deps.findScript(PG_TEST_DB_SCRIPT)
  if (!script) {
    log.error(packagedScriptMissing(PG_TEST_DB_SCRIPT))
    return 2
  }

  const raised = raisePostgres(deps.runner, script, options.cwd)
  if (!raised.dsn) {
    log.error(
      `plugin verify: could not provision the local Postgres test database (${PG_TEST_DB_SCRIPT} exited ${raised.status})`,
    )
    return raised.status
  }

  log.info('plugin verify: pass 1 of 2')
  const first = runChecksOnce(deps.runner, options.cwd, raised.dsn)
  if (first !== 0) {
    log.error('plugin verify: the first run failed -- see the check output above')
    return first
  }

  log.info('plugin verify: pass 2 of 2 (re-runability against the same database)')
  const second = runChecksOnce(deps.runner, options.cwd, raised.dsn)
  if (second !== 0) {
    log.error(
      'plugin verify: a second consecutive run against the same database failed -- ' +
        'a check that is not re-runnable fails the job (biffo-template#1924)',
    )
    return second
  }

  log.success('plugin verify: green twice against the same database')

  if (!options.realCore) {
    log.warn(
      'plugin verify: the real_core seam was SKIPPED (--no-real-core) -- Core + the plugin ' +
        'host were NOT composed, so nothing here proves the plugin starts under real Core',
    )
    return 0
  }
  return runRealCore(options, deps.realCore as RealCoreDeps)
}

/** The `real_core` seam: hand `plugin-compose` the plugin and report its verdict. */
async function runRealCore(options: PluginVerifyOptions, real: RealCoreDeps): Promise<number> {
  let coreRoot: string
  try {
    coreRoot = real.coreRoot()
  } catch (err) {
    log.error(`${REAL_CORE_LABEL}: ${(err as Error).message}`)
    return 1
  }
  log.info(`${REAL_CORE_LABEL}: composing Core + plugin host (the stack \`biffo dev up\` runs)`)
  const status = await runCompositionCheck(
    {
      pluginRoot: options.cwd,
      coreRoot,
      configFile: pickConfigFile(options.cwd, options.configFile),
      reload: false,
      label: REAL_CORE_LABEL,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    real.compose,
    (line) => log.info(line),
  )
  if (status === 0) log.success('plugin verify: real_core green')
  return status
}
