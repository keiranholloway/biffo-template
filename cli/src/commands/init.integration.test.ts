/**
 * End-to-end integration tests for runInit().
 *
 * Unlike init.test.ts (which passes adapter mocks), these tests use real
 * GitHubAdapter and AwsAdapter instances. GitHub HTTP is intercepted by MSW;
 * AWS SDK calls by aws-sdk-client-mock. This catches wiring bugs between
 * runInit() and its adapters that adapter-level mocks can't detect.
 */
import {
  AttachRolePolicyCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  IAMClient,
} from '@aws-sdk/client-iam'
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AwsAdapter } from '../adapters/cloud/aws/index.js'
import { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { BiffoConfigSchema } from '../config/schema.js'
import type { InitSession } from '../lib/session.js'
import { runInit } from './init.js'

vi.mock('node:child_process', () => ({ execSync: vi.fn() }))

vi.mock('../lib/session.js', () => ({
  markStepComplete: vi.fn((session: InitSession, step: string) => {
    session.completedSteps.push(step)
  }),
  deleteSession: vi.fn(),
  saveSession: vi.fn(),
  saveProjectConfig: vi.fn(),
  findLatestSession: vi.fn(),
  loadSession: vi.fn(),
}))

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const stsMock = mockClient(STSClient)
const iamMock = mockClient(IAMClient)
const s3Mock = mockClient(S3Client)

const GH = 'https://api.github.com'
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  committedTrees = []
  stsMock.reset()
  iamMock.reset()
  s3Mock.reset()
  vi.clearAllMocks()
})
afterAll(() => server.close())

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: 'Test app', domain: 'example.com' },
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

// The default template owner/repo baked into GitHubAdapter
const TMPL = 'keiranholloway/biffo-template'

// Handlers for step 5 (github_config): branch creation, protection, variables, environments.
// Branches dev and staging are returned as already-existing so createBranch skips creation;
// this keeps the test focused on flow wiring rather than createBranch internals.
function setupStep5GithubHandlers() {
  server.use(
    // createBranch: branches already exist → skip
    http.get(`${GH}/repos/acme/my-app/branches/dev`, () =>
      HttpResponse.json({ name: 'dev', commit: { sha: 'abc' } }),
    ),
    http.get(`${GH}/repos/acme/my-app/branches/staging`, () =>
      HttpResponse.json({ name: 'staging', commit: { sha: 'abc' } }),
    ),
    // setDefaultBranch
    http.patch(`${GH}/repos/acme/my-app`, () => HttpResponse.json({})),
    // configureBranchProtection: all 3 branches
    http.put(`${GH}/repos/acme/my-app/branches/dev/protection`, () => HttpResponse.json({})),
    http.put(`${GH}/repos/acme/my-app/branches/staging/protection`, () => HttpResponse.json({})),
    http.get(`${GH}/repos/acme/my-app/branches/main`, () =>
      HttpResponse.json({ name: 'main', commit: { sha: 'abc' } }),
    ),
    http.put(`${GH}/repos/acme/my-app/branches/main/protection`, () => HttpResponse.json({})),
    // createEnvironments
    http.put(`${GH}/repos/acme/my-app/environments/:env`, () => HttpResponse.json({})),
    // setRepoVariable DNS_MODE / DOMAIN: PATCH returns 404 (doesn't exist yet) → POST creates it
    http.patch(`${GH}/repos/acme/my-app/actions/variables/DNS_MODE`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.patch(`${GH}/repos/acme/my-app/actions/variables/DOMAIN`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.post(`${GH}/repos/acme/my-app/actions/variables`, () => HttpResponse.json({})),
    // setEnvVariable CUSTOM_DOMAIN for dev: PATCH returns 404 → POST creates it
    http.patch(`${GH}/repos/acme/my-app/environments/dev/variables/CUSTOM_DOMAIN`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.post(`${GH}/repos/acme/my-app/environments/dev/variables`, () => HttpResponse.json({})),
    ...instanceIdentityHandlers(),
  )
}

/**
 * Handlers for the instance-identity commit (issue #269): the content probe
 * plus the Git Data API chain used to add biffo.core.json and delete the
 * template's placeholder biffo.config.json.
 */
function instanceIdentityHandlers() {
  return [
    // biffo.core.json is absent (fresh instance) → must be added
    http.get(`${GH}/repos/acme/my-app/contents/biffo.core.json`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    // biffo.config.json is present with the template's placeholders → must be deleted
    http.get(`${GH}/repos/acme/my-app/contents/biffo.config.json`, () =>
      HttpResponse.json({
        type: 'file',
        content: Buffer.from('{"project":{"name":"{{PROJECT_NAME}}"}}', 'utf8').toString('base64'),
      }),
    ),
    // The app sibling's CDN registration (issue #306) rides in the same commit
    // — absent on a fresh instance, so commitFiles' content probe 404s and it
    // gets added.
    // Octokit sends `path` as a single, percent-encoded path segment
    // (`infra%2Fenvironments%2Fdev%2F…`) — GitHub accepts that form, verified
    // against the live API, but MSW matches the raw URL, so the handler has to
    // be written encoded too. A `:env`-style pattern silently never matches.
    http.get(`${GH}/repos/acme/my-app/contents/:path`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.get(`${GH}/repos/acme/my-app/git/ref/*`, () =>
      HttpResponse.json({ object: { sha: 'headsha' } }),
    ),
    http.get(`${GH}/repos/acme/my-app/git/commits/:sha`, () =>
      HttpResponse.json({ tree: { sha: 'treesha' } }),
    ),
    http.post(`${GH}/repos/acme/my-app/git/blobs`, () => HttpResponse.json({ sha: 'blobsha' })),
    http.post(`${GH}/repos/acme/my-app/git/trees`, async ({ request }) => {
      committedTrees.push((await request.json()) as TreeRequest)
      return HttpResponse.json({ sha: 'newtreesha' })
    }),
    http.post(`${GH}/repos/acme/my-app/git/commits`, () =>
      HttpResponse.json({ sha: 'newcommitsha' }),
    ),
    http.patch(`${GH}/repos/acme/my-app/git/refs/*`, () => HttpResponse.json({})),
  ]
}

interface TreeRequest {
  tree: { path: string; sha: string | null }[]
}

let committedTrees: TreeRequest[] = []

function setupGithubHandlers() {
  server.use(
    http.get(`${GH}/repos/${TMPL}`, () => HttpResponse.json({ is_template: true })),
    http.get(`${GH}/repos/acme/my-app`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.post(`${GH}/repos/${TMPL}/generate`, () =>
      HttpResponse.json({
        clone_url: 'https://github.com/acme/my-app.git',
        html_url: 'https://github.com/acme/my-app',
      }),
    ),
  )
  setupStep5GithubHandlers()
}

function setupAwsMocks() {
  stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' })
  iamMock
    .on(GetOpenIDConnectProviderCommand)
    .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
  iamMock.on(CreateOpenIDConnectProviderCommand).resolves({})
  iamMock
    .on(GetRoleCommand)
    .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
  iamMock.on(CreateRoleCommand).resolves({
    Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
  })
  iamMock.on(AttachRolePolicyCommand).resolves({})
  s3Mock.on(HeadBucketCommand).rejects({ name: 'NotFound' })
  s3Mock.on(CreateBucketCommand).resolves({})
  s3Mock.on(PutBucketVersioningCommand).resolves({})
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runInit (integration — real adapters + HTTP mocks)', () => {
  it('completes all 5 steps and persists outputs in session', async () => {
    setupGithubHandlers()
    setupAwsMocks()

    const session = makeSession()
    await runInit(new GitHubAdapter('test-token'), new AwsAdapter(CONFIG), CONFIG, session)

    expect(session.completedSteps).toEqual([
      'verify_credentials',
      'create_repo',
      'oidc_trust',
      'terraform_backend',
      'github_config',
    ])
    expect(session.outputs.cloneUrl).toBe('https://github.com/acme/my-app.git')
    expect(session.outputs.oidcRoleArn).toBe(
      'arn:aws:iam::123456789012:role/biffo-github-actions-my-app',
    )
    expect(session.outputs.tfStateBucket).toBe('my-app-terraform-state-123456789012')
  })

  it('resumes from step 3 — skips STS and GitHub template creation', async () => {
    // Steps 1 + 2 already done; only OIDC, S3, and GitHub config should run
    setupStep5GithubHandlers()

    iamMock
      .on(GetOpenIDConnectProviderCommand)
      .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
    iamMock.on(CreateOpenIDConnectProviderCommand).resolves({})
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
    iamMock.on(CreateRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })
    iamMock.on(AttachRolePolicyCommand).resolves({})
    s3Mock.on(HeadBucketCommand).rejects({ name: 'NotFound' })
    s3Mock.on(CreateBucketCommand).resolves({})
    s3Mock.on(PutBucketVersioningCommand).resolves({})

    const session = makeSession({ completedSteps: ['verify_credentials', 'create_repo'] })
    await runInit(new GitHubAdapter('test-token'), new AwsAdapter(CONFIG), CONFIG, session)

    expect(stsMock).not.toHaveReceivedCommand(GetCallerIdentityCommand)
    expect(iamMock).toHaveReceivedCommand(CreateRoleCommand)
    expect(session.completedSteps).toEqual([
      'verify_credentials',
      'create_repo',
      'oidc_trust',
      'terraform_backend',
      'github_config',
    ])
  })

  it('propagates errors from real adapters without deleting session', async () => {
    const { deleteSession } = await import('../lib/session.js')
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '999999999999' }) // wrong account

    const session = makeSession()
    await expect(
      runInit(new GitHubAdapter('test-token'), new AwsAdapter(CONFIG), CONFIG, session),
    ).rejects.toThrow('expected 123456789012')

    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('adds biffo.core.json and deletes the placeholder biffo.config.json on all three branches', async () => {
    setupGithubHandlers()
    setupAwsMocks()

    await runInit(new GitHubAdapter('test-token'), new AwsAdapter(CONFIG), CONFIG, makeSession())

    // One tree per branch: main, dev, staging.
    expect(committedTrees).toHaveLength(3)
    for (const tree of committedTrees) {
      const byPath = Object.fromEntries(tree.tree.map((e) => [e.path, e.sha]))
      expect(byPath['biffo.core.json']).toBe('blobsha')
      // null sha = deletion
      expect(byPath['biffo.config.json']).toBeNull()
    }
  })
})
