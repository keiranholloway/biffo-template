#!/usr/bin/env node
import { Command } from 'commander'
import { coreCommand } from './commands/core.js'
import { dataCommand } from './commands/data.js'
import { deployCommand } from './commands/deploy.js'
import { destroyCommand } from './commands/destroy.js'
import { initCommand } from './commands/init.js'
import { pluginCommand } from './commands/plugin.js'
import { teardownCommand } from './commands/teardown.js'

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

program.parse()
