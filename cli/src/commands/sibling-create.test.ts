import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import { SiblingConfigSchema } from '../config/sibling-schema.js'
import {
  recordBranchProtectionOutcome,
  resetBranchProtectionOutcomes,
} from '../lib/branch-protection-outcome.js'
import { log } from '../lib/logger.js'
import type { SiblingSession } from '../lib/sibling-session.js'
import {
  assertCoreSupportsSiblingRouting,
  assertGitIdentity,
  assertPathPrefixIsAllowed,
  runSiblingCreate,
  writeSiblingTemplate,
  type SiblingCreateGit,
} from './sibling-create.js'

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
    // Default: a repo the skeleton has not been pushed to yet.
    repoHasCommits: vi.fn().mockResolvedValue(false),
    createBranch: vi.fn().mockResolvedValue(undefined),
    setDefaultBranch: vi.fn().mockResolvedValue(undefined),
    configureBranchProtection: vi.fn().mockResolvedValue(undefined),
    createEnvironments: vi.fn().mockResolvedValue(undefined),
    enableVulnerabilityAlerts: vi.fn().mockResolvedValue(undefined),
    setRepoVariable: vi.fn().mockResolvedValue(undefined),
    getRepoVariable: vi.fn().mockResolvedValue(undefined),
    setEnvVariable: vi.fn().mockResolvedValue(undefined),
    setRepoSecret: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi
      .fn()
      .mockResolvedValue({ url: 'https://github.com/acme/core-app/pull/1', number: 1 }),
    getRepoIds: vi.fn().mockResolvedValue({ ownerId: 42, repoId: 99 }),
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

// Fake "cloned core repo" dirs, seeded with (or without) ADR-0007's
// `sibling_origins` support so the registration pre-flight (issue #151) sees a
// realistic modules/cloud/aws/cdn. Cleaned up after each test.
const coreClones: string[] = []

function seedCoreClone(withSiblingSupport = true, withRootSupport = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'sibling-core-clone-'))
  coreClones.push(dir)
  const cdnDir = join(dir, 'modules', 'cloud', 'aws', 'cdn')
  mkdirSync(cdnDir, { recursive: true })
  writeFileSync(
    join(cdnDir, 'variables.tf'),
    withSiblingSupport
      ? 'variable "sibling_origins" {\n  type = any\n}\n'
      : 'variable "aliases" {}\n',
  )
  // The capability marker the ROOT pre-flight looks for (issue #306): a core
  // whose default_cache_behavior can follow the "app" origin.
  writeFileSync(
    join(cdnDir, 'main.tf'),
    withRootSupport ? 'locals {\n  root_sibling_registered = true\n}\n' : 'locals {}\n',
  )
  return dir
}

afterEach(() => {
  for (const dir of coreClones.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeGitMock(): SiblingCreateGit & Record<string, ReturnType<typeof vi.fn>> {
  return {
    configuredIdentity: vi.fn().mockResolvedValue({ name: 'A Dev', email: 'dev@example.com' }),
    init: vi.fn().mockResolvedValue(undefined),
    addRemote: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    cloneForEditing: vi.fn().mockResolvedValue(seedCoreClone()),
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
      templateVersion: '1.2.3',
    })

    expect(JSON.parse(readFileSync(join(target, 'biffo.sibling.json'), 'utf8'))).toMatchObject({
      name: 'reports',
      core_project: 'core-app',
      path_prefix: 'reports',
      template_version: '1.2.3',
      description: 'Reports sibling',
      // Scaffolded (empty) so the field is discoverable for the developer to fill.
      routes: [],
    })
    expect(readFileSync(join(target, 'apps', 'frontend', '.env.example'), 'utf8')).toContain(
      'NEXT_PUBLIC_SIBLING_NAME=reports',
    )
  })

  it('writes declared routes into the sibling biffo.sibling.json', () => {
    const template = mkdtempSync(join(tmpdir(), 'tmpl-'))
    mkdirSync(join(template, 'apps', 'frontend'), { recursive: true })
    writeFileSync(join(template, 'biffo.sibling.json'), '{}')

    const target = mkdtempSync(join(tmpdir(), 'tgt-'))
    const configWithRoutes = SiblingConfigSchema.parse({
      project: {
        name: 'reports',
        description: 'Reports sibling',
        routes: [{ path: 'weekly', label: 'Weekly report' }],
      },
      source_control: { provider: 'github', config: { org: 'acme', repo: 'reports' } },
      cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
      environments: ['dev'],
      core: { config_path: './biffo.config.json', path_prefix: 'reports' },
    })

    writeSiblingTemplate(template, target, configWithRoutes, {
      coreProjectName: 'core-app',
      pathPrefix: 'reports',
      templateVersion: '1.2.3',
    })

    expect(JSON.parse(readFileSync(join(target, 'biffo.sibling.json'), 'utf8')).routes).toEqual([
      { path: 'weekly', label: 'Weekly report' },
    ])
  })
})

describe('runSiblingCreate', () => {
  let skeletonRoot: string

  beforeEach(() => {
    skeletonRoot = mkdtempSync(join(tmpdir(), 'sibling-skeleton-'))
    writeFileSync(join(skeletonRoot, 'biffo.sibling.json'), '{}')
    resetBranchProtectionOutcomes()
    vi.mocked(log.error).mockClear()
    vi.mocked(log.success).mockClear()
  })

  afterEach(() => {
    rmSync(skeletonRoot, { recursive: true, force: true })
  })

  it('fails the git-identity pre-flight BEFORE creating the repository (#737)', async () => {
    // This is the actual bug, and the only assertion that captures it. The commit
    // happens at step 4; the repo is created at step 3. Checking the identity late
    // still fails — it just fails after a repo exists, leaving an empty repo and a
    // half-done scaffold that a resumed session walks straight back into.
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    const git = makeGitMock()
    git.configuredIdentity.mockResolvedValue({ name: null, email: null })

    await expect(
      runSiblingCreate(
        github as never,
        aws as never,
        coreAws as never,
        git,
        SIBLING_CONFIG,
        makeSession(),
        { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
      ),
    ).rejects.toThrow(/user\.name or user\.email/)

    // The point of the fix: no side effects at all, not even the credential check.
    expect(github.createEmptyRepo).not.toHaveBeenCalled()
    expect(aws.verifyCredentials).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  // ─── #715 / #737 item 2 ────────────────────────────────────────────────────
  //
  // "Branch protection silently fails on private org repos… It should be
  // reported, not swallowed." The run below succeeds end to end; the only thing
  // wrong with it is that the repo it produced is unprotected. If it can finish
  // without saying so, the defect is back.

  it('ends the run with an explicit summary NAMING the repo it left unprotected', async () => {
    const github = makeGithubMock()
    github.configureBranchProtection = vi.fn().mockImplementation(async () =>
      recordBranchProtectionOutcome({
        status: 'skipped-403',
        org: 'acme',
        repo: 'reports',
        protectedBranches: [],
        unprotectedBranches: ['dev', 'staging', 'main'],
        reason: 'Upgrade to GitHub Team or make this repository public.',
      }),
    )
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      makeGitMock(),
      SIBLING_CONFIG,
      makeSession(),
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    const reported = vi.mocked(log.error).mock.calls.flat().join('\n')
    expect(reported).toContain('acme/reports')
    expect(reported).toContain('dev, staging, main')
    expect(reported).toContain('biffo check branch-protection --fix')
  })

  it('says nothing about branch protection when every branch was protected', async () => {
    const github = makeGithubMock()
    github.configureBranchProtection = vi.fn().mockImplementation(async () =>
      recordBranchProtectionOutcome({
        status: 'applied',
        org: 'acme',
        repo: 'reports',
        protectedBranches: ['dev', 'staging', 'main'],
        unprotectedBranches: [],
      }),
    )
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      makeGitMock(),
      SIBLING_CONFIG,
      makeSession(),
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    expect(vi.mocked(log.error)).not.toHaveBeenCalled()
    expect(vi.mocked(log.success).mock.calls.flat().join('\n')).toContain(
      'Branch protection applied to acme/reports',
    )
  })

  it('runs all 8 steps in order on a fresh session', async () => {
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
    expect(git.init).toHaveBeenCalledWith(expect.any(String), 'dev')
    expect(git.push).toHaveBeenCalledWith(expect.any(String), 'dev', { token: 'gh-token' })
    expect(aws.setupOidcTrust).toHaveBeenCalledWith(SIBLING_CONFIG, {
      ownerId: 42,
      repoId: 99,
    })
    expect(aws.bootstrapTerraformBackend).toHaveBeenCalledWith('reports')
    expect(github.configureBranchProtection).toHaveBeenCalledWith(SIBLING_CONFIG)
    expect(github.enableVulnerabilityAlerts).toHaveBeenCalledOnce()
    expect(github.setRepoVariable).toHaveBeenCalledWith(
      'acme',
      'reports',
      'PROJECT_NAME',
      'reports',
    )
    expect(github.setRepoVariable).toHaveBeenCalledWith('acme', 'reports', 'PATH_PREFIX', 'reports')
    expect(github.setEnvVariable).toHaveBeenCalledWith(
      'acme',
      'reports',
      'dev',
      'CORE_COGNITO_USER_POOL_ID',
      'us-east-1_abc123',
    )
    expect(github.setEnvVariable).toHaveBeenCalledWith(
      'acme',
      'reports',
      'dev',
      'CORS_ORIGINS_JSON',
      '["https://baseurl.com"]',
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
      // Two checkpoints, not one (issue #316): the repo existing and the
      // skeleton being in it are separate facts, and a run can end between them.
      'create_repo',
      'push_skeleton',
      'oidc_trust',
      'terraform_backend',
      'github_config',
      'register_with_core',
    ])
  })

  it('fails registration if the core project lacks sibling CDN routing support', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
    const git = makeGitMock()
    // Core clone whose modules/cloud/aws/cdn predates ADR-0007 (no sibling_origins).
    git.cloneForEditing.mockResolvedValue(seedCoreClone(false))
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
    ).rejects.toThrow(/doesn't support sibling CDN routing/)

    // It fails the pre-flight before committing the tfvars change or opening a PR.
    expect(github.createPullRequest).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('register sibling'),
    )
    expect(session.completedSteps).not.toContain('register_with_core')
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

  it('sets PATH_PREFIX separately from PROJECT_NAME when they differ', async () => {
    // Reproduces the real-world case that caught this bug: a sibling whose
    // repo/project name ("tabsii-crm") differs from the path it's routed
    // on ("crm"). The deploy workflow's S3 sync destination, Next.js
    // basePath, and CDN invalidation paths must all key off path_prefix,
    // not project.name, or the built site is uploaded under a prefix
    // CloudFront never routes requests to.
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
    const git = makeGitMock()
    const session = makeSession()

    const differingPrefixConfig = SiblingConfigSchema.parse({
      ...SIBLING_CONFIG,
      project: { name: 'tabsii-crm', description: 'Tabsii CRM' },
      core: { ...SIBLING_CONFIG.core, path_prefix: 'crm' },
    })

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      git,
      differingPrefixConfig,
      session,
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    expect(github.setRepoVariable).toHaveBeenCalledWith(
      'acme',
      'reports',
      'PROJECT_NAME',
      'tabsii-crm',
    )
    expect(github.setRepoVariable).toHaveBeenCalledWith('acme', 'reports', 'PATH_PREFIX', 'crm')
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

  it("mirrors the core project's RUNNER_LABEL onto the sibling when set", async () => {
    // The skeleton workflows run on `${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`.
    // When the core project routes CI to a self-hosted fleet, the sibling must
    // inherit that label or every job dies at the hosted-Actions billing wall.
    const github = makeGithubMock()
    github.getRepoVariable.mockResolvedValue('tabsii')
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

    // Reads it from the CORE repo, not the sibling.
    expect(github.getRepoVariable).toHaveBeenCalledWith('acme', 'core-app', 'RUNNER_LABEL')
    // Sets the same value on the sibling repo.
    expect(github.setRepoVariable).toHaveBeenCalledWith('acme', 'reports', 'RUNNER_LABEL', 'tabsii')
  })

  it('leaves RUNNER_LABEL unset on the sibling when the core project has none', async () => {
    const github = makeGithubMock()
    github.getRepoVariable.mockResolvedValue(undefined)
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

    expect(github.getRepoVariable).toHaveBeenCalledWith('acme', 'core-app', 'RUNNER_LABEL')
    expect(github.setRepoVariable).not.toHaveBeenCalledWith(
      'acme',
      'reports',
      'RUNNER_LABEL',
      expect.anything(),
    )
  })

  // ─── Issue #316, defect A: resume after a PARTIAL step ─────────────────────
  //
  // The reported failure exactly: `createEmptyRepo` succeeded, `pushSkeleton`
  // threw (#315), and because both lived behind one `create_repo` checkpoint
  // NOTHING was recorded — so the resume called `createEmptyRepo` again on a
  // repo that already existed. These pin the intended behaviour (the repo's
  // existence survives the crash), not the behaviour the code happened to have.
  describe('resume after a partially-completed step (issue #316)', () => {
    async function runWithFailingPush(
      session: SiblingSession,
      github: ReturnType<typeof makeGithubMock>,
    ) {
      const aws = makeAwsMock()
      const coreAws = makeAwsMock()
      coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
      const git = makeGitMock()
      git.push.mockRejectedValueOnce(new Error('Sibling template not found'))

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
      ).rejects.toThrow('Sibling template not found')
      return git
    }

    it('records create_repo when the skeleton push then fails', async () => {
      const github = makeGithubMock()
      const session = makeSession()

      await runWithFailingPush(session, github)

      // The repo EXISTS. Anything that does not say so leaves the run stuck.
      expect(github.createEmptyRepo).toHaveBeenCalledTimes(1)
      expect(session.completedSteps).toContain('create_repo')
      expect(session.completedSteps).not.toContain('push_skeleton')
      // The clone url is what the retry pushes to, so it has to survive too.
      expect(session.outputs.cloneUrl).toBe('https://github.com/acme/reports.git')
    })

    it('does not re-create the repo on the resume, and retries only the push', async () => {
      const failing = makeGithubMock()
      const session = makeSession()
      await runWithFailingPush(session, failing)

      // Second run, same session — the state a real `biffo sibling create`
      // re-run would load off disk.
      const github = makeGithubMock()
      const aws = makeAwsMock()
      const coreAws = makeAwsMock()
      coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
      const git = makeGitMock()

      await runSiblingCreate(
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
      )

      expect(github.createEmptyRepo).not.toHaveBeenCalled()
      // `git.init` is unique to pushSkeleton — `git.push` is also used by the
      // registration step, so asserting on it would prove nothing here.
      expect(git.init).toHaveBeenCalledTimes(1)
      expect(git.push).toHaveBeenCalledWith(expect.any(String), 'dev', { token: 'gh-token' })
      expect(session.completedSteps).toContain('push_skeleton')
    })

    it('skips the push when the repo already has commits, rather than forcing a rejected push', async () => {
      // The narrow window the other way round: the push landed but the process
      // died before the checkpoint was written. Re-pushing an initial commit
      // onto a repo that has one is a non-fast-forward, so it must be skipped.
      const github = makeGithubMock()
      github.repoHasCommits.mockResolvedValue(true)
      const aws = makeAwsMock()
      const coreAws = makeAwsMock()
      coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
      const git = makeGitMock()
      const session = makeSession()
      session.completedSteps = ['verify_credentials', 'resolve_core_identity', 'create_repo']
      session.outputs.coreIdentity = {
        dev: {
          cognitoUserPoolId: 'us-east-1_abc123',
          cognitoClientId: 'client-abc',
          apiUrl: 'https://api.example.com',
          portalUrl: 'https://baseurl.com',
        },
      }
      session.outputs.cloneUrl = 'https://github.com/acme/reports.git'

      await runSiblingCreate(
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
      )

      expect(git.init).not.toHaveBeenCalled()
      expect(session.completedSteps).toContain('push_skeleton')
    })

    it('resumes straight past a repo whose skeleton is already pushed', async () => {
      const github = makeGithubMock()
      const aws = makeAwsMock()
      const coreAws = makeAwsMock()
      coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
      const git = makeGitMock()
      const session = makeSession()
      session.completedSteps = [
        'verify_credentials',
        'resolve_core_identity',
        'create_repo',
        'push_skeleton',
      ]
      session.outputs.coreIdentity = {
        dev: {
          cognitoUserPoolId: 'us-east-1_abc123',
          cognitoClientId: 'client-abc',
          apiUrl: 'https://api.example.com',
          portalUrl: 'https://baseurl.com',
        },
      }
      session.outputs.cloneUrl = 'https://github.com/acme/reports.git'

      await runSiblingCreate(
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
      )

      expect(github.createEmptyRepo).not.toHaveBeenCalled()
      expect(git.init).not.toHaveBeenCalled()
      // GitHub is not even asked — the checkpoint is authoritative.
      expect(github.repoHasCommits).not.toHaveBeenCalled()
      expect(aws.setupOidcTrust).toHaveBeenCalled()
    })

    it('fails loudly if create_repo is recorded without a clone url', async () => {
      // A session in this shape cannot be pushed to. Better a clear internal
      // error here than a confusing git failure three calls later.
      const github = makeGithubMock()
      const aws = makeAwsMock()
      const coreAws = makeAwsMock()
      coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
      const git = makeGitMock()
      const session = makeSession()
      session.completedSteps = ['verify_credentials', 'resolve_core_identity', 'create_repo']
      session.outputs.coreIdentity = {
        dev: {
          cognitoUserPoolId: 'us-east-1_abc123',
          cognitoClientId: 'client-abc',
          apiUrl: 'https://api.example.com',
          portalUrl: 'https://baseurl.com',
        },
      }

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
      ).rejects.toThrow(/cloneUrl/)
    })
  })
})

// ─── The root application sibling (issue #306) ───────────────────────────────

const ROOT_CONFIG = SiblingConfigSchema.parse({
  project: { name: 'core-app-app', description: 'The application' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'core-app-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  // The empty prefix IS root mode.
  core: { config_path: './biffo.config.json', path_prefix: '' },
})

function makeRootSession(): SiblingSession {
  return {
    version: 1,
    config: ROOT_CONFIG,
    awsAccountId: '123456789012',
    awsRegion: 'eu-west-1',
    completedSteps: [],
    outputs: {},
  }
}

describe('root sibling mode', () => {
  let skeletonRoot: string

  beforeEach(() => {
    skeletonRoot = mkdtempSync(join(tmpdir(), 'sibling-skeleton-'))
    writeFileSync(join(skeletonRoot, 'biffo.sibling.json'), '{}')
  })

  afterEach(() => {
    rmSync(skeletonRoot, { recursive: true, force: true })
  })

  it('rejects a non-root sibling claiming a reserved prefix', () => {
    expect(() => assertPathPrefixIsAllowed('app')).toThrow(/reserved/)
    expect(() => assertPathPrefixIsAllowed('admin')).toThrow(/reserved/)
    expect(() => assertPathPrefixIsAllowed('login')).toThrow(/reserved/)
    expect(() => assertPathPrefixIsAllowed('crm')).not.toThrow()
    // The root itself is allowed — it is the one thing "app" is reserved FOR.
    expect(() => assertPathPrefixIsAllowed('')).not.toThrow()
  })

  it('gives the sibling an EMPTY basePath, not "/"', () => {
    const template = mkdtempSync(join(tmpdir(), 'root-tmpl-'))
    const target = mkdtempSync(join(tmpdir(), 'root-tgt-'))
    coreClones.push(template, target)
    mkdirSync(join(template, 'apps', 'frontend'), { recursive: true })
    writeFileSync(join(template, 'biffo.sibling.json'), '{}')
    writeFileSync(
      join(template, 'apps', 'frontend', '.env.example'),
      ['NEXT_PUBLIC_SIBLING_PATH_PREFIX=/x', 'NEXT_PUBLIC_BASE_PATH=/x'].join('\n'),
    )

    writeSiblingTemplate(template, target, ROOT_CONFIG, {
      coreProjectName: 'core-app',
      pathPrefix: '',
      templateVersion: '1.2.3',
    })

    const env = readFileSync(join(target, 'apps', 'frontend', '.env.example'), 'utf8')
    expect(env.split('\n')).toContain('NEXT_PUBLIC_BASE_PATH=')
    expect(env.split('\n')).toContain('NEXT_PUBLIC_SIBLING_PATH_PREFIX=')
    expect(env).not.toContain('NEXT_PUBLIC_BASE_PATH=/')
    // The marker teardown reads records the real (empty) prefix.
    expect(JSON.parse(readFileSync(join(target, 'biffo.sibling.json'), 'utf8'))).toMatchObject({
      name: 'core-app-app',
      path_prefix: '',
    })
  })

  it('registers under the reserved name "app", never an empty name', async () => {
    const github = makeGithubMock()
    const aws = makeAwsMock()
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)
    const git = makeGitMock()
    const cloneDir = seedCoreClone()
    git.cloneForEditing.mockResolvedValue(cloneDir)

    await runSiblingCreate(
      github as never,
      aws as never,
      coreAws as never,
      git,
      ROOT_CONFIG,
      makeRootSession(),
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    const registry = JSON.parse(
      readFileSync(
        join(cloneDir, 'infra', 'environments', 'dev', 'siblings.auto.tfvars.json'),
        'utf8',
      ),
    ) as { sibling_origins: { name: string; bucket_regional_domain: string }[] }

    expect(registry.sibling_origins).toHaveLength(1)
    expect(registry.sibling_origins[0]!.name).toBe('app')
    expect(registry.sibling_origins[0]!.bucket_regional_domain).toBe(
      'core-app-app-dev-site-123456789012.s3.eu-west-1.amazonaws.com',
    )
  })

  // Issue #319: GitHub's Actions variables API rejects an empty value with a
  // 422, so the root sibling's empty prefix must be left UNSET rather than
  // stored. An unset `vars.PATH_PREFIX` evaluates to '' in every consumer
  // (skeleton deploy.yml's basePath, S3 sync destination and CloudFront
  // invalidation all use `${VAR:+...}` / `vars.X && ... || ''`), so this is
  // behaviourally identical — and it is the only representable option.
  it('does not set a PATH_PREFIX repo variable for the root sibling', async () => {
    const github = makeGithubMock()
    const git = makeGitMock()
    git.cloneForEditing.mockResolvedValue(seedCoreClone())
    const coreAws = makeAwsMock()
    coreAws.readTerraformOutputs.mockResolvedValue(CORE_OUTPUTS)

    await runSiblingCreate(
      github as never,
      makeAwsMock() as never,
      coreAws as never,
      git,
      ROOT_CONFIG,
      makeRootSession(),
      { coreConfig: CORE_CONFIG, skeletonRoot, githubToken: 'gh-token' },
    )

    expect(github.setRepoVariable).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'PATH_PREFIX',
      expect.anything(),
    )
    // The rest of the repo configuration must still happen — the skip is
    // scoped to this one variable, not to the step.
    expect(github.setRepoVariable).toHaveBeenCalledWith(
      'acme',
      'core-app-app',
      'PROJECT_NAME',
      'core-app-app',
    )
  })

  // The silent-failure guard: an older core would merge the registration and
  // gain the origin, but route nothing to it.
  it('refuses a core whose CDN cannot follow the app origin', () => {
    const withoutRoot = seedCoreClone(true, false)
    expect(() => assertCoreSupportsSiblingRouting(withoutRoot, 'core-app', '')).toThrow(
      /ROOT application sibling/,
    )
    // ...but an ordinary sibling is still fine against that same core.
    expect(() => assertCoreSupportsSiblingRouting(withoutRoot, 'core-app', 'crm')).not.toThrow()
  })

  it('can skip core identity and registration, for biffo init', async () => {
    const github = makeGithubMock()
    const coreAws = makeAwsMock()
    const git = makeGitMock()
    const session = makeRootSession()

    await runSiblingCreate(
      github as never,
      makeAwsMock() as never,
      coreAws as never,
      git,
      ROOT_CONFIG,
      session,
      {
        coreConfig: CORE_CONFIG,
        skeletonRoot,
        githubToken: 'gh-token',
        skipCoreIdentity: true,
        skipRegistration: true,
      },
    )

    // The core is not deployed yet, so its outputs are never read...
    expect(coreAws.readTerraformOutputs).not.toHaveBeenCalled()
    // ...and no registration PR is opened against a repo init just created.
    expect(github.createPullRequest).not.toHaveBeenCalled()
    // But the repo itself is fully provisioned, and every step is checkpointed
    // so a resumed init does not try to create it twice.
    expect(github.createEmptyRepo).toHaveBeenCalledWith('acme', 'core-app-app', 'The application')
    // `resolve_core_identity` is deliberately NOT checkpointed on the deferred
    // init path (issue #337). Marking it done made the deferral a permanent
    // dead-end — a later `biffo sibling create` re-run skipped resolution and
    // the sibling's CORE_* stayed empty forever. Leaving it unrecorded lets the
    // core's own `biffo deploy` (or a manual re-run) resolve it once the core
    // is up.
    expect(session.completedSteps).toEqual([
      'verify_credentials',
      // Two checkpoints, not one (issue #316): the repo existing and the
      // skeleton being in it are separate facts, and a run can end between them.
      'create_repo',
      'push_skeleton',
      'oidc_trust',
      'terraform_backend',
      'github_config',
      'register_with_core',
    ])
    // The empty identity map is still populated, so the invariant that step 2
    // fills session.outputs.coreIdentity holds and step 7 sets no CORE_* vars.
    expect(session.outputs.coreIdentity).toEqual({})
  })
})

describe('assertGitIdentity (#737)', () => {
  it('accepts a fully configured identity', () => {
    expect(() => assertGitIdentity({ name: 'A Dev', email: 'dev@example.com' })).not.toThrow()
  })

  it('names the missing key and the command that sets it', () => {
    // The old failure was git's own message, arriving after the GitHub repo had
    // been created. An error that does not say what to run is most of the tax.
    expect(() => assertGitIdentity({ name: 'A Dev', email: null })).toThrow(
      /user\.email[\s\S]*git config --global user\.email/,
    )
  })

  it('reports both keys when both are missing, not just the first', () => {
    const run = () => assertGitIdentity({ name: null, email: null })
    expect(run).toThrow(/user\.name or user\.email/)
    expect(run).toThrow(/git config --global user\.name/)
    expect(run).toThrow(/git config --global user\.email/)
  })

  it('treats an empty string as unset — git resolves it to nothing usable', () => {
    expect(() => assertGitIdentity({ name: '', email: 'dev@example.com' })).toThrow(/user\.name/)
  })
})
