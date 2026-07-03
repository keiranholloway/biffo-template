import { Command } from 'commander'
import { coreStatusCommand } from './core-status.js'

export const coreCommand = new Command('core').description(
  'Inspect and upgrade the Biffo template core an instance was scaffolded from (ADR-0006)',
)

coreCommand.addCommand(coreStatusCommand)
