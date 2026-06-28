import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { BiffoConfig } from '../../../config/schema.js'
import { log } from '../../../lib/logger.js'

export class AwsAdapter {
  private region: string
  private accountId: string

  constructor(config: BiffoConfig) {
    const awsConfig = (
      config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }
    ).config
    this.region = awsConfig.region
    this.accountId = awsConfig.account_id
  }

  async verifyCredentials(): Promise<void> {
    const sts = new STSClient({ region: this.region })
    const identity = await sts.send(new GetCallerIdentityCommand({}))
    if (identity.Account !== this.accountId) {
      throw new Error(
        `AWS credentials resolve to account ${identity.Account}, expected ${this.accountId}`,
      )
    }
    log.success(`AWS credentials verified for account ${this.accountId}`)
  }

  async bootstrapTerraformBackend(projectName: string): Promise<void> {
    const s3 = new S3Client({ region: this.region })
    const bucketName = `${projectName}-terraform-state-${this.accountId}`

    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }))
      log.info(`Terraform state bucket already exists — skipping`)
      return
    } catch {
      /* doesn't exist yet */
    }

    log.info(`Creating Terraform state bucket: ${bucketName}`)
    await s3.send(new CreateBucketCommand({ Bucket: bucketName }))
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    )
    log.success('Terraform backend bootstrapped')
  }

  async teardownOidcRole(projectName: string): Promise<void> {
    const iam = new IAMClient({ region: this.region })
    const roleName = `biffo-github-actions-${projectName}`

    try {
      await iam.send(new GetRoleCommand({ RoleName: roleName }))
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'NoSuchEntityException') {
        log.info(`IAM role does not exist — skipping`)
        return
      }
      throw err
    }

    log.info(`Deleting IAM role: ${roleName}`)

    const { AttachedPolicies } = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: roleName }),
    )
    for (const policy of AttachedPolicies ?? []) {
      await iam.send(
        new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.PolicyArn! }),
      )
    }

    const { PolicyNames } = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }))
    for (const name of PolicyNames ?? []) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name }))
    }

    await iam.send(new DeleteRoleCommand({ RoleName: roleName }))
    log.success(`IAM role deleted: ${roleName}`)
  }

  async teardownTerraformBackend(projectName: string): Promise<void> {
    const s3 = new S3Client({ region: this.region })
    const bucketName = `${projectName}-terraform-state-${this.accountId}`

    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }))
    } catch {
      log.info(`Terraform state bucket does not exist — skipping`)
      return
    }

    log.info(`Emptying and deleting Terraform state bucket: ${bucketName}`)

    // Delete all versions and delete markers (required before bucket deletion when versioning is on)
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined

    do {
      const { Versions, DeleteMarkers, NextKeyMarker, NextVersionIdMarker, IsTruncated } =
        await s3.send(
          new ListObjectVersionsCommand({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        )

      const objects = [
        ...(Versions ?? []).map((v) => ({ Key: v.Key!, VersionId: v.VersionId! })),
        ...(DeleteMarkers ?? []).map((d) => ({ Key: d.Key!, VersionId: d.VersionId! })),
      ]

      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects } }),
        )
      }

      keyMarker = IsTruncated ? NextKeyMarker : undefined
      versionIdMarker = IsTruncated ? NextVersionIdMarker : undefined
    } while (keyMarker)

    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }))
    log.success(`Terraform state bucket deleted: ${bucketName}`)
  }

  async setupOidcTrust(config: BiffoConfig): Promise<string> {
    const { org, repo } = (
      config.source_control as { provider: 'github'; config: { org: string; repo: string } }
    ).config
    const iam = new IAMClient({ region: this.region })
    const roleName = `biffo-github-actions-${config.project.name}`

    // If the role already exists (e.g. previous partial init), return its ARN
    try {
      const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName }))
      log.info(`OIDC role already exists — skipping creation`)
      return Role!.Arn!
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'NoSuchEntityException') throw err
    }

    log.info(`Creating OIDC trust role: ${roleName}`)

    const trustPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Federated: `arn:aws:iam::${this.accountId}:oidc-provider/token.actions.githubusercontent.com`,
          },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${org}/${repo}:*` },
          },
        },
      ],
    })

    const { Role } = await iam.send(
      new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: trustPolicy }),
    )

    const roleArn = Role!.Arn!
    log.success(`OIDC role created: ${roleArn}`)
    return roleArn
  }
}
