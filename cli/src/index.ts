#!/usr/bin/env node
import { Command } from 'commander'
import { coreCommand } from './commands/core.js'
import { dataCommand } from './commands/data.js'
import { deployCommand } from './commands/deploy.js'
import { destroyCommand } from './commands/destroy.js'
import { initCommand } from './commands/init.js'
import { pluginCommand } from './commands/plugin.js'
import { siblingCommand } from './commands/sibling.js'
import { teardownCommand } from './commands/teardown.js'
import { NonInteractiveError, registerNonInteractive } from './lib/interactive.js'
import { log } from './lib/logger.js'

const program = new Command()

program
  .name('biffo')
  .description('Biffo — opinionated project scaffolding and deployment CLI')
  .version('0.0.0')

program.addCommand(initCommand)
program.addCommand(deployCommand)
program.addCommand(destroyCommand)
program.addCommand(teardownCommand)
program.addCommand(pluginCommand)
program.addCommand(dataCommand)
program.addCommand(coreCommand)
program.addCommand(siblingCommand)

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
