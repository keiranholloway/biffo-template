import { execSync } from 'node:child_process'
import { Octokit } from '@octokit/rest'
import type { BiffoConfig, ProvisioningConfig } from '../../../config/schema.js'
import { log } from '../../../lib/logger.js'

export interface GitHubAdapterOptions {
  templateOwner?: string
  templateRepo?: string
}

/**
 * The required status-check contexts a freshly scaffolded repo gets on
 * `dev`/`staging`/`main`. GitHub matches a context against the job *name* (not
 * its id), so every entry here must be the `name:` of a job that actually runs
 * — a context nothing reports leaves every PR permanently BLOCKED even with all
 * real checks green.
 *
 * `configureBranchProtection` defaults to this list, and neither caller
 * overrides it: `biffo init` ships `.github/workflows/ci.yml` and `biffo
 * sibling create` (ADR-0007) ships
 * `_skeletons/sibling-template/.github/workflows/ci.yml`, so *both* workflows
 * must declare exactly these job names. `status-checks.test.ts` enforces that
 * coupling in CI (issue #189) — edit a workflow's job names and that test tells
 * you to update this constant.
 *
 * CI consolidates all JS checks into one job and all Python checks into another
 * (per-job billing + repeated installs make a dozen sub-minute jobs wasteful),
 * so lint/type/test/audit/SAST are folded into the two toolchain checks below.
 * The core workflow's template-only `Core Version Guard` job is deliberately
 * absent: it no-ops in instances (see `status-checks.test.ts`).
 */
export const DEFAULT_STATUS_CHECKS = [
  'JS (lint, types, test, audit)',
  'Python (lint, types, test, security)',
  'Secret Scan',
  'Terraform Validate & Security',
]

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

  /**
   * Open a pull request and return its URL and number. Used by
   * `biffo core upgrade --apply` (ADR-0006 Phase 3b) to propose a core upgrade
   * as a reviewable PR rather than pushing to a protected branch.
   */
  async createPullRequest(args: {
    owner: string
    repo: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<{ url: string; number: number }> {
    const { data } = await this.octokit.pulls.create({
      owner: args.owner,
      repo: args.repo,
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
    })
    return { url: data.html_url, number: data.number }
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

  /**
   * Creates a plain empty repository — no GitHub template-generation
   * involved. Used by `biffo sibling create` (ADR-0007): the sibling
   * skeleton lives at `_skeletons/sibling-template/` inside biffo-template
   * itself and is pushed in as the new repo's first commit by the caller
   * (via GitAdapter), rather than requiring a second, separately-published
   * GitHub template repo for `createRepoFromTemplate`'s `is_template`
   * machinery to point at.
   *
   * `repos.createInOrg` and `repos.createForAuthenticatedUser` are distinct
   * REST endpoints (org-owned vs personal-account-owned repos) — unlike
   * `createRepoFromTemplate`'s generate endpoint, which accepts either kind
   * of owner uniformly via one `owner` field. Tries org creation first (the
   * common case); a 404 there means `org` isn't actually a GitHub
   * organization, so falls back to creating it under the authenticated
   * user's own account instead.
   */
  async createEmptyRepo(org: string, repo: string, description?: string): Promise<string> {
    // If the repo already exists (e.g. a previous failed sibling create), skip creation.
    try {
      const { data: existing } = await this.octokit.repos.get({ owner: org, repo })
      log.info(`Repository ${org}/${repo} already exists — skipping creation`)
      return existing.clone_url
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 404) throw err
      // 404 = doesn't exist yet, proceed with creation
    }

    log.info(`Creating repository ${org}/${repo}...`)

    try {
      const { data } = await this.octokit.repos.createInOrg({
        org,
        name: repo,
        private: true,
        ...(description !== undefined ? { description } : {}),
      })
      log.success(`Repository created: ${data.html_url}`)
      return data.clone_url
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 404) throw err
      // 404 = `org` isn't a GitHub organization — fall back to the
      // authenticated user's own personal account.
    }

    const { data } = await this.octokit.repos.createForAuthenticatedUser({
      name: repo,
      private: true,
      ...(description !== undefined ? { description } : {}),
    })
    log.success(`Repository created: ${data.html_url}`)
    return data.clone_url
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

  /**
   * Read a file's decoded UTF-8 content at `ref`, or `undefined` if it is absent
   * (404) or is not a regular file (a directory or submodule).
   */
  private async getFileContent(
    org: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | undefined> {
    try {
      const { data } = await this.octokit.repos.getContent({ owner: org, repo, path, ref })
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return undefined
      }
      return Buffer.from(data.content, 'base64').toString('utf8')
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return undefined
      throw err
    }
  }

  /**
   * Commit `files` onto `branch` as a single commit, via the Git Data API
   * (blobs → tree → commit → ref) so every change lands atomically rather than
   * as one commit each. A `content` of `null` deletes the path.
   *
   * Idempotent: if the branch head already matches every requested change
   * (content equal, or path absent for a deletion), nothing is committed and
   * `null` is returned. `biffo init` is resumable and step-checkpointed, so a
   * re-run must not pile up empty or duplicate commits.
   *
   * Called by `biffo init` *before* `configureBranchProtection`, so at that
   * point no protection exists to bypass. On a resumed init the branches may
   * already be protected; the init token is the repo's own creator (an admin)
   * and protection is configured with `enforce_admins: false`, so the write
   * still succeeds. If GitHub refuses it anyway, that surfaces as a clear error
   * telling the user to land the change by PR — protection is never loosened to
   * make this work.
   */
  async commitFiles(
    org: string,
    repo: string,
    branch: string,
    files: { path: string; content: string | null }[],
    message: string,
  ): Promise<string | null> {
    const existing = await Promise.all(
      files.map((f) => this.getFileContent(org, repo, f.path, branch)),
    )
    if (files.every((f, i) => existing[i] === (f.content ?? undefined))) {
      log.info(`${branch}: ${files.map((f) => f.path).join(', ')} already as intended — skipping`)
      return null
    }

    const ref = await this.waitForRef(org, repo, `heads/${branch}`, 120_000, 3_000)
    const headSha = ref.object.sha
    const { data: headCommit } = await this.octokit.git.getCommit({
      owner: org,
      repo,
      commit_sha: headSha,
    })

    // A tree entry with a null sha deletes the path; anything else needs a blob.
    const entries = await Promise.all(
      files.map(async (f) => {
        if (f.content === null) {
          return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: null }
        }
        const { data } = await this.octokit.git.createBlob({
          owner: org,
          repo,
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          encoding: 'base64',
        })
        return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: data.sha }
      }),
    )

    const { data: tree } = await this.octokit.git.createTree({
      owner: org,
      repo,
      base_tree: headCommit.tree.sha,
      tree: entries,
    })

    const { data: commit } = await this.octokit.git.createCommit({
      owner: org,
      repo,
      message,
      tree: tree.sha,
      parents: [headSha],
    })

    try {
      await this.octokit.git.updateRef({
        owner: org,
        repo,
        ref: `heads/${branch}`,
        sha: commit.sha,
      })
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      if (status === 403 || status === 422) {
        throw new Error(
          `Could not commit ${files.map((f) => f.path).join(' and ')} to ${org}/${repo}@${branch}: ` +
            `${(err as Error).message}\n` +
            `  Branch protection on "${branch}" rejected the write. Add these files via a pull ` +
            `request instead — do not disable branch protection to work around this.`,
        )
      }
      throw err
    }

    log.info(`Committed ${files.map((f) => f.path).join(', ')} to ${branch}`)
    return commit.sha
  }

  async setDefaultBranch(org: string, repo: string, branch: string): Promise<void> {
    await this.octokit.repos.update({ owner: org, repo, default_branch: branch })
    log.info(`Default branch set to ${branch}`)
  }

  async configureBranchProtection(
    config: ProvisioningConfig,
    protectionIntervalMs = 3_000,
    statusChecks: string[] = DEFAULT_STATUS_CHECKS,
  ): Promise<void> {
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config

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
          const status = (err as { status?: number }).status
          if (status === 403) {
            // GitHub requires Team/Enterprise for branch protection on a
            // private repo owned by an organization (free-plan orgs and
            // most personal accounts on paid individual plans differ here —
            // this 403 is the API's own signal, not something worth trying
            // to predict from the plan name in advance). Skipping is safe:
            // callers can add protection later via the same GitHub UI/API
            // once the org's plan supports it, or after making the repo
            // public. Retrying the same request or trying the next branch
            // would just hit the identical 403 again.
            log.warn(`Branch protection unavailable for ${org}/${repo}: ${(err as Error).message}`)
            log.warn(
              '  This usually means the organization is on a plan that only supports branch ' +
                'protection on public repos (GitHub Team/Enterprise is required for private ' +
                'org repos). Skipping branch protection — add it later via GitHub once the ' +
                'plan allows it, or make the repo public.',
            )
            return
          }
          if (status !== 404 || Date.now() >= deadline) throw err
          log.info('Branch protection endpoint not yet ready, retrying...')
          await new Promise((resolve) => setTimeout(resolve, protectionIntervalMs))
        }
      }
    }

    log.success('Branch protection configured on dev, staging, and main')
  }

  async createEnvironments(config: ProvisioningConfig): Promise<void> {
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config

    for (const env of config.environments) {
      log.info(`Creating GitHub Environment: ${env}...`)

      // No protection rules are set here. `prod` used to be created with
      // `reviewers: []`, which was doubly wrong: an empty required-reviewers
      // list gates nothing even when it is accepted, and GitHub rejects the
      // rule outright with 422 on private repos whose plan does not include
      // required reviewers ("Please ensure the billing plan supports the
      // required reviewers protection rule"). That 422 aborted `biffo init`
      // partway through step 5 — after the repo, OIDC role, state bucket,
      // branches and branch protection existed, but before Actions secrets and
      // variables were written, leaving a repo whose CI could not authenticate
      // to AWS. A free plan with a private repo is the default solopreneur
      // setup Biffo targets, so this failed for the primary user.
      //
      // Real prod approval gating needs actual reviewer ids, so it belongs in
      // config rather than hardcoded here, and must degrade with a warning when
      // the plan does not support it. Tracked separately; see the PR for #267.
      await this.octokit.repos.createOrUpdateEnvironment({
        owner: org,
        repo,
        environment_name: env,
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

  /**
   * Read a repository Actions variable's value, or `undefined` if it isn't set.
   * A 404 means the variable doesn't exist on the repo (not an error) — used to
   * probe a source repo for an optional variable before mirroring it elsewhere.
   */
  async getRepoVariable(org: string, repo: string, name: string): Promise<string | undefined> {
    try {
      const { data } = await this.octokit.request(
        'GET /repos/{owner}/{repo}/actions/variables/{variable_name}',
        { owner: org, repo, variable_name: name },
      )
      return data.value
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        return undefined
      }
      throw err
    }
  }

  /**
   * Enable GitHub Dependabot alerts (native vulnerability alerts) on a repo.
   * Best-effort: some plans/repos don't support it, so a failure logs a warning
   * rather than aborting provisioning — the repo is already usable without it.
   */
  async enableVulnerabilityAlerts(org: string, repo: string): Promise<void> {
    try {
      await this.octokit.request('PUT /repos/{owner}/{repo}/vulnerability-alerts', {
        owner: org,
        repo,
      })
      log.info(`Enabled Dependabot alerts on ${org}/${repo}`)
    } catch (err: unknown) {
      log.warn(`Could not enable Dependabot alerts on ${org}/${repo}: ${(err as Error).message}`)
    }
  }

  async getLatestWorkflowRunId(
    org: string,
    repo: string,
    workflowId: string,
    timeoutMs = 60_000,
    intervalMs = 5_000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      try {
        const { data } = await this.octokit.actions.listWorkflowRuns({
          owner: org,
          repo,
          workflow_id: workflowId,
          per_page: 1,
        })
        return data.workflow_runs[0]?.id ?? 0
      } catch (err: unknown) {
        if ((err as { status?: number }).status !== 404 || Date.now() >= deadline) throw err
        // On a just-created repo, GitHub Actions can take a few seconds to
        // discover and index workflow files pushed via template generation,
        // even though the file itself is already present in the repo — the
        // workflow_id lookup 404s until that indexing completes.
        log.info(`Workflow ${workflowId} not yet indexed by GitHub Actions, retrying...`)
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }
  }

  async triggerWorkflow(
    org: string,
    repo: string,
    workflowId: string,
    inputs: Record<string, string> = {},
    ref = 'main',
    timeoutMs = 60_000,
    intervalMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      try {
        await this.octokit.actions.createWorkflowDispatch({
          owner: org,
          repo,
          workflow_id: workflowId,
          ref,
          inputs,
        })
        return
      } catch (err: unknown) {
        if ((err as { status?: number }).status !== 404 || Date.now() >= deadline) throw err
        log.info(`Workflow ${workflowId} not yet indexed by GitHub Actions, retrying...`)
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }
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
