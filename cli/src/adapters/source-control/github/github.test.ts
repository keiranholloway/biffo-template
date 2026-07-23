import { execSync } from 'node:child_process'
import { Octokit } from '@octokit/rest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../../../config/schema.js'
import { DEFAULT_STATUS_CHECKS, GitHubAdapter } from './index.js'

vi.mock('@octokit/rest')
vi.mock('node:child_process')

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: 'Test', domain: 'example.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'a@b.com', username: 'a' },
})

// Build a fresh mock Octokit instance for each test
function makeOctokitMock() {
  return {
    repos: {
      get: vi.fn(),
      update: vi.fn(),
      createUsingTemplate: vi.fn(),
      createInOrg: vi.fn(),
      createForAuthenticatedUser: vi.fn(),
      delete: vi.fn(),
      getBranch: vi.fn(),
      updateBranchProtection: vi.fn(),
      createOrUpdateEnvironment: vi.fn(),
      getContent: vi.fn(),
      listCommits: vi.fn(),
    },
    git: {
      getRef: vi.fn(),
      createRef: vi.fn(),
      getCommit: vi.fn(),
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
    },
    actions: {
      listWorkflowRuns: vi.fn(),
      createWorkflowDispatch: vi.fn(),
    },
    request: vi.fn(),
  }
}

let octokitMock: ReturnType<typeof makeOctokitMock>

beforeEach(() => {
  vi.clearAllMocks()
  octokitMock = makeOctokitMock()
  vi.mocked(Octokit).mockImplementation(function () {
    return octokitMock as unknown as Octokit
  })
})

function adapter() {
  return new GitHubAdapter('token', { templateOwner: 'tmpl-owner', templateRepo: 'tmpl-repo' })
}

// ─── createRepoFromTemplate ───────────────────────────────────────────────────

describe('createRepoFromTemplate', () => {
  it('skips creation and returns clone_url when destination repo already exists', async () => {
    // Template repo: already a template
    octokitMock.repos.get
      .mockResolvedValueOnce({ data: { is_template: true } }) // ensureTemplateFlag
      .mockResolvedValueOnce({ data: { clone_url: 'https://github.com/acme/my-app.git' } }) // repo exists check

    const url = await adapter().createRepoFromTemplate(CONFIG)
    expect(url).toBe('https://github.com/acme/my-app.git')
    expect(octokitMock.repos.createUsingTemplate).not.toHaveBeenCalled()
  })

  it('creates repo from template when destination does not exist', async () => {
    octokitMock.repos.get
      .mockResolvedValueOnce({ data: { is_template: true } }) // ensureTemplateFlag
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 })) // repo doesn't exist

    octokitMock.repos.createUsingTemplate.mockResolvedValueOnce({
      data: {
        clone_url: 'https://github.com/acme/my-app.git',
        html_url: 'https://github.com/acme/my-app',
      },
    })

    const url = await adapter().createRepoFromTemplate(CONFIG)
    expect(url).toBe('https://github.com/acme/my-app.git')
    expect(octokitMock.repos.createUsingTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', name: 'my-app', private: true }),
    )
  })

  it('re-throws non-404 errors from the destination repo check', async () => {
    octokitMock.repos.get
      .mockResolvedValueOnce({ data: { is_template: true } })
      .mockRejectedValueOnce(Object.assign(new Error('Server Error'), { status: 500 }))

    await expect(adapter().createRepoFromTemplate(CONFIG)).rejects.toThrow('Server Error')
  })
})

// ─── ensureTemplateFlag (via createRepoFromTemplate) ──────────────────────────

describe('ensureTemplateFlag', () => {
  it('proceeds without updating when the template repo is already marked', async () => {
    octokitMock.repos.get
      .mockResolvedValueOnce({ data: { is_template: true } })
      .mockRejectedValueOnce(Object.assign(new Error(), { status: 404 }))
    octokitMock.repos.createUsingTemplate.mockResolvedValueOnce({
      data: { clone_url: 'x', html_url: 'x' },
    })

    await adapter().createRepoFromTemplate(CONFIG)
    expect(octokitMock.repos.update).not.toHaveBeenCalled()
  })

  it('marks the template repo when is_template is false', async () => {
    octokitMock.repos.get
      .mockResolvedValueOnce({ data: { is_template: false } }) // ensureTemplateFlag
      .mockRejectedValueOnce(Object.assign(new Error(), { status: 404 }))
    octokitMock.repos.update.mockResolvedValueOnce({})
    octokitMock.repos.createUsingTemplate.mockResolvedValueOnce({
      data: { clone_url: 'x', html_url: 'x' },
    })

    await adapter().createRepoFromTemplate(CONFIG)
    expect(octokitMock.repos.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_template: true }),
    )
  })

  it('throws with a helpful message when the template repo is not found', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(new Error('Not Found'))

    await expect(adapter().createRepoFromTemplate(CONFIG)).rejects.toThrow(
      'Template repository tmpl-owner/tmpl-repo not found',
    )
  })

  it('throws with a settings URL when marking as template fails', async () => {
    octokitMock.repos.get.mockResolvedValueOnce({ data: { is_template: false } })
    octokitMock.repos.update.mockRejectedValueOnce(new Error('Forbidden'))

    await expect(adapter().createRepoFromTemplate(CONFIG)).rejects.toThrow(
      'https://github.com/tmpl-owner/tmpl-repo/settings',
    )
  })
})

// ─── createEmptyRepo ───────────────────────────────────────────────────────────

describe('createEmptyRepo', () => {
  // Issue #316: the resume case. A previous run created the repo and then died
  // before pushing the skeleton, so the repo exists and is empty. Adopting it is
  // the whole point — the alternative is a run that can never move forward.
  it('adopts an existing EMPTY repo and returns its clone_url', async () => {
    octokitMock.repos.get.mockResolvedValueOnce({
      data: { clone_url: 'https://github.com/acme/my-sibling.git' },
    })
    // GitHub answers "no commits" with 409 Git Repository is empty.
    octokitMock.repos.listCommits.mockRejectedValueOnce(
      Object.assign(new Error('Git Repository is empty.'), { status: 409 }),
    )

    const url = await adapter().createEmptyRepo('acme', 'my-sibling')

    expect(url).toBe('https://github.com/acme/my-sibling.git')
    expect(octokitMock.repos.createInOrg).not.toHaveBeenCalled()
    expect(octokitMock.repos.createForAuthenticatedUser).not.toHaveBeenCalled()
  })

  // The other half of #316: adoption must not become "push the skeleton over
  // whatever was there". A repo with commits is somebody's work.
  it('refuses an existing repo that has content, rather than clobbering it', async () => {
    octokitMock.repos.get.mockResolvedValueOnce({
      data: { clone_url: 'https://github.com/acme/my-sibling.git' },
    })
    octokitMock.repos.listCommits.mockResolvedValueOnce({ data: [{ sha: 'abc123' }] })

    await expect(adapter().createEmptyRepo('acme', 'my-sibling')).rejects.toThrow(
      /already exists and is not empty/,
    )
    expect(octokitMock.repos.createInOrg).not.toHaveBeenCalled()
    expect(octokitMock.repos.createForAuthenticatedUser).not.toHaveBeenCalled()
  })

  it('creates the repo via createInOrg when the destination does not exist', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    octokitMock.repos.createInOrg.mockResolvedValueOnce({
      data: {
        clone_url: 'https://github.com/acme/my-sibling.git',
        html_url: 'https://github.com/acme/my-sibling',
      },
    })

    const url = await adapter().createEmptyRepo('acme', 'my-sibling', 'A sibling app')

    expect(url).toBe('https://github.com/acme/my-sibling.git')
    expect(octokitMock.repos.createInOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        org: 'acme',
        name: 'my-sibling',
        private: true,
        description: 'A sibling app',
      }),
    )
    expect(octokitMock.repos.createForAuthenticatedUser).not.toHaveBeenCalled()
  })

  it('omits description entirely when none is provided', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    octokitMock.repos.createInOrg.mockResolvedValueOnce({
      data: { clone_url: 'x', html_url: 'x' },
    })

    await adapter().createEmptyRepo('acme', 'my-sibling')

    const [call] = vi.mocked(octokitMock.repos.createInOrg).mock.calls
    expect(call![0]).not.toHaveProperty('description')
  })

  it('falls back to createForAuthenticatedUser when org creation 404s', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    octokitMock.repos.createInOrg.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    octokitMock.repos.createForAuthenticatedUser.mockResolvedValueOnce({
      data: {
        clone_url: 'https://github.com/keiran/my-sibling.git',
        html_url: 'https://github.com/keiran/my-sibling',
      },
    })

    const url = await adapter().createEmptyRepo('keiran', 'my-sibling')

    expect(url).toBe('https://github.com/keiran/my-sibling.git')
    expect(octokitMock.repos.createForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-sibling', private: true }),
    )
  })

  it('re-throws non-404 errors from the existence check', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(
      Object.assign(new Error('Server Error'), { status: 500 }),
    )

    await expect(adapter().createEmptyRepo('acme', 'my-sibling')).rejects.toThrow('Server Error')
    expect(octokitMock.repos.createInOrg).not.toHaveBeenCalled()
  })

  it('re-throws non-404 errors from createInOrg without falling back', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    octokitMock.repos.createInOrg.mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )

    await expect(adapter().createEmptyRepo('acme', 'my-sibling')).rejects.toThrow('Forbidden')
    expect(octokitMock.repos.createForAuthenticatedUser).not.toHaveBeenCalled()
  })
})

// ─── deleteRepo ──────────────────────────────────────────────────────────────

describe('deleteRepo', () => {
  it('skips when the repo does not exist (404)', async () => {
    octokitMock.repos.get.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )

    await adapter().deleteRepo('acme', 'my-app')
    expect(octokitMock.repos.delete).not.toHaveBeenCalled()
  })

  it('deletes the repo via API when it exists', async () => {
    octokitMock.repos.get.mockResolvedValueOnce({ data: {} })
    octokitMock.repos.delete.mockResolvedValueOnce({})

    await adapter().deleteRepo('acme', 'my-app')
    expect(octokitMock.repos.delete).toHaveBeenCalledWith({ owner: 'acme', repo: 'my-app' })
  })

  it('falls back to gh CLI when API returns 403', async () => {
    octokitMock.repos.get.mockResolvedValueOnce({ data: {} })
    octokitMock.repos.delete.mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''))

    await adapter().deleteRepo('acme', 'my-app')
    expect(execSync).toHaveBeenCalledWith('gh repo delete acme/my-app --yes', expect.any(Object))
  })

  it('re-throws non-403 API errors', async () => {
    octokitMock.repos.get.mockResolvedValueOnce({ data: {} })
    octokitMock.repos.delete.mockRejectedValueOnce(
      Object.assign(new Error('Server Error'), { status: 500 }),
    )

    await expect(adapter().deleteRepo('acme', 'my-app')).rejects.toThrow('Server Error')
  })
})

// ─── createBranch ─────────────────────────────────────────────────────────────

describe('createBranch', () => {
  it('skips creation when the branch already exists', async () => {
    octokitMock.repos.getBranch.mockResolvedValueOnce({ data: {} })

    await adapter().createBranch('acme', 'my-app', 'dev', 'main')

    expect(octokitMock.git.createRef).not.toHaveBeenCalled()
  })

  it('creates the branch from the source SHA when source branch is immediately ready', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getBranch
      .mockRejectedValueOnce(notFound) // dev doesn't exist
      .mockResolvedValueOnce({ data: {} }) // waitForBranch: main is ready
    octokitMock.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'abc123' } } })
    octokitMock.git.createRef.mockResolvedValueOnce({})

    await adapter().createBranch('acme', 'my-app', 'dev', 'main')

    expect(octokitMock.git.createRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
      ref: 'refs/heads/dev',
      sha: 'abc123',
    })
  })

  it('waits for the source branch before calling getRef (GitHub template race condition)', async () => {
    // Simulates: new repo from template — main not yet populated when createBranch is first called.
    // repos.getBranch returns 404 twice for main (template not ready), then 200 (ready).
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getBranch
      .mockRejectedValueOnce(notFound) // dev doesn't exist
      .mockRejectedValueOnce(notFound) // waitForBranch attempt 1: main not ready yet
      .mockRejectedValueOnce(notFound) // waitForBranch attempt 2: still not ready
      .mockResolvedValueOnce({ data: {} }) // waitForBranch attempt 3: main is ready
    octokitMock.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'deadbeef' } } })
    octokitMock.git.createRef.mockResolvedValueOnce({})

    await adapter().createBranch('acme', 'my-app', 'dev', 'main', 10_000, 10)

    expect(octokitMock.repos.getBranch).toHaveBeenCalledTimes(4)
    expect(octokitMock.git.getRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
      ref: 'heads/main',
    })
    expect(octokitMock.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'deadbeef' }),
    )
  })

  it('retries getRef when it 404s after repos.getBranch already reports the source branch ready', async () => {
    // Reproduces a real GitHub race: repos.getBranch (Repos API) and git.getRef
    // (Git Data API) are independently eventually-consistent — getBranch can
    // report the branch ready before getRef can resolve the same ref.
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getBranch
      .mockRejectedValueOnce(notFound) // dev doesn't exist
      .mockResolvedValueOnce({ data: {} }) // waitForBranch: main already ready
    octokitMock.git.getRef
      .mockRejectedValueOnce(notFound) // getRef attempt 1: not consistent yet
      .mockRejectedValueOnce(notFound) // getRef attempt 2: still not consistent
      .mockResolvedValueOnce({ data: { object: { sha: 'cafef00d' } } })
    octokitMock.git.createRef.mockResolvedValueOnce({})

    await adapter().createBranch('acme', 'my-app', 'dev', 'main', 10_000, 10)

    expect(octokitMock.git.getRef).toHaveBeenCalledTimes(3)
    expect(octokitMock.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'cafef00d' }),
    )
  })
})

// ─── configureBranchProtection ────────────────────────────────────────────────

describe('configureBranchProtection', () => {
  it('calls updateBranchProtection with the correct params when branch is immediately ready', async () => {
    octokitMock.repos.getBranch = vi.fn().mockResolvedValue({ data: {} })
    octokitMock.repos.updateBranchProtection = vi.fn().mockResolvedValue({})

    await adapter().configureBranchProtection(CONFIG)

    expect(octokitMock.repos.updateBranchProtection).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'my-app',
        branch: 'main',
        allow_force_pushes: false,
        allow_deletions: false,
      }),
    )
  })

  it('retries until main branch exists before setting protection', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getBranch = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ data: {} })
    octokitMock.repos.updateBranchProtection = vi.fn().mockResolvedValueOnce({})

    // Call waitForBranch directly with a 10ms interval to avoid real delays
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private method access for test
    await (adapter() as any).waitForBranch('acme', 'my-app', 'main', 10_000, 10)

    expect(octokitMock.repos.getBranch).toHaveBeenCalledTimes(3)
  })

  it('throws with a helpful message if main never appears within the timeout', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getBranch = vi.fn().mockRejectedValue(notFound)

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter() as any).waitForBranch('acme', 'my-app', 'main', 50, 10),
    ).rejects.toThrow('Branch "main" not found')
  })

  it('retries updateBranchProtection when it returns 404 after branch ref exists', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getBranch = vi.fn().mockResolvedValue({ data: {} })
    octokitMock.repos.updateBranchProtection = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound)
      .mockResolvedValue({}) // dev succeeds on 3rd; staging and main succeed immediately

    await adapter().configureBranchProtection(CONFIG, 10)

    // 2 retries + 1 success for dev, then 1 each for staging and main = 5 total
    expect(octokitMock.repos.updateBranchProtection).toHaveBeenCalledTimes(5)
  })

  it('sends the full branch protection settings (snapshot)', async () => {
    octokitMock.repos.getBranch = vi.fn().mockResolvedValue({ data: {} })
    octokitMock.repos.updateBranchProtection = vi.fn().mockResolvedValue({})

    await adapter().configureBranchProtection(CONFIG)

    const [call] = vi.mocked(octokitMock.repos.updateBranchProtection).mock.calls
    expect(call![0]).toMatchSnapshot()
  })

  it('defaults to DEFAULT_STATUS_CHECKS when no statusChecks argument is passed', async () => {
    octokitMock.repos.getBranch = vi.fn().mockResolvedValue({ data: {} })
    octokitMock.repos.updateBranchProtection = vi.fn().mockResolvedValue({})

    await adapter().configureBranchProtection(CONFIG)

    expect(octokitMock.repos.updateBranchProtection).toHaveBeenCalledWith(
      expect.objectContaining({
        required_status_checks: expect.objectContaining({ contexts: DEFAULT_STATUS_CHECKS }),
      }),
    )
  })

  it('threads a custom statusChecks list through to required_status_checks.contexts', async () => {
    octokitMock.repos.getBranch = vi.fn().mockResolvedValue({ data: {} })
    octokitMock.repos.updateBranchProtection = vi.fn().mockResolvedValue({})
    const customChecks = ['Lint (JS/TS)', 'Test (JS/TS)', 'Terraform Validate & Security']

    await adapter().configureBranchProtection(CONFIG, 3_000, customChecks)

    expect(octokitMock.repos.updateBranchProtection).toHaveBeenCalledWith(
      expect.objectContaining({
        required_status_checks: expect.objectContaining({ contexts: customChecks }),
      }),
    )
  })

  it('warns and skips (without throwing) when the org plan does not support branch protection on a private repo', async () => {
    const planLimited = Object.assign(
      new Error('Upgrade to GitHub Pro or make this repository public to enable this feature.'),
      { status: 403 },
    )
    octokitMock.repos.getBranch = vi.fn().mockResolvedValue({ data: {} })
    octokitMock.repos.updateBranchProtection = vi.fn().mockRejectedValue(planLimited)

    await expect(adapter().configureBranchProtection(CONFIG)).resolves.toBeUndefined()

    // Only the first branch (dev) is attempted — no point retrying staging/main
    // against the same org-level plan limitation.
    expect(octokitMock.repos.updateBranchProtection).toHaveBeenCalledTimes(1)
  })
})

// ─── createEnvironments ──────────────────────────────────────────────────────

describe('createEnvironments', () => {
  it('creates one environment per config entry', async () => {
    octokitMock.repos.createOrUpdateEnvironment = vi.fn().mockResolvedValue({})
    const config = BiffoConfigSchema.parse({ ...CONFIG, environments: ['dev', 'staging', 'prod'] })

    await adapter().createEnvironments(config)

    expect(octokitMock.repos.createOrUpdateEnvironment).toHaveBeenCalledTimes(3)
  })

  it('does not add reviewers for non-prod environments', async () => {
    octokitMock.repos.createOrUpdateEnvironment = vi.fn().mockResolvedValue({})

    await adapter().createEnvironments(CONFIG) // environments: ['dev']

    expect(octokitMock.repos.createOrUpdateEnvironment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
      environment_name: 'dev',
    })
  })

  /**
   * Regression guard (issue #267).
   *
   * `prod` was created with `reviewers: []`. GitHub rejects a required-reviewers
   * protection rule with 422 on a private repo whose plan does not include it,
   * which aborted `biffo init` partway through step 5 — after the repo, OIDC
   * role, state bucket and branch protection existed, but *before* Actions
   * secrets and variables were written, leaving a repo whose CI could not
   * authenticate to AWS. Free plan + private repo is the default solopreneur
   * setup Biffo targets, so this broke the primary user journey.
   *
   * The empty list also gated nothing even when accepted, so it cost the whole
   * failure in exchange for no protection at all.
   *
   * Asserted on `prod` by name rather than "no environment gets reviewers", so
   * that reintroducing it for prod specifically — the shape the bug had — fails
   * here. Real approval gating needs configured reviewer ids and must degrade
   * when the plan lacks support; it does not belong hardcoded in this loop.
   */
  it('creates prod with no protection rules, so a free-plan private repo can init', async () => {
    octokitMock.repos.createOrUpdateEnvironment = vi.fn().mockResolvedValue({})
    const config = BiffoConfigSchema.parse({ ...CONFIG, environments: ['dev', 'staging', 'prod'] })

    await adapter().createEnvironments(config)

    expect(octokitMock.repos.createOrUpdateEnvironment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
      environment_name: 'prod',
    })

    for (const [call] of octokitMock.repos.createOrUpdateEnvironment.mock.calls) {
      expect(call).not.toHaveProperty('reviewers')
    }
  })
})

// ─── setRepoSecret ────────────────────────────────────────────────────────────

describe('setRepoSecret', () => {
  it('delegates to gh secret set with the correct repo and name', async () => {
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''))

    await adapter().setRepoSecret('acme', 'my-app', 'MY_SECRET', 'super-secret-value')

    expect(execSync).toHaveBeenCalledWith(
      'gh secret set MY_SECRET --repo acme/my-app',
      expect.objectContaining({ input: 'super-secret-value' }),
    )
  })
})

// ─── getLatestWorkflowRunId / triggerWorkflow ─────────────────────────────────
//
// On a just-created repo, GitHub Actions can take a few seconds to discover
// and index workflow files pushed via template generation — the workflow_id
// lookup 404s until indexing completes, even though the file itself already
// exists in the repo.

describe('getLatestWorkflowRunId', () => {
  it('returns the latest run id when the workflow is already indexed', async () => {
    octokitMock.actions.listWorkflowRuns = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [{ id: 42 }] } })

    const id = await adapter().getLatestWorkflowRunId('acme', 'my-app', 'deploy-global.yml')

    expect(id).toBe(42)
  })

  it('returns 0 when there are no runs yet', async () => {
    octokitMock.actions.listWorkflowRuns = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [] } })

    const id = await adapter().getLatestWorkflowRunId('acme', 'my-app', 'deploy-global.yml')

    expect(id).toBe(0)
  })

  it('retries on 404 (workflow not yet indexed) until it succeeds', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.actions.listWorkflowRuns = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ data: { workflow_runs: [{ id: 7 }] } })

    const id = await adapter().getLatestWorkflowRunId(
      'acme',
      'my-app',
      'deploy-global.yml',
      10_000,
      10,
    )

    expect(id).toBe(7)
    expect(octokitMock.actions.listWorkflowRuns).toHaveBeenCalledTimes(3)
  })

  it('throws with the original error if the workflow is never indexed within the timeout', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.actions.listWorkflowRuns = vi.fn().mockRejectedValue(notFound)

    await expect(
      adapter().getLatestWorkflowRunId('acme', 'my-app', 'deploy-global.yml', 50, 10),
    ).rejects.toThrow('Not Found')
  })

  it('does not retry non-404 errors', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 })
    octokitMock.actions.listWorkflowRuns = vi.fn().mockRejectedValue(serverError)

    await expect(
      adapter().getLatestWorkflowRunId('acme', 'my-app', 'deploy-global.yml'),
    ).rejects.toThrow('Internal Server Error')
    expect(octokitMock.actions.listWorkflowRuns).toHaveBeenCalledTimes(1)
  })
})

describe('triggerWorkflow', () => {
  it('dispatches the workflow with the given inputs and ref', async () => {
    octokitMock.actions.createWorkflowDispatch = vi.fn().mockResolvedValue({})

    await adapter().triggerWorkflow(
      'acme',
      'my-app',
      'deploy-infra.yml',
      { environment: 'dev' },
      'dev',
    )

    expect(octokitMock.actions.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
      workflow_id: 'deploy-infra.yml',
      ref: 'dev',
      inputs: { environment: 'dev' },
    })
  })

  it('retries on 404 (workflow not yet indexed) until it succeeds', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.actions.createWorkflowDispatch = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({})

    await adapter().triggerWorkflow('acme', 'my-app', 'deploy-global.yml', {}, 'main', 10_000, 10)

    expect(octokitMock.actions.createWorkflowDispatch).toHaveBeenCalledTimes(2)
  })

  it('throws with the original error if the workflow is never indexed within the timeout', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.actions.createWorkflowDispatch = vi.fn().mockRejectedValue(notFound)

    await expect(
      adapter().triggerWorkflow('acme', 'my-app', 'deploy-global.yml', {}, 'main', 50, 10),
    ).rejects.toThrow('Not Found')
  })
})

describe('createPullRequest (ADR-0006 Phase 3b)', () => {
  it('creates a PR and returns its url and number', async () => {
    octokitMock.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/app/pull/12', number: 12 },
    })
    const adapter = new GitHubAdapter('token')
    const result = await adapter.createPullRequest({
      owner: 'acme',
      repo: 'app',
      head: 'biffo/core-upgrade-0.1.0-to-0.2.0',
      base: 'main',
      title: 'Upgrade Biffo core',
      body: 'body',
    })
    expect(octokitMock.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        head: expect.any(String),
        base: 'main',
      }),
    )
    expect(result).toEqual({ url: 'https://github.com/acme/app/pull/12', number: 12 })
  })
})

// ─── commitFiles (issue #269) ────────────────────────────────────────────────

describe('commitFiles', () => {
  const FILES = [
    { path: 'biffo.config.json', content: '{"a":1}\n' },
    { path: 'biffo.core.json', content: '{"version":"0.28.1"}\n' },
  ]

  /** Wire the happy-path Git Data API chain: ref → commit → blobs → tree → commit → ref. */
  function stubCommitChain() {
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'headsha' } } })
    octokitMock.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'treesha' } } })
    octokitMock.git.createBlob
      .mockResolvedValueOnce({ data: { sha: 'blob1' } })
      .mockResolvedValueOnce({ data: { sha: 'blob2' } })
    octokitMock.git.createTree.mockResolvedValue({ data: { sha: 'newtree' } })
    octokitMock.git.createCommit.mockResolvedValue({ data: { sha: 'newcommit' } })
    octokitMock.git.updateRef.mockResolvedValue({ data: {} })
  }

  function contentResponse(text: string) {
    return { data: { type: 'file', content: Buffer.from(text, 'utf8').toString('base64') } }
  }

  it('commits both files as a single commit and moves the branch ref', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getContent.mockRejectedValue(notFound)
    stubCommitChain()

    const sha = await adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init')

    expect(sha).toBe('newcommit')
    expect(octokitMock.git.createBlob).toHaveBeenCalledTimes(2)
    // One tree and one commit for both files — not a commit each.
    expect(octokitMock.git.createTree).toHaveBeenCalledOnce()
    expect(octokitMock.git.createCommit).toHaveBeenCalledOnce()
    expect(octokitMock.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        base_tree: 'treesha',
        tree: [
          { path: 'biffo.config.json', mode: '100644', type: 'blob', sha: 'blob1' },
          { path: 'biffo.core.json', mode: '100644', type: 'blob', sha: 'blob2' },
        ],
      }),
    )
    expect(octokitMock.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'chore: init', tree: 'newtree', parents: ['headsha'] }),
    )
    expect(octokitMock.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/main', sha: 'newcommit' }),
    )
  })

  it('base64-encodes each file body', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getContent.mockRejectedValue(notFound)
    stubCommitChain()

    await adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init')

    const bodies = octokitMock.git.createBlob.mock.calls.map((c) =>
      Buffer.from(c[0].content, 'base64').toString('utf8'),
    )
    expect(bodies).toEqual(['{"a":1}\n', '{"version":"0.28.1"}\n'])
  })

  it('is a no-op when every file already has the desired content (resumed init)', async () => {
    octokitMock.repos.getContent
      .mockResolvedValueOnce(contentResponse(FILES[0]!.content))
      .mockResolvedValueOnce(contentResponse(FILES[1]!.content))

    const sha = await adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init')

    expect(sha).toBeNull()
    expect(octokitMock.git.createCommit).not.toHaveBeenCalled()
    expect(octokitMock.git.updateRef).not.toHaveBeenCalled()
  })

  it('commits when only one of the files is already up to date', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getContent
      .mockResolvedValueOnce(contentResponse(FILES[0]!.content))
      .mockRejectedValueOnce(notFound)
    stubCommitChain()

    const sha = await adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init')

    expect(sha).toBe('newcommit')
  })

  it('commits when an existing file has different content', async () => {
    octokitMock.repos.getContent
      .mockResolvedValueOnce(contentResponse('{"a":2}\n'))
      .mockResolvedValueOnce(contentResponse(FILES[1]!.content))
    stubCommitChain()

    expect(await adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init')).toBe(
      'newcommit',
    )
  })

  it('reports branch protection clearly instead of weakening it when the ref update is rejected', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    octokitMock.repos.getContent.mockRejectedValue(notFound)
    stubCommitChain()
    octokitMock.git.updateRef.mockRejectedValue(
      Object.assign(new Error('protected branch hook declined'), { status: 422 }),
    )

    await expect(
      adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init'),
    ).rejects.toThrow(/Branch protection on "main" rejected the write/)
  })

  it('propagates a non-404 error from the content probe', async () => {
    octokitMock.repos.getContent.mockRejectedValue(
      Object.assign(new Error('Server Error'), { status: 500 }),
    )

    await expect(
      adapter().commitFiles('acme', 'my-app', 'main', FILES, 'chore: init'),
    ).rejects.toThrow('Server Error')
  })
})

// ─── commitFiles: deletions (issue #269) ─────────────────────────────────────

describe('commitFiles deletions', () => {
  function contentResponse(text: string) {
    return { data: { type: 'file', content: Buffer.from(text, 'utf8').toString('base64') } }
  }

  it('deletes a path with a null-sha tree entry and creates no blob for it', async () => {
    octokitMock.repos.getContent.mockResolvedValueOnce(contentResponse('{{PLACEHOLDER}}'))
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'headsha' } } })
    octokitMock.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'treesha' } } })
    octokitMock.git.createTree.mockResolvedValue({ data: { sha: 'newtree' } })
    octokitMock.git.createCommit.mockResolvedValue({ data: { sha: 'newcommit' } })
    octokitMock.git.updateRef.mockResolvedValue({ data: {} })

    const sha = await adapter().commitFiles(
      'acme',
      'my-app',
      'main',
      [{ path: 'biffo.config.json', content: null }],
      'chore: drop placeholder',
    )

    expect(sha).toBe('newcommit')
    expect(octokitMock.git.createBlob).not.toHaveBeenCalled()
    expect(octokitMock.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: [{ path: 'biffo.config.json', mode: '100644', type: 'blob', sha: null }],
      }),
    )
  })

  it('is a no-op when the path to delete is already absent (resumed init)', async () => {
    octokitMock.repos.getContent.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )

    const sha = await adapter().commitFiles(
      'acme',
      'my-app',
      'main',
      [{ path: 'biffo.config.json', content: null }],
      'chore: drop placeholder',
    )

    expect(sha).toBeNull()
    expect(octokitMock.git.createCommit).not.toHaveBeenCalled()
  })

  it('mixes an add and a delete into one commit', async () => {
    octokitMock.repos.getContent
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 })) // core file absent
      .mockResolvedValueOnce(contentResponse('placeholder')) // config file present
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'headsha' } } })
    octokitMock.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'treesha' } } })
    octokitMock.git.createBlob.mockResolvedValue({ data: { sha: 'blob1' } })
    octokitMock.git.createTree.mockResolvedValue({ data: { sha: 'newtree' } })
    octokitMock.git.createCommit.mockResolvedValue({ data: { sha: 'newcommit' } })
    octokitMock.git.updateRef.mockResolvedValue({ data: {} })

    await adapter().commitFiles(
      'acme',
      'my-app',
      'main',
      [
        { path: 'biffo.core.json', content: '{"version":"0.28.2"}\n' },
        { path: 'biffo.config.json', content: null },
      ],
      'chore: instance identity',
    )

    expect(octokitMock.git.createCommit).toHaveBeenCalledOnce()
    expect(octokitMock.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: [
          { path: 'biffo.core.json', mode: '100644', type: 'blob', sha: 'blob1' },
          { path: 'biffo.config.json', mode: '100644', type: 'blob', sha: null },
        ],
      }),
    )
  })
})

// ─── getBranchSha & fastForwardBranch (issue #329) ───────────────────────────

describe('getBranchSha', () => {
  it("returns the branch head's commit SHA", async () => {
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'headsha' } } })

    const sha = await adapter().getBranchSha('acme', 'my-app', 'dev')

    expect(sha).toBe('headsha')
    expect(octokitMock.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'my-app', ref: 'heads/dev' }),
    )
  })
})

describe('fastForwardBranch', () => {
  it('moves the branch ref onto the target SHA without forcing (fast-forward only)', async () => {
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'oldsha' } } })
    octokitMock.git.updateRef.mockResolvedValue({ data: {} })

    await adapter().fastForwardBranch('acme', 'my-app', 'dev', 'sharedsha')

    expect(octokitMock.git.updateRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
      ref: 'heads/dev',
      sha: 'sharedsha',
      force: false,
    })
  })

  it('is a no-op when the branch is already at the target SHA (resumed init)', async () => {
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'sharedsha' } } })

    await adapter().fastForwardBranch('acme', 'my-app', 'staging', 'sharedsha')

    expect(octokitMock.git.updateRef).not.toHaveBeenCalled()
  })

  it('propagates a non-fast-forward rejection instead of clobbering history', async () => {
    octokitMock.git.getRef.mockResolvedValue({ data: { object: { sha: 'divergedsha' } } })
    octokitMock.git.updateRef.mockRejectedValue(
      Object.assign(new Error('Update is not a fast forward'), { status: 422 }),
    )

    await expect(
      adapter().fastForwardBranch('acme', 'my-app', 'staging', 'sharedsha'),
    ).rejects.toThrow('Update is not a fast forward')
  })
})

// ─── getEnvVariable ───────────────────────────────────────────────────────────

describe('getEnvVariable', () => {
  it('returns the value of an environment-scoped variable', async () => {
    octokitMock.request.mockResolvedValueOnce({
      data: { name: 'CORE_COGNITO_USER_POOL_ID', value: 'eu-west-1_LIVE' },
    })

    const value = await adapter().getEnvVariable('acme', 'crm', 'dev', 'CORE_COGNITO_USER_POOL_ID')

    expect(value).toBe('eu-west-1_LIVE')
    expect(octokitMock.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/environments/{environment_name}/variables/{variable_name}',
      {
        owner: 'acme',
        repo: 'crm',
        environment_name: 'dev',
        variable_name: 'CORE_COGNITO_USER_POOL_ID',
      },
    )
  })

  it('returns null when the variable is not set (404)', async () => {
    octokitMock.request.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )

    const value = await adapter().getEnvVariable('acme', 'crm', 'dev', 'CORE_COGNITO_USER_POOL_ID')

    expect(value).toBeNull()
  })

  it('rethrows non-404 errors instead of masking them as unset', async () => {
    octokitMock.request.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))

    await expect(
      adapter().getEnvVariable('acme', 'crm', 'dev', 'CORE_COGNITO_USER_POOL_ID'),
    ).rejects.toThrow('boom')
  })
})
