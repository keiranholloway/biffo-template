import { Command } from 'commander'
import { coreDiffCommand } from './core-diff.js'
import { coreStatusCommand } from './core-status.js'
import { coreUpgradeCommand } from './core-upgrade.js'

export const coreCommand = new Command('core').description(
  'Inspect and upgrade the Biffo template core an instance was scaffolded from (ADR-0006)',
)

coreCommand.addCommand(coreStatusCommand)
coreCommand.addCommand(coreDiffCommand)
coreCommand.addCommand(coreUpgradeCommand)
