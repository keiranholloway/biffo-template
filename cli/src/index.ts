#!/usr/bin/env node
import { Command } from 'commander'
import { coreCommand } from './commands/core.js'
import { dataCommand } from './commands/data.js'
import { deployCommand } from './commands/deploy.js'
import { destroyCommand } from './commands/destroy.js'
import { initCommand } from './commands/init.js'
import { pluginCommand } from './commands/plugin.js'
import { siblingCommand } from './commands/sibling.js'
import { checkCommand } from './commands/check.js'
import { doctorCommand } from './commands/doctor.js'
import { teardownCommand } from './commands/teardown.js'
import { waitForChecksCommand } from './commands/wait-for-checks.js'
import { getLatestCoreVersion } from './lib/core-version.js'
import { NonInteractiveError, registerNonInteractive } from './lib/interactive.js'
import { log } from './lib/logger.js'

const program = new Command()

/**
 * The CLI's version IS `core.version` (ADR-0006) — one number, no mapping table.
 *
 * Read at runtime rather than hardcoded. `.version(cliVersion())` was a literal, so
 * the first published build reported 0.0.0 despite the registry correctly
 * showing 0.33.3 — the publish workflow stamps `package.json`, which the
 * hardcoded string ignored. That defeats the point of publishing: a scaffolded
 * repo could not be traced to the build that made it (#259).
 *
 * `getLatestCoreVersion()` walks up from this module and finds the copy the
 * package ships beside `dist/` (prepack writes it; `files` includes it). In a
 * template checkout it finds the repo-root one, so local runs report the
 * working version rather than a stale literal.
 *
 * It throws if no `core.version` is reachable, which would mean a malformed
 * package. `--version` should not be the place that fails, so fall back to
 * 'unknown' — a wrong-looking version is more useful than a crash on --help.
 */
function cliVersion(): string {
  try {
    return getLatestCoreVersion()
  } catch {
    return 'unknown'
  }
}

program
  .name('biffo')
  .description('Biffo — opinionated project scaffolding and deployment CLI')
  .version(cliVersion())

program.addCommand(initCommand)
program.addCommand(deployCommand)
program.addCommand(destroyCommand)
program.addCommand(teardownCommand)
program.addCommand(waitForChecksCommand)
program.addCommand(pluginCommand)
program.addCommand(dataCommand)
program.addCommand(coreCommand)
program.addCommand(siblingCommand)
program.addCommand(checkCommand)
program.addCommand(doctorCommand)

// `--non-interactive` is global: registered on the root program and on every
// subcommand (Commander rejects unknown options on subcommands), so it may be
// given on either side of the command name.
registerNonInteractive(program)

program.parseAsync().catch((err: unknown) => {
  if (err instanceof NonInteractiveError) {
    log.error(err.message)
    process.exit(1)
  }
  throw err
})
