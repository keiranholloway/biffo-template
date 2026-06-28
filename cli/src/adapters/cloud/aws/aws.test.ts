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
} from '@aws-sdk/client-iam'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { BiffoConfigSchema } from '../../../config/schema.js'
import { AwsAdapter } from './index.js'

const stsMock = mockClient(STSClient)
const iamMock = mockClient(IAMClient)
const s3Mock = mockClient(S3Client)

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

  it('returns existing ARN without creating when role already exists', async () => {
    iamMock.on(GetRoleCommand).resolves({
      Role: { Arn: 'arn:aws:iam::123456789012:role/biffo-github-actions-my-app' } as never,
    })

    const arn = await new AwsAdapter(CONFIG).setupOidcTrust(CONFIG)
    expect(arn).toBe('arn:aws:iam::123456789012:role/biffo-github-actions-my-app')
    expect(iamMock).not.toHaveReceivedCommand(CreateRoleCommand)
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
