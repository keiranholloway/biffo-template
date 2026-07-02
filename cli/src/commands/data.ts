import { Command } from 'commander'
import { dataApplyCommand } from './data-apply.js'
import { dataImportCommand } from './data-import.js'
import { dataListCommand } from './data-list.js'

export const dataCommand = new Command('data').description('Manage DDL data imports (ADR-0005)')

dataCommand.addCommand(dataImportCommand)
dataCommand.addCommand(dataApplyCommand)
dataCommand.addCommand(dataListCommand)
