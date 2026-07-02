import { Command } from 'commander'
import { pluginInstallCommand } from './plugin-install.js'

export const pluginCommand = new Command('plugin').description('Manage Biffo plugins')

pluginCommand.addCommand(pluginInstallCommand)
