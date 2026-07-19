import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { BiffoConfigSchema } from '../../../config/schema.js'
import { AwsAdapter, oidcSubjectPatterns } from './index.js'

const stsMock = mockClient(STSClient)
const iamMock = mockClient(IAMClient)
const s3Mock = mockClient(S3Client)
const lambdaMock = mockClient(LambdaClient)

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: '', domain: 'example.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'a@b.com', username: 'a' },
})

beforeEach(() => {
  stsMock.reset()
  iamMock.reset()
  s3Mock.reset()
  lambdaMock.reset()
})

// ─── verifyCredentials ────────────────────────────────────────────────────────

describe('verifyCredentials', () => {
  it('succeeds when the resolved account matches config', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' })
    const adapter = new AwsAdapter(CONFIG)
    await expect(adapter.verifyCredentials()).resolves.toBeUndefined()
  })

  it('throws when the resolved account does not match config', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '999999999999' })
    const adapter = new AwsAdapter(CONFIG)
    await expect(adapter.verifyCredentials()).rejects.toThrow('expected 123456789012')
  })
})

// ─── bootstrapTerraformBackend ────────────────────────────────────────────────

describe('bootstrapTerraformBackend', () => {
  it('creates the bucket and enables versioning when it does not exist', async () => {
    s3Mock.on(HeadBucketCommand).rejects({ name: 'NotFound' })
    s3Mock.on(CreateBucketCommand).resolves({})
    s3Mock.on(PutBucketVersioningCommand).resolves({})

    await new AwsAdapter(CONFIG).bootstrapTerraformBackend('my-app')

    expect(s3Mock).toHaveReceivedCommandWith(CreateBucketCommand, {
      Bucket: 'my-app-terraform-state-123456789012',
    })
    expect(s3Mock).toHaveReceivedCommandWith(PutBucketVersioningCommand, {
      Bucket: 'my-app-terraform-state-123456789012',
      VersioningConfiguration: { Status: 'Enabled' },
    })
  })

  it('skips creation when the bucket already exists', async () => {
    s3Mock.on(HeadBucketCommand).resolves({})

    await new AwsAdapter(CONFIG).bootstrapTerraformBackend('my-app')

    expect(s3Mock).not.toHaveReceivedCommand(CreateBucketCommand)
    expect(s3Mock).not.toHaveReceivedCommand(PutBucketVersioningCommand)
  })
})

// ─── setupOidcTrust ──────────────────────────────────────────────────────────

describe('setupOidcTrust', () => {
  it('creates the IAM role and returns its ARN when it does not exist', async () => {
    const err = Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' })
    iamMock.on(GetRoleCommand).rejects(err)
    iamMock.on(CreateRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })

    const arn = await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG)
    expect(arn).toBe('arn:aws:iam::123456789012:role/biffo-github-actions-my-app')
    expect(iamMock).toHaveReceivedCommandWith(CreateRoleCommand, {
      RoleName: 'biffo-github-actions-my-app',
    })
  })

  it('creates the OIDC trust policy with the correct structure', async () => {
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
    iamMock.on(CreateRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })

    await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG, { ownerId: 8511402, repoId: 1305628980 })

    const [call] = iamMock.commandCalls(CreateRoleCommand)
    expect(JSON.parse(call!.args[0].input.AssumeRolePolicyDocument!)).toMatchSnapshot()
  })

  // Issue #271: GitHub presents `repo:<org>@<ownerId>/<repo>@<repoId>:ref:...` on
  // accounts using the immutable subject format. A policy carrying only the legacy
  // pattern denies every AssumeRoleWithWebIdentity and blocks every deploy.
  it('trusts both the legacy and ID-qualified subject formats', async () => {
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
    iamMock.on(CreateRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })

    await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG, { ownerId: 42, repoId: 99 })

    const [call] = iamMock.commandCalls(CreateRoleCommand)
    const policy = JSON.parse(call!.args[0].input.AssumeRolePolicyDocument!) as {
      Statement: { Condition: { StringLike: Record<string, string[]> } }[]
    }
    expect(
      policy.Statement[0]!.Condition.StringLike['token.actions.githubusercontent.com:sub'],
    ).toEqual(['repo:acme/my-app:*', 'repo:acme@42/my-app@99:*'])
  })

  it('falls back to the legacy pattern alone when repo IDs are unavailable', async () => {
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error('NoSuchEntity'), { name: 'NoSuchEntityException' }))
    iamMock.on(CreateRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })

    await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG)

    const [call] = iamMock.commandCalls(CreateRoleCommand)
    const policy = JSON.parse(call!.args[0].input.AssumeRolePolicyDocument!) as {
      Statement: { Condition: { StringLike: Record<string, string[]> } }[]
    }
    expect(
      policy.Statement[0]!.Condition.StringLike['token.actions.githubusercontent.com:sub'],
    ).toEqual(['repo:acme/my-app:*'])
  })

  it('returns existing ARN without creating when role already exists', async () => {
    iamMock.on(GetRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })

    const arn = await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG)
    expect(arn).toBe('arn:aws:iam::123456789012:role/biffo-github-actions-my-app')
    expect(iamMock).not.toHaveReceivedCommand(CreateRoleCommand)
  })

  // A project scaffolded by an older CLI already has a role whose trust policy
  // only matches the legacy subject. Re-running `biffo init` must repair it.
  it('rewrites the trust policy of a pre-existing role', async () => {
    iamMock.on(GetRoleCommand).resolves({
      Role: {
        Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app',
        MaxSessionDuration: 7200,
      } as never,
    })

    await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG, { ownerId: 42, repoId: 99 })

    const [call] = iamMock.commandCalls(UpdateAssumeRolePolicyCommand)
    expect(call).toBeDefined()
    expect(call!.args[0].input.RoleName).toBe('biffo-github-actions-my-app')
    const policy = JSON.parse(call!.args[0].input.PolicyDocument!) as {
      Statement: { Condition: { StringLike: Record<string, string[]> } }[]
    }
    expect(
      policy.Statement[0]!.Condition.StringLike['token.actions.githubusercontent.com:sub'],
    ).toEqual(['repo:acme/my-app:*', 'repo:acme@42/my-app@99:*'])
  })
})

// ─── oidcSubjectPatterns ─────────────────────────────────────────────────────

describe('oidcSubjectPatterns', () => {
  it('anchors both patterns to exactly one repository', () => {
    const patterns = oidcSubjectPatterns('acme', 'my-app', { ownerId: 42, repoId: 99 })
    // No wildcard may appear before the trailing ref/environment suffix — a
    // wildcard in the org or repo segment would let another repo assume the role.
    for (const p of patterns) {
      const [prefix] = p.split(':*')
      expect(prefix).not.toContain('*')
    }
  })

  it('never widens beyond the legacy pattern when IDs are absent', () => {
    expect(oidcSubjectPatterns('acme', 'my-app')).toEqual(['repo:acme/my-app:*'])
  })

  it('re-throws unexpected IAM errors', async () => {
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error('Access denied'), { name: 'AccessDeniedException' }))
    await expect(new AwsAdapter(CONFIG).setupOidcTrust(CONFIG)).rejects.toThrow('Access denied')
  })
})

// ─── teardownOidcRole ────────────────────────────────────────────────────────

describe('teardownOidcRole', () => {
  it('skips when the role does not exist', async () => {
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error(), { name: 'NoSuchEntityException' }))

    await new AwsAdapter(CONFIG).teardownOidcRole('my-app')

    expect(iamMock).not.toHaveReceivedCommand(DeleteRoleCommand)
  })

  it('detaches managed policies, deletes inline policies, then deletes role', async () => {
    iamMock.on(GetRoleCommand).resolves({ Role: {} as never })
    iamMock.on(ListAttachedRolePoliciesCommand).resolves({
      AttachedPolicies: [
        { PolicyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess', PolicyName: 'ReadOnlyAccess' },
      ],
    })
    iamMock.on(ListRolePoliciesCommand).resolves({ PolicyNames: ['inline-policy'] })
    iamMock.on(DeleteRoleCommand).resolves({})

    await new AwsAdapter(CONFIG).teardownOidcRole('my-app')

    expect(iamMock).toHaveReceivedCommandWith(DeleteRoleCommand, {
      RoleName: 'biffo-github-actions-my-app',
    })
  })

  it('deletes role even with no policies attached', async () => {
    iamMock.on(GetRoleCommand).resolves({ Role: {} as never })
    iamMock.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [] })
    iamMock.on(ListRolePoliciesCommand).resolves({ PolicyNames: [] })
    iamMock.on(DeleteRoleCommand).resolves({})

    await new AwsAdapter(CONFIG).teardownOidcRole('my-app')

    expect(iamMock).toHaveReceivedCommand(DeleteRoleCommand)
  })

  it('re-throws unexpected IAM errors', async () => {
    iamMock
      .on(GetRoleCommand)
      .rejects(Object.assign(new Error('Service error'), { name: 'ServiceException' }))
    await expect(new AwsAdapter(CONFIG).teardownOidcRole('my-app')).rejects.toThrow('Service error')
  })
})

// ─── teardownTerraformBackend ─────────────────────────────────────────────────

describe('teardownTerraformBackend', () => {
  it('skips when the bucket does not exist', async () => {
    s3Mock.on(HeadBucketCommand).rejects({ name: 'NotFound' })

    await new AwsAdapter(CONFIG).teardownTerraformBackend('my-app')

    expect(s3Mock).not.toHaveReceivedCommand(DeleteBucketCommand)
  })

  it('empties and deletes a bucket with versioned objects', async () => {
    s3Mock.on(HeadBucketCommand).resolves({})
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: 'terraform.tfstate', VersionId: 'v1' }],
      DeleteMarkers: [{ Key: 'terraform.tfstate', VersionId: 'dm1' }],
      IsTruncated: false,
    })
    s3Mock.on(DeleteObjectsCommand).resolves({})
    s3Mock.on(DeleteBucketCommand).resolves({})

    await new AwsAdapter(CONFIG).teardownTerraformBackend('my-app')

    expect(s3Mock).toHaveReceivedCommandWith(DeleteObjectsCommand, {
      Bucket: 'my-app-terraform-state-123456789012',
      Delete: {
        Objects: [
          { Key: 'terraform.tfstate', VersionId: 'v1' },
          { Key: 'terraform.tfstate', VersionId: 'dm1' },
        ],
      },
    })
    expect(s3Mock).toHaveReceivedCommandWith(DeleteBucketCommand, {
      Bucket: 'my-app-terraform-state-123456789012',
    })
  })

  it('deletes an empty bucket without calling DeleteObjects', async () => {
    s3Mock.on(HeadBucketCommand).resolves({})
    s3Mock
      .on(ListObjectVersionsCommand)
      .resolves({ Versions: [], DeleteMarkers: [], IsTruncated: false })
    s3Mock.on(DeleteBucketCommand).resolves({})

    await new AwsAdapter(CONFIG).teardownTerraformBackend('my-app')

    expect(s3Mock).not.toHaveReceivedCommand(DeleteObjectsCommand)
    expect(s3Mock).toHaveReceivedCommand(DeleteBucketCommand)
  })
})

// ─── invokeLambda ────────────────────────────────────────────────────────────

describe('invokeLambda', () => {
  it('invokes the function with the given payload and returns ok:true with the parsed body on success', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: new TextEncoder().encode(
        JSON.stringify({ ok: true, applied: ['000_first.sql'], skipped: [] }),
      ),
    })

    const result = await new AwsAdapter(CONFIG).invokeLambda('my-app-dev-core-api', {
      source: 'biffo:ddl-import',
      directory: 'tabsii',
    })

    expect(result).toEqual({
      ok: true,
      body: { ok: true, applied: ['000_first.sql'], skipped: [] },
    })
    expect(lambdaMock).toHaveReceivedCommandWith(InvokeCommand, {
      FunctionName: 'my-app-dev-core-api',
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ source: 'biffo:ddl-import', directory: 'tabsii' })),
    })
  })

  it('returns ok:false with the parsed error payload when Lambda reports FunctionError', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode(
        JSON.stringify({ errorMessage: 'boom', errorType: 'ValueError' }),
      ),
    })

    const result = await new AwsAdapter(CONFIG).invokeLambda('my-app-dev-core-api', {
      source: 'biffo:ddl-import',
      directory: 'does-not-exist',
    })

    expect(result.ok).toBe(false)
    expect(result.body).toEqual({ errorMessage: 'boom', errorType: 'ValueError' })
  })

  it('falls back to a raw-text body when the payload is not valid JSON', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: new TextEncoder().encode('not json'),
    })

    const result = await new AwsAdapter(CONFIG).invokeLambda('my-app-dev-core-api', {
      source: 'biffo:ddl-import',
      directory: 'tabsii',
    })

    expect(result.body).toEqual({ raw: 'not json' })
  })
})
