import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import { SiblingConfigSchema } from '../config/sibling-schema.js'
import type { SiblingSession } from '../lib/sibling-session.js'
import { runSiblingCreate, writeSiblingTemplate, type SiblingCreateGit } from './sibling-create.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../lib/sibling-session.js', () => ({
  markSiblingStepComplete: vi.fn((session: SiblingSession, step: string) => {
    if (!session.completedSteps.includes(step as never)) session.completedSteps.push(step as never)
  }),
  deleteSiblingSession: vi.fn(),
}))

const CORE_CONFIG = BiffoConfigSchema.parse({
  project: { name: 'core-app', description: 'Core app' },
  dns: { mode: 'none' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'core-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'admin@example.com', username: 'admin' },
})

const SIBLING_CONFIG = SiblingConfigSchema.parse({
  project: { name: 'reports', description: 'Reports sibling' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'reports' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  core: { config_path: './biffo.config.json', path_prefix: 'reports' },
})

const CORE_OUTPUTS = {
  cognito_user_pool_id: 'us-east-1_abc123',
  cognito_client_id: 'client-abc',
  api_gateway_url: 'https://api.example.com',
  portal_url: 'https://baseurl.com',
}

function makeSession(): SiblingSession {
  return {
    version: 1,
    config: SIBLING_CONFIG,
    awsAccountId: '123456789012',
    awsRegion: 'eu-west-1',
    completedSteps: [],
    outputs: {},
  }
}

function makeGithubMock() {
  return {
    createEmptyRepo: vi.fn().mockResolvedValue('https://github.com/acme/reports.git'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    setDefaultBranch: vi.fn().mockResolvedValue(undefined),
    configureBranchProtection: vi.fn().mockResolvedValue(undefined),
    createEnvironments: vi.fn().mockResolvedValue(undefined),
    setRepoVariable: vi.fn().mockResolvedValue(undefined),
    setEnvVariable: vi.fn().mockResolvedValue(undefined),
    setRepoSecret: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi
      .fn()
      .mockResolvedValue({ url: 'https://github.com/acme/core-app/pull/1', number: 1 }),
  }
}

function makeAwsMock() {
  return {
    verifyCredentials: vi.fn().mockResolvedValue(undefined),
    setupOidcTrust: vi
      .fn()
      .mockResolvedValue('arn:aws:iam::123456789012:role/biffo-github-actions-reports'),
    bootstrapTerraformBackend: vi.fn().mockResolvedValue('reports-terraform-state-123456789012'),
    readTerraformOutputs: vi.fn(),
  }
}

function makeGitMock(): SiblingCreateGit & Record<string, ReturnType<typeof vi.fn>> {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    addRemote: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    cloneForEditing: vi.fn().mockResolvedValue('/tmp/fake-core-clone'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue('dev'),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/acme/core-app.git'),
    cleanup: vi.fn(),
  }
}

describe('writeSiblingTemplate', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites sibling metadata and frontend env defaults', () => {
    const template = mkdtempSync(join(tmpdir(), 'sibling-template-'))
    const target = mkdtempSync(join(tmpdir(), 'sibling-target-'))
    dirs.push(template, target)
    writeFileSync(
      join(template, 'biffo.sibling.json'),
      JSON.stringify({ name: 'example-sibling', core_project: 'example-core-project' }),
    )
    const frontendDir = join(template, 'apps', 'frontend')
    mkdirSync(frontendDir, { recursive: true })
    writeFileSync(
      join(frontendDir, '.env.example'),
      [
        'NEXT_PUBLIC_SIBLING_NAME=example-sibling',
        'NEXT_PUBLIC_SIBLING_PATH_PREFIX=/example-sibling',
        'NEXT_PUBLIC_BASE_PATH=/example-sibling',
      ].join('\n'),
    )

    writeSiblingTemplate(template, target, SIBLING_CONFIG, {
      coreProjectName: 'core-app',
      pathPrefix: 'reports',
    })

    expect(JSON.parse(readFileSync(join(target, 'biffo.sibling.json'), 'utf8'))).toMatchObject({
      name: 'reports',
      core_project: 'core-app',
      path_prefix: 'reports',
      description: 'Reports sibling',
    })
    expect(readFileSync(join(target, 'apps', 'frontend', '.env.example'), 'utf8')).toContain(
      'NEXT_PUBLIC_SIBLING_NAME=reports',
    )
  })
})

describe('runSiblingCreate', () => {
  let skeletonRoot: string

  beforeEach(() => {
    skeletonRoot = mkdtempSync(join(tmpdir(), 'sibling-skeleton-'))
    writeFileSync(join(skeletonRoot, 'biffo.sibling.json'), '{}')
  })

  afterEach(() => {
    rmSync(skeletonRoot, { recursive: true, force: true })
  })

  it('runs all 7 steps in order on a fresh session', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
    const git = makeGitMock()
    const session = makeSession()

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      git,
      SIBLING_CONFIG,
      session,
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    expect(aws.verifyCredentials).toHaveBeenCalledTimes(1)
    expect(coreAws.readTerraformOutputs).toHaveBeenCalledWith(
      'core-app-terraform-state-123456789012',
      'dev/terraform.tfstate',
    )
    expect(github.createEmptyRepo).toHaveBeenCalledWith('acme', 'reports', 'Reports sibling')
    expect(git.init).toHaveBeenCalledWith(expect.any(String), 'main')
    expect(git.push).toHaveBeenCalledWith(expect.any(String), 'main', { token: 'gh-token' })
    expect(aws.setupOidcTrust).toHaveBeenCalledWith(SIBLING_CONFIG)
    expect(aws.bootstrapTerraformBackend).toHaveBeenCalledWith('reports')
    expect(github.configureBranchProtection).toHaveBeenCalledWith(SIBLING_CONFIG)
    expect(github.setEnvVariable).toHaveBeenCalledWith(
      'acme',
      'reports',
      'dev',
      'CORE_COGNITO_USER_POOL_ID',
      'us-east-1_abc123',
    )
    expect(github.setRepoSecret).toHaveBeenCalledWith(
      'acme',
      'reports',
      'SIBLING_OIDC_ROLE_ARN',
      'arn:aws:iam::123456789012:role/biffo-github-actions-reports',
    )
    expect(git.cloneForEditing).toHaveBeenCalledWith(
      'https://github.com/acme/core-app.git',
      expect.stringContaining('reports'),
      'gh-token',
    )
    expect(github.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'core-app', base: 'dev' }),
    )

    expect(session.completedSteps).toEqual([
      'verify_credentials',
      'resolve_core_identity',
      'create_repo',
      'oidc_trust',
      'terraform_backend',
      'github_config',
      'register_with_core',
    ])
  })

  it('skips steps already marked complete', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    const git = makeGitMock()
    const session = makeSession()
    session.completedSteps = ['verify_credentials', 'resolve_core_identity']
    session.outputs.coreIdentity = {
      dev: {
        cognitoUserPoolId: 'us-east-1_abc123',
        cognitoClientId: 'client-abc',
        apiUrl: 'https://api.example.com',
        portalUrl: 'https://baseurl.com',
      },
    }

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      git,
      SIBLING_CONFIG,
      session,
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    expect(aws.verifyCredentials).not.toHaveBeenCalled()
    expect(coreAws.readTerraformOutputs).not.toHaveBeenCalled()
    expect(github.createEmptyRepo).toHaveBeenCalledTimes(1)
  })

  it('registers one siblings.auto.tfvars.json entry per environment', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
    const git = makeGitMock()
    const session = makeSession()

    const multiEnvConfig = SiblingConfigSchema.parse({
      ...SIBLING_CONFIG,
      environments: ['dev', 'staging'],
    })

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      git,
      multiEnvConfig,
      session,
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    expect(git.add).toHaveBeenCalledWith(expect.any(String), [
      join('infra', 'environments', 'dev', 'siblings.auto.tfvars.json'),
      join('infra', 'environments', 'staging', 'siblings.auto.tfvars.json'),
    ])
  })

  it('propagates errors without marking the failing step complete', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    aws.verifyCredentials.mockRejectedValueOnce(new Error('bad credentials'))
    const coreAws = makeAwsMock()
    const git = makeGitMock()
    const session = makeSession()

    await expect(
      runSiblingCreate(
        github as never,
        aws as never,
        coreAws as never,
        git,
        SIBLING_CONFIG,
        session,
        {
          coreConfig: CORE_CONFIG,
          skeletonRoot,
          githubToken: 'gh-token',
        },
      ),
    ).rejects.toThrow('bad credentials')

    expect(session.completedSteps).toEqual([])
    expect(github.createEmptyRepo).not.toHaveBeenCalled()
  })

  it('throws a clear error when the core project has not been deployed', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue({})
    const git = makeGitMock()
    const session = makeSession()

    await expect(
      runSiblingCreate(
        github as never,
        aws as never,
        coreAws as never,
        git,
        SIBLING_CONFIG,
        session,
        {
          coreConfig: CORE_CONFIG,
          skeletonRoot,
          githubToken: 'gh-token',
        },
      ),
    ).rejects.toThrow(/cognito_user_pool_id not found/)
  })
})
