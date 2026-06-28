#!/usr/bin/env node
import { Command } from 'commander'
import { deployCommand } from './commands/deploy.js'
import { destroyCommand } from './commands/destroy.js'
import { initCommand } from './commands/init.js'

const program = new Command()

program
  .name('biffo')
  .description('Biffo — opinionated project scaffolding and deployment CLI')
  .version('0.0.0')

program.addCommand(initCommand)
program.addCommand(deployCommand)
program.addCommand(destroyCommand)

program.parse()
