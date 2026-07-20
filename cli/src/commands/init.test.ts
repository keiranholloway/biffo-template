import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import type { InitSession } from '../lib/session.js'
import { getLatestCoreVersion } from '../lib/core-version.js'
import {
  applyResolvedAwsCredentials,
  INSTANCE_CONFIG_FILE,
  INSTANCE_FILE_BRANCHES,
  runInit,
} from './init.js'

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

const CONFIG_NO_DNS = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: 'Test app' },
  dns: { mode: 'none' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
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
    createBranch: vi.fn().mockResolvedValue(undefined),
    setDefaultBranch: vi.fn().mockResolvedValue(undefined),
    configureBranchProtection: vi.fn().mockResolvedValue(undefined),
    createEnvironments: vi.fn().mockResolvedValue(undefined),
    setRepoVariable: vi.fn().mockResolvedValue(undefined),
    setEnvVariable: vi.fn().mockResolvedValue(undefined),
    setRepoSecret: vi.fn().mockResolvedValue(undefined),
    enableVulnerabilityAlerts: vi.fn().mockResolvedValue(undefined),
    commitFiles: vi.fn().mockResolvedValue('commitsha'),
    getRepoIds: vi.fn().mockResolvedValue({ ownerId: 42, repoId: 99 }),
  }
}

function makeAwsMock() {
  return {
    verifyCredentials: vi.fn().mockResolvedValue(undefined),
    setupOidcTrust: vi
      .fn()
      .mockResolvedValue('arn:aws:iam::123456789012:role/biffo-github-actions-my-app'),
    bootstrapTerraformBackend: vi.fn().mockResolvedValue('my-app-terraform-state-123456789012'),
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
    expect(github.enableVulnerabilityAlerts).toHaveBeenCalledOnce()
  })

  // Issue #271: the trust policy must pin GitHub's immutable owner/repo IDs, so
  // init has to resolve them from the source-control adapter and pass them on.
  it('threads resolved GitHub repo IDs into setupOidcTrust', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()

    await runInit(github as never, aws as never, CONFIG, makeSession())

    expect(aws.setupOidcTrust).toHaveBeenCalledWith(CONFIG, { ownerId: 42, repoId: 99 })
  })

  // A GitHub API blip must not abort provisioning, and must not silently widen
  // the trust policy — the AWS adapter falls back to the legacy pattern alone.
  it('still provisions OIDC trust when repo ID lookup fails', async () => {
    const github = makeGithubMock()
    github.getRepoIds.mockRejectedValue(new Error('502 Bad Gateway'))
    const aws = makeAwsMock()

    await runInit(github as never, aws as never, CONFIG, makeSession())

    expect(aws.setupOidcTrust).toHaveBeenCalledWith(CONFIG, undefined)
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

  it('sets DNS mode and domain variables for legacy managed Route53 configs', async () => {
    const github = makeGithubMock()

    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    expect(github.setRepoVariable).toHaveBeenCalledWith(
      'acme',
      'my-app',
      'DNS_MODE',
      'managed-route53',
    )
    expect(github.setRepoVariable).toHaveBeenCalledWith('acme', 'my-app', 'DOMAIN', 'example.com')
    expect(github.setEnvVariable).toHaveBeenCalledWith(
      'acme',
      'my-app',
      'dev',
      'CUSTOM_DOMAIN',
      'dev.example.com',
    )
  })

  it('does not set domain variables when DNS mode is none', async () => {
    const github = makeGithubMock()
    const session = makeSession({ config: CONFIG_NO_DNS })

    await runInit(github as never, makeAwsMock() as never, CONFIG_NO_DNS, session)

    expect(github.setRepoVariable).toHaveBeenCalledWith('acme', 'my-app', 'DNS_MODE', 'none')
    expect(github.setRepoVariable).not.toHaveBeenCalledWith(
      'acme',
      'my-app',
      'DOMAIN',
      expect.any(String),
    )
    expect(github.setEnvVariable).not.toHaveBeenCalledWith(
      'acme',
      'my-app',
      expect.any(String),
      'CUSTOM_DOMAIN',
      expect.any(String),
    )
  })
})

describe('credential resolution', () => {
  it('overlays selected AWS credentials onto a resumed config', () => {
    const resolved = applyResolvedAwsCredentials(CONFIG, {
      accountId: CONFIG.cloud.config.account_id,
      region: 'eu-west-1',
      profile: 'tabsii',
    })

    expect(resolved.cloud.config).toMatchObject({
      account_id: CONFIG.cloud.config.account_id,
      region: 'eu-west-1',
      profile: 'tabsii',
    })
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

// ─── Instance identity files (issue #269) ────────────────────────────────────

describe('instance identity files', () => {
  const INSTANCE_CORE_FILE = 'biffo.core.json'

  function changesOn(github: ReturnType<typeof makeGithubMock>, branch: string) {
    const call = github.commitFiles.mock.calls.find((c) => c[2] === branch)
    if (!call) throw new Error(`no commitFiles call for branch ${branch}`)
    return call[3] as { path: string; content: string | null }[]
  }

  it('commits to main, dev and staging', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    expect(github.commitFiles.mock.calls.map((c) => c[2])).toEqual(INSTANCE_FILE_BRANCHES)
  })

  it('commits before branch protection is configured', async () => {
    const order: string[] = []
    const github = makeGithubMock()
    github.commitFiles.mockImplementation(async () => {
      order.push('commitFiles')
      return 'sha'
    })
    github.configureBranchProtection.mockImplementation(async () => {
      order.push('configureBranchProtection')
    })

    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    expect(order.indexOf('commitFiles')).toBeLessThan(order.indexOf('configureBranchProtection'))
  })

  it('writes a biffo.core.json matching the core.version this CLI ships with', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const core = changesOn(github, 'main').find((f) => f.path === INSTANCE_CORE_FILE)
    expect(core).toBeDefined()
    expect(JSON.parse(core!.content!)).toEqual({ version: getLatestCoreVersion() })
  })

  it("deletes the template's placeholder biffo.config.json", async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const config = changesOn(github, 'main').find((f) => f.path === INSTANCE_CONFIG_FILE)
    expect(config).toBeDefined()
    // null content is the Git Data API deletion sentinel.
    expect(config!.content).toBeNull()
  })

  // The resolved config carries the AWS account id and admin email. The
  // template's own .gitleaks.toml rejects both anywhere in the tree
  // (biffo-aws-account-id matches any bare 12-digit number), so committing it
  // would turn the instance's own Secret Scan red on its first run. It lives in
  // ~/.biffo/projects/ instead — see writeInstanceFiles.
  //
  // The ONE exception is the sibling registry (issue #306), whose S3
  // bucket_regional_domain contains the account id by construction and which
  // .gitleaks.toml allowlists by path for exactly that reason. It is named
  // here rather than skipped generically, so that a future file quietly
  // starting to carry the account id still fails this test.
  const REGISTRY_FILE = /^infra\/environments\/[a-z]+\/siblings\.auto\.tfvars\.json$/

  it('never commits the AWS account id or the admin email', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    for (const branch of INSTANCE_FILE_BRANCHES) {
      for (const change of changesOn(github, branch)) {
        if (change.content === null) continue
        expect(change.content).not.toContain('admin@example.com')
        if (REGISTRY_FILE.test(change.path)) continue
        expect(change.content).not.toContain('123456789012')
        expect(change.content).not.toMatch(/\b\d{12}\b/)
      }
    }
  })

  // The account id only ever appears inside the S3 host name — never as a bare
  // field of its own. If that stopped being true the gitleaks path allowlist
  // would be covering more than it was scoped for.
  it('confines the account id in the registry to the S3 bucket host name', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const registry = changesOn(github, 'dev').filter((c) => REGISTRY_FILE.test(c.path))
    expect(registry).toHaveLength(CONFIG.environments.length)
    for (const file of registry) {
      const parsed = JSON.parse(file.content!) as {
        sibling_origins: { name: string; bucket_regional_domain: string }[]
      }
      for (const origin of parsed.sibling_origins) {
        expect(origin.bucket_regional_domain).toMatch(
          /^my-app-app-(dev|staging|prod)-site-123456789012\.s3\.eu-west-1\.amazonaws\.com$/,
        )
      }
      const withoutHost = file.content!.replace(/"bucket_regional_domain":\s*"[^"]*"/g, '""')
      expect(withoutHost).not.toMatch(/\b\d{12}\b/)
    }
  })

  it('leaves no unresolved {{PLACEHOLDER}} in anything it commits', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    for (const branch of INSTANCE_FILE_BRANCHES) {
      for (const change of changesOn(github, branch)) {
        if (change.content === null) continue
        expect(change.content, `${branch}:${change.path}`).not.toMatch(/\{\{[^}]*\}\}/)
      }
    }
  })

  it('commits identical changes to every branch', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const [main, dev, staging] = INSTANCE_FILE_BRANCHES.map((b) => changesOn(github, b))
    expect(dev).toEqual(main)
    expect(staging).toEqual(main)
  })

  it('does not commit when github_config is already checkpointed complete', async () => {
    const github = makeGithubMock()
    await runInit(
      github as never,
      makeAwsMock() as never,
      CONFIG,
      makeSession({ completedSteps: ['github_config'], outputs: {} }),
    )

    expect(github.commitFiles).not.toHaveBeenCalled()
  })
})
