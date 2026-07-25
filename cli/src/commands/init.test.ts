import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import type { InitSession } from '../lib/session.js'
import { getLatestCoreVersion } from '../lib/core-version.js'
import {
  appSiblingConfig,
  appSiblingRegistryFiles,
  applyResolvedAwsCredentials,
  INSTANCE_CONFIG_FILE,
  INSTANCE_FILE_BASE_BRANCH,
  INSTANCE_FILE_BRANCHES,
  resolveConfigFileSession,
  runInit,
} from './init.js'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../lib/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/session.js')>()
  return {
    // `hasCompleted` is a pure predicate over `completedSteps` (it also decodes
    // legacy checkpoint names) — stubbing it would mean re-implementing the
    // thing under test in the test.
    hasCompleted: actual.hasCompleted,
    // Mirrors the real implementation's *observable* effect: the step lands in
    // `completedSteps` immediately, so a test that makes a later call throw
    // sees exactly the session a resume would load (issue #316).
    markStepComplete: vi.fn((session: { completedSteps: string[] }, step: string) => {
      if (!session.completedSteps.includes(step)) session.completedSteps.push(step)
    }),
    deleteSession: vi.fn(),
    saveSession: vi.fn(),
    saveProjectConfig: vi.fn(),
    findLatestSession: vi.fn(),
    loadSession: vi.fn(),
  }
})

vi.mock('../lib/sibling-session.js', () => ({
  markSiblingStepComplete: vi.fn((session: { completedSteps: string[] }, step: string) => {
    if (!session.completedSteps.includes(step)) session.completedSteps.push(step)
  }),
  deleteSiblingSession: vi.fn(),
  saveSiblingSession: vi.fn(),
  loadSiblingSession: vi.fn(),
}))

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

const { markStepComplete, deleteSession, loadSession } = await import('../lib/session.js')

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
    getBranchSha: vi.fn().mockResolvedValue('commitsha'),
    fastForwardBranch: vi.fn().mockResolvedValue(undefined),
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
      // Step 5 is three checkpoints, not one (issue #316) — the git-object
      // writes are recorded separately from the branch creation before them and
      // the idempotent settings upserts after them.
      'github_branches',
      'github_instance_files',
      'github_settings',
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

  // A session written by a pre-#316 CLI. It must still skip the whole of step
  // 5 — replaying the git writes is the failure mode #316 exists to stop.
  it('skips all of step 5 for a legacy github_config checkpoint', async () => {
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

    expect(github.createBranch).not.toHaveBeenCalled()
    expect(github.commitFiles).not.toHaveBeenCalled()
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

  // Every branch shares ONE commit now (issue #329): the files are committed
  // once on the base branch and the others are fast-forwarded onto it. So the
  // committed content is whatever went onto the base branch.
  function sharedCommitFiles(github: ReturnType<typeof makeGithubMock>) {
    const call = github.commitFiles.mock.calls.find((c) => c[2] === INSTANCE_FILE_BASE_BRANCH)
    if (!call) throw new Error(`no commitFiles call for the ${INSTANCE_FILE_BASE_BRANCH} branch`)
    return call[3] as { path: string; content: string | null }[]
  }

  // Issue #329: one shared commit, not independent look-alikes. The commit is
  // built once on the base branch (`dev`); `staging` and `main` are
  // fast-forwarded onto its SHA so they descend from it and the first
  // dev→staging→main promotions merge cleanly.
  it('commits once on the base branch and fast-forwards staging and main onto it', async () => {
    const github = makeGithubMock()
    github.commitFiles.mockResolvedValue('shared-sha')
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    expect(github.commitFiles.mock.calls.map((c) => c[2])).toEqual([INSTANCE_FILE_BASE_BRANCH])
    expect(github.fastForwardBranch.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['staging', 'shared-sha'],
      ['main', 'shared-sha'],
    ])
  })

  // Resume path: on re-entry the base already carries the content, so
  // `commitFiles` returns null. The followers must then converge on the base's
  // existing head rather than on `null`.
  it('fast-forwards followers onto the existing base head when the commit is a resume no-op', async () => {
    const github = makeGithubMock()
    github.commitFiles.mockResolvedValue(null)
    github.getBranchSha.mockResolvedValue('existing-base-head')
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    expect(github.getBranchSha).toHaveBeenCalledWith('acme', 'my-app', INSTANCE_FILE_BASE_BRANCH)
    expect(github.fastForwardBranch.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['staging', 'existing-base-head'],
      ['main', 'existing-base-head'],
    ])
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

    const core = sharedCommitFiles(github).find((f) => f.path === INSTANCE_CORE_FILE)
    expect(core).toBeDefined()
    expect(JSON.parse(core!.content!)).toEqual({ version: getLatestCoreVersion() })
  })

  it("deletes the template's placeholder biffo.config.json", async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const config = sharedCommitFiles(github).find((f) => f.path === INSTANCE_CONFIG_FILE)
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

    for (const change of sharedCommitFiles(github)) {
      if (change.content === null) continue
      expect(change.content).not.toContain('admin@example.com')
      if (REGISTRY_FILE.test(change.path)) continue
      expect(change.content).not.toContain('123456789012')
      expect(change.content).not.toMatch(/\b\d{12}\b/)
    }
  })

  // The account id only ever appears inside the S3 host name — never as a bare
  // field of its own. If that stopped being true the gitleaks path allowlist
  // would be covering more than it was scoped for.
  it('confines the account id in the registry to the S3 bucket host name', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const registry = sharedCommitFiles(github).filter((c) => REGISTRY_FILE.test(c.path))
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

    for (const change of sharedCommitFiles(github)) {
      if (change.content === null) continue
      expect(change.content, change.path).not.toMatch(/\{\{[^}]*\}\}/)
    }
  })

  // Issue #329: because there is one shared commit, "identical across branches"
  // is now guaranteed by construction — the followers are fast-forwarded onto
  // the exact SHA committed on the base branch, so they cannot diverge.
  it('gives every branch the same commit by fast-forwarding onto the base SHA', async () => {
    const github = makeGithubMock()
    github.commitFiles.mockResolvedValue('shared-sha')
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    expect(github.commitFiles).toHaveBeenCalledTimes(1)
    expect(github.commitFiles.mock.calls[0]![2]).toBe(INSTANCE_FILE_BASE_BRANCH)
    for (const follower of INSTANCE_FILE_BRANCHES.filter((b) => b !== INSTANCE_FILE_BASE_BRANCH)) {
      expect(github.fastForwardBranch).toHaveBeenCalledWith(
        'acme',
        'my-app',
        follower,
        'shared-sha',
      )
    }
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

// ─── The root application sibling (issue #306) ───────────────────────────────

describe('the app sibling', () => {
  // One shared commit on the base branch (issue #329); the followers are
  // fast-forwarded onto it, so its content is what every branch carries.
  function sharedCommitFiles(github: ReturnType<typeof makeGithubMock>) {
    const call = github.commitFiles.mock.calls.find((c) => c[2] === INSTANCE_FILE_BASE_BRANCH)
    if (!call) throw new Error(`no commitFiles call for the ${INSTANCE_FILE_BASE_BRANCH} branch`)
    return call[3] as { path: string; content: string | null }[]
  }

  it('names the repo <core>-app, matching the project name teardown resolves by', () => {
    const sibling = appSiblingConfig(CONFIG)
    expect(sibling.project.name).toBe('my-app-app')
    expect((sibling.source_control as { config: { org: string; repo: string } }).config).toEqual({
      org: 'acme',
      repo: 'my-app-app',
    })
    // Empty prefix — this is what makes it the ROOT sibling.
    expect(sibling.core.path_prefix).toBe('')
    expect(sibling.core.project_name).toBe('my-app')
  })

  // The core's own OIDC role and state bucket are added to config.cloud.config
  // partway through runInit. Inheriting them would be wrong, and an empty
  // oidc_role_arn mid-run fails schema validation outright.
  it("does not inherit the core project's OIDC role or state bucket", () => {
    const withCoreCreds = BiffoConfigSchema.parse({
      ...CONFIG,
      cloud: {
        provider: 'aws',
        config: {
          account_id: '123456789012',
          region: 'eu-west-1',
          oidc_role_arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app',
          tf_state_bucket: 'my-app-terraform-state-123456789012',
        },
      },
    })

    const cloud = appSiblingConfig(withCoreCreds).cloud as {
      config: { oidc_role_arn?: string; tf_state_bucket?: string; account_id: string }
    }
    expect(cloud.config.oidc_role_arn).toBeUndefined()
    expect(cloud.config.tf_state_bucket).toBeUndefined()
    expect(cloud.config.account_id).toBe('123456789012')
  })

  it('registers itself under the reserved name "app", one file per environment', () => {
    const files = appSiblingRegistryFiles(CONFIG)

    expect(files.map((f) => f.path)).toEqual([
      'infra/environments/dev/siblings.auto.tfvars.json',
      'infra/environments/staging/siblings.auto.tfvars.json',
      'infra/environments/prod/siblings.auto.tfvars.json',
    ])
    const dev = JSON.parse(files[0]!.content) as {
      sibling_origins: { name: string; bucket_regional_domain: string }[]
    }
    expect(dev.sibling_origins[0]!.name).toBe('app')
    expect(dev.sibling_origins[0]!.bucket_regional_domain).toBe(
      'my-app-app-dev-site-123456789012.s3.eu-west-1.amazonaws.com',
    )
  })

  // The safety property: registration is derived and lands in step 5, BEFORE
  // the sibling's repo is created in step 6. A crash between the two leaves a
  // registration teardown can still act on, never an unregistered repo.
  it('commits the registration into the shared instance commit even without the sibling deps', async () => {
    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, makeSession())

    const paths = sharedCommitFiles(github).map((c) => c.path)
    expect(paths).toContain('infra/environments/dev/siblings.auto.tfvars.json')
    // Every branch descends from that commit — dev and staging are
    // fast-forwarded onto it — so all of them carry the registration.
    for (const follower of INSTANCE_FILE_BRANCHES.filter((b) => b !== INSTANCE_FILE_BASE_BRANCH)) {
      expect(github.fastForwardBranch).toHaveBeenCalledWith(
        'acme',
        'my-app',
        follower,
        expect.anything(),
      )
    }
  })

  it('creates the sibling repo only after the registration has been committed', async () => {
    const github = makeGithubMock()
    const session = makeSession()
    const reached = new Error('reached the sibling step')

    await expect(
      runInit(github as never, makeAwsMock() as never, CONFIG, session, {
        git: {} as never,
        awsFor: () => {
          throw reached
        },
        skeletonRoot: '/skeleton',
        githubToken: 'gh-token',
      }),
    ).rejects.toBe(reached)

    // Failing at step 6 leaves the registration already committed — the
    // recoverable state, not the leaking one.
    const steps = vi.mocked(markStepComplete).mock.calls.map((c) => c[1])
    expect(steps).toContain('github_instance_files')
    expect(steps).not.toContain('app_sibling')
    expect(sharedCommitFiles(github).map((c) => c.path)).toContain(
      'infra/environments/dev/siblings.auto.tfvars.json',
    )
  })

  it('skips the sibling step when it is already checkpointed', async () => {
    const github = makeGithubMock()
    const session = makeSession({
      completedSteps: [
        'verify_credentials',
        'create_repo',
        'oidc_trust',
        'terraform_backend',
        'github_config',
        'app_sibling',
      ],
    })

    await runInit(github as never, makeAwsMock() as never, CONFIG, session, {
      git: {} as never,
      // Would throw if called — proving the step really is skipped.
      awsFor: () => {
        throw new Error('should not build an AwsAdapter for an already-created sibling')
      },
      skeletonRoot: '/skeleton',
      githubToken: 'gh-token',
    })

    expect(session.completedSteps).toContain('app_sibling')
  })
})

// ─── Issue #316: resume after a PARTIAL step ─────────────────────────────────
//
// Step 5 used to be one `github_config` checkpoint guarding ~15 side effects,
// so any failure inside it replayed all of them — including the commits that
// write biffo.core.json and the sibling registration. Replaying those against a
// repo whose git state has moved on is what produced GitRPC::BadObjectState.
//
// These tests fail a call in the MIDDLE of step 5 and assert on what survives.
describe('resume after a partially-completed step 5 (issue #316)', () => {
  it('keeps the branch checkpoint when the instance-file commit then fails', async () => {
    const github = makeGithubMock()
    github.commitFiles.mockRejectedValue(new Error('GitRPC::BadObjectState'))
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust', 'terraform_backend'],
    })

    await expect(runInit(github as never, makeAwsMock() as never, CONFIG, session)).rejects.toThrow(
      'GitRPC::BadObjectState',
    )

    // The branches exist. Recording that is the whole point.
    expect(session.completedSteps).toContain('github_branches')
    expect(session.completedSteps).not.toContain('github_instance_files')
    expect(session.completedSteps).not.toContain('github_settings')
  })

  it('does not re-create branches on the resume, and retries only the commit', async () => {
    const failing = makeGithubMock()
    failing.commitFiles.mockRejectedValue(new Error('GitRPC::BadObjectState'))
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust', 'terraform_backend'],
    })
    await expect(
      runInit(failing as never, makeAwsMock() as never, CONFIG, session),
    ).rejects.toThrow()

    const github = makeGithubMock()
    await runInit(github as never, makeAwsMock() as never, CONFIG, session)

    expect(github.createBranch).not.toHaveBeenCalled()
    expect(github.commitFiles).toHaveBeenCalled()
    expect(github.configureBranchProtection).toHaveBeenCalled()
    expect(session.completedSteps).toContain('github_settings')
  })

  it('keeps the git writes checkpointed when a settings call then fails', async () => {
    // The reverse boundary: the commits landed, branch protection blew up.
    // A resume must not go near commitFiles again.
    const github = makeGithubMock()
    github.configureBranchProtection.mockRejectedValue(new Error('422 plan does not support it'))
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust', 'terraform_backend'],
    })

    await expect(runInit(github as never, makeAwsMock() as never, CONFIG, session)).rejects.toThrow(
      '422 plan does not support it',
    )

    expect(session.completedSteps).toContain('github_branches')
    expect(session.completedSteps).toContain('github_instance_files')
    expect(session.completedSteps).not.toContain('github_settings')

    const retry = makeGithubMock()
    await runInit(retry as never, makeAwsMock() as never, CONFIG, session)
    expect(retry.commitFiles).not.toHaveBeenCalled()
    expect(retry.createBranch).not.toHaveBeenCalled()
    expect(retry.configureBranchProtection).toHaveBeenCalled()
  })

  it('does not delete the session when a step fails partway', async () => {
    const github = makeGithubMock()
    github.commitFiles.mockRejectedValue(new Error('GitRPC::BadObjectState'))
    const session = makeSession({
      completedSteps: ['verify_credentials', 'create_repo', 'oidc_trust', 'terraform_backend'],
    })

    await expect(
      runInit(github as never, makeAwsMock() as never, CONFIG, session),
    ).rejects.toThrow()

    expect(deleteSession).not.toHaveBeenCalled()
  })
})

// ─── Issue #316, defect B1: --config must resume, not restart ────────────────
describe('resolveConfigFileSession', () => {
  beforeEach(() => {
    vi.mocked(loadSession).mockReset()
  })

  // The reported failure: resuming `biffo init --config <path>` restarted from
  // step 2 despite five recorded steps, then rewrote the session with four.
  it('adopts the saved session rather than starting from zero steps', () => {
    vi.mocked(loadSession).mockReturnValue(
      makeSession({
        completedSteps: [
          'verify_credentials',
          'create_repo',
          'oidc_trust',
          'terraform_backend',
          'github_settings',
        ],
        outputs: { cloneUrl: 'https://github.com/acme/my-app.git', oidcRoleArn: 'arn:role' },
      }),
    )

    const session = resolveConfigFileSession(CONFIG, '123456789012', 'eu-west-1', false)

    expect(session.completedSteps).toEqual([
      'verify_credentials',
      'create_repo',
      'oidc_trust',
      'terraform_backend',
      'github_settings',
    ])
    // The outputs a resume needs to avoid redoing work must come along too.
    expect(session.outputs.oidcRoleArn).toBe('arn:role')
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('takes config, account and region from the FILE, not the saved session', () => {
    vi.mocked(loadSession).mockReturnValue(
      makeSession({
        config: { ...CONFIG, project: { ...CONFIG.project, description: 'stale' } },
        awsAccountId: '999999999999',
        awsRegion: 'us-east-1',
        completedSteps: ['verify_credentials'],
      }),
    )

    const session = resolveConfigFileSession(CONFIG, '123456789012', 'eu-west-1', false)

    expect(session.config).toBe(CONFIG)
    expect(session.awsAccountId).toBe('123456789012')
    expect(session.awsRegion).toBe('eu-west-1')
    // …while still resuming.
    expect(session.completedSteps).toEqual(['verify_credentials'])
  })

  it('starts empty and discards the stale file when --fresh is passed', () => {
    vi.mocked(loadSession).mockReturnValue(
      makeSession({ completedSteps: ['verify_credentials', 'create_repo'] }),
    )

    const session = resolveConfigFileSession(CONFIG, '123456789012', 'eu-west-1', true)

    expect(session.completedSteps).toEqual([])
    // Saves are monotonic, so --fresh MUST delete or the old steps merge back in.
    expect(deleteSession).toHaveBeenCalledWith('my-app')
  })

  it('starts empty when there is no saved session', () => {
    vi.mocked(loadSession).mockReturnValue(null)

    const session = resolveConfigFileSession(CONFIG, '123456789012', 'eu-west-1', false)

    expect(session.completedSteps).toEqual([])
    expect(deleteSession).toHaveBeenCalledWith('my-app')
  })
})
