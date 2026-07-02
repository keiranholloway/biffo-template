import { z } from 'zod'

const AwsConfigSchema = z.object({
  account_id: z
    .string()
    .regex(/^\d{12}$/, 'AWS account ID must be 12 digits')
    .describe('12-digit AWS account ID'),
  region: z.string().default('us-east-1'),
  profile: z.string().optional(),
  oidc_role_arn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/.+/, 'Must be a valid IAM role ARN')
    .optional(),
  tf_state_bucket: z.string().optional(),
})

const GitHubConfigSchema = z.object({
  org: z.string().min(1).describe('GitHub organisation or username'),
  repo: z.string().min(1).describe('Repository name (will be created)'),
})

const SourceControlConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), config: GitHubConfigSchema }),
])

const CloudConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('aws'), config: AwsConfigSchema }),
])

const ModulesSchema = z.object({
  auth: z.enum(['cognito']).default('cognito'),
  events: z.enum(['eventbridge']).default('eventbridge'),
  storage: z.enum(['s3']).default('s3'),
  database: z.enum(['postgresql']).default('postgresql'),
  compute: z.enum(['lambda']).default('lambda'),
  cdn: z.enum(['cloudfront']).default('cloudfront'),
})

const DnsSchema = z.object({
  mode: z.enum(['managed-route53', 'external', 'none']).default('managed-route53'),
  domain: z.string().min(1).optional(),
})

export const BiffoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    project: z.object({
      name: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, 'Must be lowercase kebab-case'),
      description: z.string().default(''),
      // Backward compatibility for existing configs. New configs should use dns.domain.
      domain: z.string().min(1).optional().describe('Primary domain, e.g. myapp.com'),
    }),
    dns: DnsSchema.optional(),
    source_control: SourceControlConfigSchema,
    cloud: CloudConfigSchema,
    environments: z
      .array(z.enum(['dev', 'staging', 'prod']))
      .min(1)
      .default(['dev']),
    admin: z.object({
      email: z.string().email(),
      username: z.string().min(1),
    }),
    database: z
      .object({
        schema_path: z.string().nullable().default(null),
        migrations_path: z.string().default('services/api/migrations'),
      })
      .default({}),
    modules: ModulesSchema.default({}),
  })
  .superRefine((config, ctx) => {
    const dns = resolveDnsConfig(config)
    if (dns.mode !== 'none' && !dns.domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dns', 'domain'],
        message: 'DNS domain is required unless dns.mode is "none"',
      })
    }
  })

export type BiffoConfig = z.infer<typeof BiffoConfigSchema>
export type DnsMode = 'managed-route53' | 'external' | 'none'

export function resolveDnsConfig(config: {
  project: { domain?: string | undefined }
  dns?: { mode?: DnsMode | undefined; domain?: string | undefined } | undefined
}): { mode: DnsMode; domain: string } {
  const legacyDomain = config.project.domain ?? ''
  const mode = config.dns?.mode ?? (legacyDomain ? 'managed-route53' : 'none')
  const domain = config.dns?.domain ?? legacyDomain

  return {
    mode,
    domain: mode === 'none' ? '' : domain,
  }
}
