import {
  AttachRolePolicyCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
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

  async bootstrapTerraformBackend(projectName: string): Promise<string> {
    const s3 = new S3Client({ region: this.region })
    const primaryName = `${projectName}-terraform-state-${this.accountId}`

    // Try up to 5 name variants so teardown→reinit cycles don't block on the same
    // name being held in S3's global namespace after deletion.
    const variants = Array.from({ length: 5 }, (_, i) =>
      i === 0 ? primaryName : `${primaryName}-v${i + 1}`,
    )

    // Check if any variant already exists (idempotent re-runs)
    for (const name of variants) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: name }))
        log.info(`Terraform state bucket already exists — skipping (${name})`)
        return name
      } catch {
        /* not found or no access — try next */
      }
    }

    // Try to create each variant in order; skip to next on OperationAborted
    for (const name of variants) {
      log.info(`Creating Terraform state bucket: ${name}`)
      const createParams =
        this.region === 'us-east-1'
          ? { Bucket: name }
          : {
              Bucket: name,
              CreateBucketConfiguration: { LocationConstraint: this.region as never },
            }

      const created = await this.tryCreateBucket(s3, name, createParams)
      if (!created) {
        log.info(`  Bucket name "${name}" still reserved by AWS — trying next variant...`)
        continue
      }

      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: name,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      )
      log.success(`Terraform backend bootstrapped (${name})`)
      return name
    }

    throw new Error(
      `Could not create Terraform state bucket after trying ${variants.length} name variants.\n` +
        `  S3 is holding all names from recent deletions. Wait a few minutes and re-run \`biffo init\`.`,
    )
  }

  private async tryCreateBucket(
    s3: S3Client,
    bucketName: string,
    createParams: { Bucket: string; CreateBucketConfiguration?: { LocationConstraint: never } },
  ): Promise<boolean> {
    // Retry for 2 minutes on OperationAborted (S3 deletion propagation), then give up
    // so the caller can try the next name variant.
    const maxAttempts = 24
    const retryDelayMs = 5_000
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await s3.send(new CreateBucketCommand(createParams))
        return true
      } catch (err: unknown) {
        const code = (err as { Code?: string }).Code
        if (code === 'OperationAborted' && attempt < maxAttempts) {
          log.info(`  Waiting for S3 to release "${bucketName}"... (${attempt}/${maxAttempts})`)
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        } else if (code === 'OperationAborted') {
          return false
        } else {
          throw err
        }
      }
    }
    return false
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

  async listDeployedEnvironments(bucketName: string): Promise<string[]> {
    const s3 = new S3Client({ region: this.region })
    const deployed: string[] = []
    for (const env of ['dev', 'staging', 'prod', 'global']) {
      try {
        const { Versions } = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: bucketName,
            Prefix: `${env}/terraform.tfstate`,
          }),
        )
        // A non-trivial state file (>200 bytes) means resources were deployed
        const hasResources = (Versions ?? []).some((v) => (v.Size ?? 0) > 200)
        if (hasResources) deployed.push(env)
      } catch {
        // bucket may not exist yet — fine
      }
    }
    return deployed
  }

  async teardownTerraformBackend(projectName: string, knownBucket?: string): Promise<void> {
    const s3 = new S3Client({ region: this.region })
    const primaryName = `${projectName}-terraform-state-${this.accountId}`

    // Find whichever variant actually exists (check known name first, then primary + variants)
    const candidates = [
      ...(knownBucket ? [knownBucket] : []),
      primaryName,
      ...Array.from({ length: 4 }, (_, i) => `${primaryName}-v${i + 2}`),
    ]

    let bucketName: string | undefined
    for (const name of candidates) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: name }))
        bucketName = name
        break
      } catch {
        /* not found — try next */
      }
    }

    if (!bucketName) {
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
    const oidcProviderArn = `arn:aws:iam::${this.accountId}:oidc-provider/token.actions.githubusercontent.com`

    // Ensure the GitHub OIDC identity provider exists in this account.
    // This is an account-level resource — only one is needed regardless of how many roles use it.
    try {
      await iam.send(
        new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: oidcProviderArn }),
      )
      log.info('GitHub OIDC provider already exists in account')
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'NoSuchEntityException') throw err
      log.info('Creating GitHub OIDC identity provider in AWS account...')
      await iam.send(
        new CreateOpenIDConnectProviderCommand({
          Url: 'https://token.actions.githubusercontent.com',
          ClientIDList: ['sts.amazonaws.com'],
          // Thumbprint is required syntactically but AWS no longer validates it
          // (AWS fetches the provider certificate directly since June 2023)
          ThumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
        }),
      )
      log.success('GitHub OIDC provider registered')
    }

    // Create the role if it doesn't already exist
    let roleArn: string
    try {
      const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName }))
      log.info(`OIDC role already exists`)
      roleArn = Role!.Arn!
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'NoSuchEntityException') throw err

      log.info(`Creating OIDC trust role: ${roleName}`)
      const trustPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Federated: oidcProviderArn },
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
      roleArn = Role!.Arn!
    }

    // Always ensure AdministratorAccess is attached — AttachRolePolicy is idempotent
    // (no-op if already attached). Terraform needs broad permissions to provision the
    // full stack: IAM, VPC, RDS, Lambda, Cognito, CloudFront, etc.
    await iam.send(
      new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
      }),
    )

    log.success(`OIDC role ready: ${roleArn}`)
    return roleArn
  }

  async readTerraformOutputs(
    bucketName: string,
    stateKey: string,
  ): Promise<Record<string, string>> {
    const s3 = new S3Client({ region: this.region })
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: stateKey }))
    const body = await response.Body?.transformToString()
    if (!body) throw new Error(`Empty Terraform state at s3://${bucketName}/${stateKey}`)

    const state = JSON.parse(body) as {
      outputs?: Record<string, { value: unknown }>
    }
    return Object.fromEntries(
      Object.entries(state.outputs ?? {})
        .filter(([, v]) => typeof v.value === 'string')
        .map(([k, v]) => [k, v.value as string]),
    )
  }
}
