import { Command } from 'commander'
import { execa } from 'execa'
import { log } from '../lib/logger.js'

export const deployCommand = new Command('deploy')
  .description('Deploy infrastructure and application to an environment')
  .argument('<environment>', 'Target environment: dev | staging | prod')
  .option('--infra-only', 'Deploy infrastructure only, skip application build')
  .option('--app-only', 'Deploy application only, skip Terraform')
  .action(async (environment: string, options: { infraOnly?: boolean; appOnly?: boolean }) => {
    const validEnvs = ['dev', 'staging', 'prod']
    if (!validEnvs.includes(environment)) {
      log.error(`Unknown environment: ${environment}. Must be one of: ${validEnvs.join(', ')}`)
      process.exit(1)
    }

    log.info(`Deploying to ${environment}...`)

    if (!options.appOnly) {
      log.info('Running Terraform apply...')
      await execa('terraform', ['apply', '-auto-approve'], {
        cwd: `infra/environments/${environment}`,
        stdio: 'inherit',
      })
    }

    if (!options.infraOnly) {
      log.info('Building and deploying application...')
      await execa('pnpm', ['turbo', 'run', 'build'], { stdio: 'inherit' })
    }

    log.success(`Deploy to ${environment} complete`)
  })
