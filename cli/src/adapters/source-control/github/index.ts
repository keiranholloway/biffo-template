import { Octokit } from '@octokit/rest'
import type { BiffoConfig } from '../../../config/schema.js'
import { log } from '../../../lib/logger.js'

export class GitHubAdapter {
  private octokit: Octokit

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token })
  }

  async createRepoFromTemplate(config: BiffoConfig): Promise<string> {
    const { org, repo } = (config.source_control as { provider: 'github'; config: { org: string; repo: string } }).config

    log.info(`Creating repository ${org}/${repo} from Biffo template...`)

    const { data } = await this.octokit.repos.createUsingTemplate({
      template_owner: 'biffo-platform',
      template_repo: 'biffo',
      owner: org,
      name: repo,
      private: true,
      description: config.project.description,
    })

    log.success(`Repository created: ${data.html_url}`)
    return data.clone_url
  }

  async configureBranchProtection(config: BiffoConfig): Promise<void> {
    const { org, repo } = (config.source_control as { provider: 'github'; config: { org: string; repo: string } }).config

    log.info('Configuring branch protection on main...')

    await this.octokit.repos.updateBranchProtection({
      owner: org,
      repo,
      branch: 'main',
      required_status_checks: {
        strict: true,
        contexts: ['ci / lint-js', 'ci / typecheck', 'ci / security-secrets', 'ci / infra-validate'],
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
    })

    log.success('Branch protection configured')
  }

  async createEnvironments(config: BiffoConfig): Promise<void> {
    const { org, repo } = (config.source_control as { provider: 'github'; config: { org: string; repo: string } }).config

    for (const env of config.environments) {
      log.info(`Creating GitHub Environment: ${env}...`)

      await this.octokit.repos.createOrUpdateEnvironment({
        owner: org,
        repo,
        environment_name: env,
        reviewers: env === 'prod' ? [] : undefined,
      })
    }

    log.success('GitHub Environments created')
  }

  async setRepoSecret(org: string, repo: string, name: string, value: string): Promise<void> {
    const { data: publicKey } = await this.octokit.actions.getRepoPublicKey({ owner: org, repo })

    // Encrypt value with the repo's public key before storing
    // Requires libsodium — wired up fully in the published CLI package
    log.info(`Setting secret: ${name}`)

    await this.octokit.actions.createOrUpdateRepoSecret({
      owner: org,
      repo,
      secret_name: name,
      encrypted_value: await encryptSecret(publicKey.key, value),
      key_id: publicKey.key_id,
    })
  }
}

async function encryptSecret(publicKey: string, secretValue: string): Promise<string> {
  // Uses tweetnacl / libsodium as required by the GitHub API
  // Placeholder — implemented fully in the published CLI package
  void publicKey
  void secretValue
  throw new Error('encryptSecret: install @biffo/cli from npm for the full implementation')
}
