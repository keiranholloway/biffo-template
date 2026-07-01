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
    this.octokit = new Octokit({
      auth: token,
      // Suppress all Octokit request-level logs. In @octokit/request v9+, expected
      // 4xx responses (e.g. "does this variable/branch exist?") are logged at
      // error level before the error is thrown and caught by our own try/catch.
      // All real errors surface through those catch blocks — no need for the
      // Octokit log to duplicate them.
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })
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

  private async waitForRef(
    org: string,
    repo: string,
    ref: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<{ object: { sha: string } }> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const { data } = await this.octokit.git.getRef({ owner: org, repo, ref })
        return data
      } catch (err: unknown) {
        if ((err as { status?: number }).status !== 404) throw err
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(
      `Ref "${ref}" not found in ${org}/${repo} after ${timeoutMs / 1000}s — ` +
        `GitHub template generation may have stalled. Check the repository and re-run biffo init.`,
    )
  }

  async createBranch(
    org: string,
    repo: string,
    branch: string,
    from = 'main',
    waitTimeoutMs = 120_000,
    waitIntervalMs = 3_000,
  ): Promise<void> {
    try {
      await this.octokit.repos.getBranch({ owner: org, repo, branch })
      log.info(`Branch ${branch} already exists — skipping`)
      return
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 404) throw err
    }
    // Template generation is async — GitHub returns 409 "Git Repository is empty"
    // on getRef until the template files have been committed to main.
    await this.waitForBranch(org, repo, from, waitTimeoutMs, waitIntervalMs)
    // repos.getBranch (Repos API, above) and git.getRef (Git Data API, below) are
    // different GitHub backends with independent eventual consistency — the source
    // branch being visible via one does not guarantee the ref is visible via the
    // other yet, so retry the ref lookup on its own 404s too instead of assuming
    // it's immediately available.
    const ref = await this.waitForRef(org, repo, `heads/${from}`, waitTimeoutMs, waitIntervalMs)
    await this.octokit.git.createRef({
      owner: org,
      repo,
      ref: `refs/heads/${branch}`,
      sha: ref.object.sha,
    })
    log.info(`Created branch ${branch} from ${from}`)
  }

  async setDefaultBranch(org: string, repo: string, branch: string): Promise<void> {
    await this.octokit.repos.update({ owner: org, repo, default_branch: branch })
    log.info(`Default branch set to ${branch}`)
  }

  async configureBranchProtection(
    config: BiffoConfig,
    protectionIntervalMs = 3_000,
  ): Promise<void> {
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config

    const statusChecks = [
      'Lint (JS/TS)',
      'Lint (Python)',
      'Test (JS/TS)',
      'Test (Python)',
      'Type Check (TS)',
      'Type Check (Python)',
      'Dependency Audit (JS)',
      'Dependency Audit (Python)',
      'Secret Scan',
      'SAST (Python / Bandit)',
      'Terraform Validate & Security',
    ]

    // Protect all three branches: dev → staging → main (prod)
    // dev: default branch; all feature work lands here via PR
    // staging: promoted from dev; mirrors prod config
    // main: production; requires prod-environment approval
    const branches = ['dev', 'staging', 'main']

    for (const branch of branches) {
      log.info(`Waiting for ${branch} branch to be ready...`)
      await this.waitForBranch(org, repo, branch)
      log.info(`Configuring branch protection on ${branch}...`)

      const params = {
        owner: org,
        repo,
        branch,
        required_status_checks: { strict: true, contexts: statusChecks },
        enforce_admins: false,
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          dismiss_stale_reviews: false,
        },
        restrictions: null,
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
      }

      const deadline = Date.now() + 30_000
      while (true) {
        try {
          await this.octokit.repos.updateBranchProtection(params)
          break
        } catch (err: unknown) {
          if ((err as { status?: number }).status !== 404 || Date.now() >= deadline) throw err
          log.info('Branch protection endpoint not yet ready, retrying...')
          await new Promise((resolve) => setTimeout(resolve, protectionIntervalMs))
        }
      }
    }

    log.success('Branch protection configured on dev, staging, and main')
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

  async setEnvVariable(
    org: string,
    repo: string,
    env: string,
    name: string,
    value: string,
  ): Promise<void> {
    log.info(`Setting variable: ${name} (${env})`)
    try {
      await this.octokit.request(
        'PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{variable_name}',
        { owner: org, repo, environment_name: env, variable_name: name, name, value },
      )
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        await this.octokit.request(
          'POST /repos/{owner}/{repo}/environments/{environment_name}/variables',
          { owner: org, repo, environment_name: env, name, value },
        )
      } else {
        throw err
      }
    }
  }

  async setRepoVariable(org: string, repo: string, name: string, value: string): Promise<void> {
    log.info(`Setting variable: ${name}`)
    // GitHub variables API has no upsert endpoint — PATCH updates, POST creates.
    // Try PATCH first; 404 means variable doesn't exist yet so fall through to POST.
    // The Octokit log is silenced at info level so the 404 doesn't surface to the user.
    try {
      await this.octokit.request('PATCH /repos/{owner}/{repo}/actions/variables/{variable_name}', {
        owner: org,
        repo,
        variable_name: name,
        name,
        value,
      })
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      if (status === 404) {
        await this.octokit.request('POST /repos/{owner}/{repo}/actions/variables', {
          owner: org,
          repo,
          name,
          value,
        })
      } else if (status === 403) {
        throw new Error(
          `GitHub token lacks permission to set repository variables on ${org}/${repo}.\n` +
            `  Ensure your token has the "repo" scope at: https://github.com/settings/tokens`,
        )
      } else {
        throw err
      }
    }
  }

  async getLatestWorkflowRunId(org: string, repo: string, workflowId: string): Promise<number> {
    const { data } = await this.octokit.actions.listWorkflowRuns({
      owner: org,
      repo,
      workflow_id: workflowId,
      per_page: 1,
    })
    return data.workflow_runs[0]?.id ?? 0
  }

  async triggerWorkflow(
    org: string,
    repo: string,
    workflowId: string,
    inputs: Record<string, string> = {},
    ref = 'main',
  ): Promise<void> {
    await this.octokit.actions.createWorkflowDispatch({
      owner: org,
      repo,
      workflow_id: workflowId,
      ref,
      inputs,
    })
  }

  async waitForWorkflowRun(
    org: string,
    repo: string,
    workflowId: string,
    baselineRunId: number,
    timeoutMs = 3_600_000,
    intervalMs = 30_000,
    branch = 'main',
  ): Promise<{ id: number; conclusion: string | null }> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const { data } = await this.octokit.actions.listWorkflowRuns({
        owner: org,
        repo,
        workflow_id: workflowId,
        event: 'workflow_dispatch',
        branch,
        per_page: 10,
      })

      // Find the first run with an ID higher than the baseline we captured before dispatch
      const run = data.workflow_runs.find((r) => r.id > baselineRunId)

      if (run) {
        if (run.status === 'completed') {
          return { id: run.id, conclusion: run.conclusion ?? null }
        }
        log.info(`  Run #${run.id}: ${run.status}...`)
      } else {
        log.info('  Waiting for run to be queued...')
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    throw new Error(
      `Workflow ${workflowId} did not complete within ${timeoutMs / 1000 / 60} minutes`,
    )
  }
}
