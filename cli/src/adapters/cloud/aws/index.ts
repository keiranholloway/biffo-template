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
  UpdateAssumeRolePolicyCommand,
  UpdateRoleCommand,
} from '@aws-sdk/client-iam'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
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
import type { ProvisioningConfig } from '../../../config/schema.js'
import { log } from '../../../lib/logger.js'

/**
 * The `token.actions.githubusercontent.com:sub` patterns a Biffo OIDC role
 * trusts, for workflows in exactly one GitHub repository.
 *
 * GitHub emits one of two subject formats depending on the account:
 *
 *   legacy:         repo:<org>/<repo>:ref:refs/heads/main
 *   ID-qualified:   repo:<org>@<ownerId>/<repo>@<repoId>:ref:refs/heads/main
 *
 * The ID-qualified ("immutable unique") form appends the numeric owner and
 * repository IDs so the claim survives org and repo renames. A policy matching
 * only the legacy form denies every assume-role on an account emitting the
 * ID-qualified one — the defect in issue #271, which blocked every deploy of a
 * freshly scaffolded project.
 *
 * Both patterns are emitted so the role works whichever format the account
 * issues, and the IDs are *pinned* rather than wildcarded (`@*`) because they
 * are knowable at init time and pinning is what the immutable format is for.
 * The trailing `:*` spans the claim's ref/environment/pull_request suffix — the
 * same breadth the legacy pattern always had. Neither pattern can match another
 * repository: the org/repo segment is fully anchored in both.
 */
export function oidcSubjectPatterns(
  org: string,
  repo: string,
  repoIds?: { ownerId: number; repoId: number },
): string[] {
  const patterns = [`repo:${org}/${repo}:*`]
  if (repoIds) {
    patterns.push(`repo:${org}@${repoIds.ownerId}/${repo}@${repoIds.repoId}:*`)
  }
  return patterns
}

/** Assume-role policy document trusting `subjects` via the GitHub OIDC provider. */
export function buildOidcTrustPolicy(oidcProviderArn: string, subjects: string[]): unknown {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: oidcProviderArn },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': subjects },
        },
      },
    ],
  }
}

export class AwsAdapter {
  private region: string
  private accountId: string

  constructor(config: ProvisioningConfig) {
    const awsConfig = (
      config.cloud as {
        provider: 'aws'
        config: { account_id: string; region: string; profile?: string }
      }
    ).config
    if (awsConfig.profile) {
      process.env['AWS_PROFILE'] = awsConfig.profile
      process.env['AWS_DEFAULT_PROFILE'] = awsConfig.profile
      process.env['AWS_SDK_LOAD_CONFIG'] = '1'
    }
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
        // A non-trivial current state file (>200 bytes) means resources were deployed
        const current = (Versions ?? []).find((v) => v.IsLatest)
        const hasResources = (current?.Size ?? 0) > 200
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

  /**
   * Set up OIDC trust between GitHub Actions and AWS.
   *
   * `repoIds` are the immutable numeric GitHub owner/repo IDs, resolved by the
   * source-control adapter (`GitHubAdapter.getRepoIds`) and passed in as plain
   * numbers so this adapter never talks to GitHub itself. Supply them whenever
   * they are obtainable: without them the trust policy can only match the
   * legacy subject format, and on any account where GitHub emits ID-qualified
   * subjects every deploy fails `AccessDenied` (issue #271).
   */
  async setupOidcTrust(
    config: ProvisioningConfig,
    repoIds?: { ownerId: number; repoId: number },
  ): Promise<string> {
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

    // deploy-global.yml requests a 7200s session to cover its inline wait for DNS
    // delegation to propagate before requesting the ACM certificate — the role's
    // MaxSessionDuration must allow at least that (AWS default is 3600s).
    const maxSessionDuration = 7200

    const subjects = oidcSubjectPatterns(org, repo, repoIds)
    const trustPolicy = JSON.stringify(buildOidcTrustPolicy(oidcProviderArn, subjects))
    if (!repoIds) {
      log.warn(
        'GitHub owner/repo IDs unavailable — trusting only the legacy subject format. ' +
          'If deploys fail with sts:AssumeRoleWithWebIdentity AccessDenied, re-run `biffo init` ' +
          'to add the ID-qualified subject (see issue #271).',
      )
    }

    // Create the role if it doesn't already exist
    let roleArn: string
    try {
      const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName }))
      log.info(`OIDC role already exists`)
      roleArn = Role!.Arn!
      if (Role!.MaxSessionDuration !== maxSessionDuration) {
        await iam.send(
          new UpdateRoleCommand({ RoleName: roleName, MaxSessionDuration: maxSessionDuration }),
        )
      }
      // Re-assert the trust policy on every run. A role provisioned by an older
      // CLI trusts only `repo:<org>/<repo>:*`, which cannot match GitHub's
      // ID-qualified subject format — re-running `biffo init` is what repairs it
      // (issue #271). UpdateAssumeRolePolicy replaces the document wholesale, so
      // this converges an existing role onto exactly the patterns above.
      await iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: roleName,
          PolicyDocument: trustPolicy,
        }),
      )
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'NoSuchEntityException') throw err

      log.info(`Creating OIDC trust role: ${roleName}`)
      const { Role } = await iam.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: trustPolicy,
          MaxSessionDuration: maxSessionDuration,
        }),
      )
      roleArn = Role!.Arn!
    }

    // Record exactly what the role trusts. When an OIDC assume-role is denied,
    // neither the action nor CloudTrail names the presented `sub` — having the
    // trusted patterns in the init output is what makes the mismatch legible.
    subjects.forEach((s) => log.info(`  Trusted OIDC subject: ${s}`))

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

  /**
   * Synchronously invokes `functionName` with `payload` as its JSON event
   * body, for one-off administrative calls into the Core API Lambda (e.g.
   * `biffo data apply`'s `"biffo:ddl-import"` event) — not a general-purpose
   * invoke helper for hot-path/high-volume use.
   *
   * `ok` is `false` when Lambda reports `FunctionError` (the handler itself
   * raised) — matching exactly how deploy-app.yml's own
   * `if echo "$RESULT" | grep -q FunctionError` shell check already treats
   * this. `body` is the parsed JSON response payload either way: on success
   * that's the handler's return value (e.g. `{ok, applied, skipped}`), on
   * failure it's Lambda's own error envelope (`errorMessage`, `errorType`,
   * `stackTrace`).
   */
  async invokeLambda(
    functionName: string,
    payload: unknown,
  ): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const lambda = new LambdaClient({ region: this.region })
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    )

    const rawBody = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : '{}'
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      body = { raw: rawBody }
    }

    return { ok: !response.FunctionError, body }
  }
}
