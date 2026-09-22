import { log } from '../logger.js'
import { packagedScriptMissing } from '../packaged-scripts.js'
import type { CommandRunner } from './command-runner.js'
import { listChecks, runChecksOnce } from './conformance-driver.js'
import { raisePostgres } from './raise-postgres.js'

export interface PluginVerifyOptions {
  cwd: string
  listChecks: boolean
}

export interface PluginVerifyDeps {
  runner: CommandRunner
  /** Resolves a packaged script's path (e.g. `scripts/pg-test-db.sh`), or `null` if missing. */
  findScript: (relativePath: string) => string | null
}

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
 * 3. `--list-checks`, a read-only bypass that never touches Postgres.
 *
 * Local and CI invoke this exact function — CI's own step is
 * `sh scripts/biffo.sh plugin verify` and contains no logic of its own.
 */
export async function runPluginVerify(
  options: PluginVerifyOptions,
  deps: PluginVerifyDeps,
): Promise<number> {
  if (options.listChecks) {
    return listChecks(deps.runner, options.cwd)
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
  return 0
}
