import { Command } from 'commander'
import { execa } from 'execa'
import inquirer from 'inquirer'
import { log } from '../lib/logger.js'

export const destroyCommand = new Command('destroy')
  .description('Destroy infrastructure for an environment (destructive)')
  .argument('<environment>', 'Target environment: dev | staging | prod')
  .action(async (environment: string) => {
    if (environment === 'prod') {
      const { confirmed } = await inquirer.prompt([
        {
          type: 'input',
          name: 'confirmed',
          message: `Type the project name to confirm destruction of PRODUCTION:`,
        },
      ])
      if (!confirmed) {
        log.warn('Destruction cancelled')
        return
      }
    } else {
      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Destroy ${environment} environment?`,
          default: false,
        },
      ])
      if (!confirmed) {
        log.warn('Destruction cancelled')
        return
      }
    }

    log.warn(`Destroying ${environment} environment...`)
    await execa('terraform', ['destroy', '-auto-approve'], {
      cwd: `infra/environments/${environment}`,
      stdio: 'inherit',
    })

    log.success(`${environment} environment destroyed`)
  })
