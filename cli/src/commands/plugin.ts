import { Command } from 'commander'
import { pluginCreateCommand } from './plugin-create.js'
import { pluginInfoCommand } from './plugin-info.js'
import { pluginInstallCommand } from './plugin-install.js'
import { pluginListCommand } from './plugin-list.js'
import { pluginStalenessCommand } from './plugin-staleness.js'
import { pluginSyncMigrationsCommand } from './plugin-sync-migrations.js'
import { pluginUninstallCommand } from './plugin-uninstall.js'
import { pluginUpgradeCommand } from './plugin-upgrade.js'

export const pluginCommand = new Command('plugin').description('Manage Biffo plugins')

pluginCommand.addCommand(pluginCreateCommand)
pluginCommand.addCommand(pluginListCommand)
pluginCommand.addCommand(pluginInstallCommand)
pluginCommand.addCommand(pluginUninstallCommand)
pluginCommand.addCommand(pluginUpgradeCommand)
pluginCommand.addCommand(pluginSyncMigrationsCommand)
pluginCommand.addCommand(pluginInfoCommand)
pluginCommand.addCommand(pluginStalenessCommand)
