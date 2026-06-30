import { execSync } from 'node:child_process'
import { Octokit } from '@octokit/rest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../../../config/schema.js'
import { GitHubAdapter } from './index.js'

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
      delete: vi.fn(),
      getBranch: vi.fn(),
      updateBranchProtection: vi.fn(),
      createOrUpdateEnvironment: vi.fn(),
    },
    git: {
      getRef: vi.fn(),
      createRef: vi.fn(),
    },
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
