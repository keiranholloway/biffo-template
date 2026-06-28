import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, waitUntilStackCreateComplete } from '@aws-sdk/client-cloudformation'
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam'
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { BiffoConfig } from '../../../config/schema.js'
import { log } from '../../../lib/logger.js'

export class AwsAdapter {
  private region: string
  private accountId: string

  constructor(config: BiffoConfig) {
    const awsConfig = (config.cloud as { provider: 'aws'; config: { account_id: string; region: string } }).config
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

  async setupOidcTrust(config: BiffoConfig): Promise<string> {
    const { org, repo } = (config.source_control as { provider: 'github'; config: { org: string; repo: string } }).config
    const iam = new IAMClient({ region: this.region })
    const roleName = `biffo-github-actions-${config.project.name}`

    log.info(`Creating OIDC trust role: ${roleName}`)

    const trustPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: `arn:aws:iam::${this.accountId}:oidc-provider/token.actions.githubusercontent.com` },
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
