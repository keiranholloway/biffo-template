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
    http.get(`${GH}/repos/acme/my-app/branches/main`, () =>
      HttpResponse.json({ name: 'main', commit: { sha: 'abc' } }),
    ),
    http.put(`${GH}/repos/acme/my-app/branches/main/protection`, () => HttpResponse.json({})),
    http.put(`${GH}/repos/acme/my-app/environments/:env`, () => HttpResponse.json({})),
  )
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
    server.use(
      http.get(`${GH}/repos/acme/my-app/branches/main`, () =>
        HttpResponse.json({ name: 'main', commit: { sha: 'abc' } }),
      ),
      http.put(`${GH}/repos/acme/my-app/branches/main/protection`, () => HttpResponse.json({})),
      http.put(`${GH}/repos/acme/my-app/environments/:env`, () => HttpResponse.json({})),
    )

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
})
