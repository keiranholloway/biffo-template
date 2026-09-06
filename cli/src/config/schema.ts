import { z } from 'zod'

// Exported so cli/src/config/sibling-schema.ts (ADR-0007) can reuse the exact
// same source_control/cloud shapes — a sibling's identity config is a
// deliberately smaller, separate schema (no admin/database/modules), but
// its GitHub/AWS identity fields are identical to the core project's.
export const AwsConfigSchema = z.object({
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

export const GitHubConfigSchema = z.object({
  org: z.string().min(1).describe('GitHub organisation or username'),
  repo: z.string().min(1).describe('Repository name (will be created)'),
})

export const SourceControlConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), config: GitHubConfigSchema }),
])

export const CloudConfigSchema = z.discriminatedUnion('provider', [
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

// Issue #1739 option B. `_skeletons/sibling-template` depends only on the
// generic `@biffo/design-tokens`, which ships colour/radius/shadow tokens but
// deliberately NO type scale (packages/design-tokens/bin/scale-guard.mjs
// explains why: a generic Biffo scale is a design decision nobody has made,
// and biffo-template must not smuggle one in). An instance that HAS adopted
// its own scale (Tabsii's `@tabsii-com/ui`) declares it here so every sibling
// `biffo sibling create` scaffolds against this core project inherits it
// automatically, instead of a founder hand-migrating each one after the fact
// the way the first four Tabsii siblings were. Omitting this block is
// unchanged behaviour: a new sibling depends only on `@biffo/design-tokens`,
// exactly as before this option existed.
const DesignTokensSchema = z.object({
  package: z
    .string()
    .min(1)
    .describe(
      'npm package providing this instance\'s real type scale, e.g. "@tabsii-com/ui". ' +
        'Added as an apps/frontend dependency of every new sibling, alongside (not instead ' +
        "of) @biffo/design-tokens -- biffo-scale-guard's own bin still ships from there.",
    ),
  version: z
    .string()
    .min(1)
    .default('*')
    .describe("Version range to pin `package` at in a new sibling's apps/frontend/package.json"),
  path: z
    .string()
    .min(1)
    .describe(
      'Path to the CSS file declaring the --text-*/--space-* scale, relative to the package ' +
        'root (e.g. "dist/tokens.css"). Used for both the new sibling\'s globals.css @import ' +
        "and biffo-scale-guard's --tokens argument.",
    ),
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
    design_tokens: DesignTokensSchema.optional(),
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

// The subset of BiffoConfig that AwsAdapter's identity/OIDC-trust methods and
// GitHubAdapter's branch/environment-provisioning methods actually touch
// (project name, source_control, cloud, environments) — narrowed out so a
// SiblingConfig (ADR-0007), which has no admin/database/modules of its own,
// can still be passed to those methods without a fake full BiffoConfig.
export type ProvisioningConfig = Pick<
  BiffoConfig,
  'project' | 'source_control' | 'cloud' | 'environments'
>

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
