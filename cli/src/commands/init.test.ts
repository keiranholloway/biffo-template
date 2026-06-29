import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import type { InitSession } from '../lib/session.js'
import { runInit } from './init.js'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../lib/session.js', () => ({
  markStepComplete: vi.fn(),
  deleteSession: vi.fn(),
  saveSession: vi.fn(),
  saveProjectConfig: vi.fn(),
  findLatestSession: vi.fn(),
  loadSession: vi.fn(),
}))

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

const { markStepComplete, deleteSession } = await import('../lib/session.js')

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: 'Test app', domain: 'example.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev', 'staging', 'prod'],
  admin: { email: 'admin@example.com', username: 'admin' },
})

function makeSession(overrides: Partial<InitSession> = {}): InitSession {
  return {
    version: 1,
    config: CONFIG,
    awsAccountId: '123456789012',
    awsRegion: 'eu-west-1',
    completedSteps: [],
    outputs: {},
    ...overrides,
  }
}

function makeGithubMock() {
  return {
    createRepoFromTemplate: vi.fn().mockResolvedValue('https://github.com/acme/my-app.git'),
    configureBranchProtection: vi.fn().mockResolvedValue(undefined),
    createEnvironments: vi.fn().mockResolvedValue(undefined),
    setRepoSecret: vi.fn().mockResolvedValue(undefined),
  }
}

function makeAwsMock() {
  return {
    verifyCredentials: vi.fn().mockResolvedValue(undefined),
    setupOidcTrust: vi
      .fn()
      .mockResolvedValue('arn:aws:iam::123456789012:role/biffo-github-actions-my-app'),
    bootstrapTerraformBackend: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('runs all 5 steps in order for a fresh session', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const session = makeSession()

    await runInit(github as never, aws as never, CONFIG, session)

    expect(aws.verifyCredentials).toHaveBeenCalledOnce()
    expect(github.createRepoFromTemplate).toHaveBeenCalledOnce()
    expect(aws.setupOidcTrust).toHaveBeenCalledOnce()
    expect(aws.bootstrapTerraformBackend).toHaveBeenCalledOnce()
    expect(github.configureBranchProtection).toHaveBeenCalledOnce()
    expect(github.createEnvironments).toHaveBeenCalledOnce()
  })

  it('marks each step complete in order', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()

    await runInit(github as never, aws as never, CONFIG, makeSession())

    const calls = vi.mocked(markStepComplete).mock.calls.map((c) => c[1])
    expect(calls).toEqual([
      'verify_credentials',
      'create_repo',
      'oidc_trust',
      'terraform_backend',
      'github_config',
    ])
  })

  it('propagates cloneUrl from createRepoFromTemplate into session outputs', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const session = makeSession()

    await runInit(github as never, aws as never, CONFIG, session)

    expect(session.outputs.cloneUrl).toBe('https://github.com/acme/my-app.git')
  })

  it('propagates oidcRoleArn from setupOidcTrust into setRepoSecret', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()

    await runInit(github as never, aws as never, CONFIG, makeSession())

    expect(github.setRepoSecret).toHaveBeenCalledWith(
      'acme',
      'my-app',
      'BIFFO_OIDC_ROLE_ARN',
      'arn:aws:iam::123456789012:role/biffo-github-actions-my-app',
    )
  })

  it('deletes the session file on successful completion', async () => {
    await runInit(makeGithubMock() as never, makeAwsMock() as never, CONFIG, makeSession())
    expect(deleteSession).toHaveBeenCalledWith('my-app')
  })
})

// ─── Step resumption ─────────────────────────────────────────────────────────

describe('step resumption', () => {
  it('skips verify_credentials when already complete', async () => {
    const aws = makeAwsMock()
    const session = makeSession({ completedSteps: ['verify_credentials'] })

    await runInit(makeGithubMock() as never, aws as never, CONFIG, session)

    expect(aws.verifyCredentials).not.toHaveBeenCalled()
  })

  it('skips create_repo when already complete', async () => {
    const github = makeGithubMock()
    const session = makeSession({ completedSteps: ['verify_credentials', 'create_repo'] })

    await runInit(github as never, makeAwsMock() as never, CONFIG, session)

    expect(github.createRepoFromTemplate).not.toHaveBeenCalled()
  })

  it('skips oidc_trust when already complete and restores oidcRoleArn from session', async () => {
    const aws = makeAwsMock()
    const savedArn = 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app'
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust'],
      outputs: { oidcRoleArn: savedArn },
    })

    await runInit(makeGithubMock() as never, aws as never, CONFIG, session)

    expect(aws.setupOidcTrust).not.toHaveBeenCalled()
  })

  it('passes saved oidcRoleArn to setRepoSecret when oidc_trust was skipped', async () => {
    const github = makeGithubMock()
    const savedArn = 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app'
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust'],
      outputs: { oidcRoleArn: savedArn },
    })

    await runInit(github as never, makeAwsMock() as never, CONFIG, session)

    expect(github.setRepoSecret).toHaveBeenCalledWith(
      'acme',
      'my-app',
      'BIFFO_OIDC_ROLE_ARN',
      savedArn,
    )
  })

  it('skips terraform_backend when already complete', async () => {
    const aws = makeAwsMock()
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust', 'terraform_backend'],
    })

    await runInit(makeGithubMock() as never, aws as never, CONFIG, session)

    expect(aws.bootstrapTerraformBackend).not.toHaveBeenCalled()
  })

  it('skips github_config when already complete', async () => {
    const github = makeGithubMock()
    const session = makeSession({
      completedSteps: [
        'verify_credentials',
        'create_repo',
        'oidc_trust',
        'terraform_backend',
        'github_config',
      ],
    })

    await runInit(github as never, makeAwsMock() as never, CONFIG, session)

    expect(github.configureBranchProtection).not.toHaveBeenCalled()
    expect(github.createEnvironments).not.toHaveBeenCalled()
    expect(github.setRepoSecret).not.toHaveBeenCalled()
  })

  it('does not call deleteSession when all steps are already complete', async () => {
    // All steps skipped → deleteSession is still called (init completed)
    const session = makeSession({
      completedSteps: [
        'verify_credentials',
        'create_repo',
        'oidc_trust',
        'terraform_backend',
        'github_config',
      ],
    })

    await runInit(makeGithubMock() as never, makeAwsMock() as never, CONFIG, session)

    expect(deleteSession).toHaveBeenCalledWith('my-app')
  })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('error handling', () => {
  it('does not delete session when verifyCredentials fails', async () => {
    const aws = makeAwsMock()
    aws.verifyCredentials.mockRejectedValue(new Error('AWS creds invalid'))

    await expect(
      runInit(makeGithubMock() as never, aws as never, CONFIG, makeSession()),
    ).rejects.toThrow('AWS creds invalid')

    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('does not delete session when createRepoFromTemplate fails', async () => {
    const github = makeGithubMock()
    github.createRepoFromTemplate.mockRejectedValue(new Error('GitHub error'))

    await expect(
      runInit(github as never, makeAwsMock() as never, CONFIG, makeSession()),
    ).rejects.toThrow('GitHub error')

    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('does not delete session when setupOidcTrust fails', async () => {
    const aws = makeAwsMock()
    aws.setupOidcTrust.mockRejectedValue(new Error('IAM error'))

    await expect(
      runInit(makeGithubMock() as never, aws as never, CONFIG, makeSession()),
    ).rejects.toThrow('IAM error')

    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('does not call downstream steps when an earlier step fails', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    aws.verifyCredentials.mockRejectedValue(new Error('fail'))

    await expect(runInit(github as never, aws as never, CONFIG, makeSession())).rejects.toThrow()

    expect(github.createRepoFromTemplate).not.toHaveBeenCalled()
    expect(aws.setupOidcTrust).not.toHaveBeenCalled()
    expect(aws.bootstrapTerraformBackend).not.toHaveBeenCalled()
    expect(github.configureBranchProtection).not.toHaveBeenCalled()
  })

  it('does not set OIDC secret when oidcRoleArn is absent', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    // setupOidcTrust unexpectedly returns empty string
    aws.setupOidcTrust.mockResolvedValue('')

    await runInit(github as never, aws as never, CONFIG, makeSession())

    expect(github.setRepoSecret).not.toHaveBeenCalled()
  })
})
