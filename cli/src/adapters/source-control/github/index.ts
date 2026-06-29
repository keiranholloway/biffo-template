import { execSync } from 'node:child_process'
import { Octokit } from '@octokit/rest'
import type { BiffoConfig } from '../../../config/schema.js'
import { log } from '../../../lib/logger.js'

export interface GitHubAdapterOptions {
  templateOwner?: string
  templateRepo?: string
}

export class GitHubAdapter {
  private octokit: Octokit
  private templateOwner: string
  private templateRepo: string

  constructor(token: string, opts: GitHubAdapterOptions = {}) {
    this.octokit = new Octokit({ auth: token })
    this.templateOwner = opts.templateOwner ?? 'keiranholloway'
    this.templateRepo = opts.templateRepo ?? 'biffo-template'
  }

  async createRepoFromTemplate(config: BiffoConfig): Promise<string> {
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    const templateOwner = this.templateOwner
    const templateRepo = this.templateRepo

    // GitHub's generate endpoint returns 404 if is_template is not set on the source repo.
    // Try to enable it automatically; surface a clear manual-fix URL if the token lacks admin.
    await this.ensureTemplateFlag(templateOwner, templateRepo)

    // If the repo already exists (e.g. a previous failed init), skip creation.
    try {
      const { data: existing } = await this.octokit.repos.get({ owner: org, repo })
      log.info(`Repository ${org}/${repo} already exists — skipping creation`)
      return existing.clone_url
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 404) throw err
      // 404 = doesn't exist yet, proceed with creation
    }

    log.info(`Creating repository ${org}/${repo} from Biffo template...`)

    const { data } = await this.octokit.repos.createUsingTemplate({
      template_owner: templateOwner,
      template_repo: templateRepo,
      owner: org,
      name: repo,
      private: true,
      description: config.project.description,
    })

    log.success(`Repository created: ${data.html_url}`)
    return data.clone_url
  }

  private async ensureTemplateFlag(owner: string, repo: string): Promise<void> {
    let isTemplate: boolean
    try {
      const { data } = await this.octokit.repos.get({ owner, repo })
      isTemplate = data.is_template ?? false
    } catch {
      throw new Error(
        `Template repository ${owner}/${repo} not found.\n` +
          `  Check that the repo exists and your token has read access.`,
      )
    }

    if (isTemplate) return

    try {
      await this.octokit.repos.update({ owner, repo, is_template: true })
      log.info(`Marked ${owner}/${repo} as a template repository`)
    } catch {
      throw new Error(
        `${owner}/${repo} is not marked as a GitHub template repository.\n` +
          `  Enable it at: https://github.com/${owner}/${repo}/settings\n` +
          `  (Settings → General → check "Template repository") then re-run biffo init.`,
      )
    }
  }

  async deleteRepo(org: string, repo: string): Promise<void> {
    try {
      await this.octokit.repos.get({ owner: org, repo })
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        log.info(`Repository ${org}/${repo} does not exist — skipping`)
        return
      }
      throw err
    }

    log.info(`Deleting repository ${org}/${repo}...`)

    try {
      await this.octokit.repos.delete({ owner: org, repo })
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 403) {
        // Token lacks delete_repo scope — delegate to gh CLI which handles its own auth
        log.info('Token lacks delete_repo scope, delegating to gh CLI...')
        execSync(`gh repo delete ${org}/${repo} --yes`, { stdio: 'inherit' })
      } else {
        throw err
      }
    }

    log.success(`Repository deleted: ${org}/${repo}`)
  }

  private async waitForBranch(
    org: string,
    repo: string,
    branch: string,
    timeoutMs = 120_000,
    intervalMs = 3_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.octokit.repos.getBranch({ owner: org, repo, branch })
        return
      } catch (err: unknown) {
        if ((err as { status?: number }).status !== 404) throw err
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(
      `Branch "${branch}" not found in ${org}/${repo} after ${timeoutMs / 1000}s — ` +
        `GitHub template generation may have stalled. Check the repository and re-run biffo init.`,
    )
  }

  async configureBranchProtection(config: BiffoConfig): Promise<void> {
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config

    log.info('Waiting for main branch to be ready...')
    await this.waitForBranch(org, repo, 'main')
    log.info('Configuring branch protection on main...')

    await this.octokit.repos.updateBranchProtection({
      owner: org,
      repo,
      branch: 'main',
      required_status_checks: {
        strict: true,
        contexts: [
          'ci / lint-js',
          'ci / typecheck',
          'ci / security-secrets',
          'ci / infra-validate',
        ],
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
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config

    for (const env of config.environments) {
      log.info(`Creating GitHub Environment: ${env}...`)

      await this.octokit.repos.createOrUpdateEnvironment({
        owner: org,
        repo,
        environment_name: env,
        ...(env === 'prod' ? { reviewers: [] } : {}),
      })
    }

    log.success('GitHub Environments created')
  }

  async setRepoSecret(org: string, repo: string, name: string, value: string): Promise<void> {
    log.info(`Setting secret: ${name}`)
    // gh handles libsodium encryption internally — avoids adding crypto deps here
    execSync(`gh secret set ${name} --repo ${org}/${repo}`, {
      input: value,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
}
