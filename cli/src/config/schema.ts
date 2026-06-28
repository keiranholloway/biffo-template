import { z } from 'zod'

const AwsConfigSchema = z.object({
  account_id: z
    .string()
    .regex(/^\d{12}$/, 'AWS account ID must be 12 digits')
    .describe('12-digit AWS account ID'),
  region: z.string().default('us-east-1'),
  oidc_role_arn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/.+/, 'Must be a valid IAM role ARN')
    .optional(),
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

export const BiffoConfigSchema = z.object({
  $schema: z.string().optional(),
  project: z.object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Must be lowercase kebab-case'),
    description: z.string().default(''),
    domain: z.string().min(1).describe('Primary domain, e.g. myapp.com'),
  }),
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

export type BiffoConfig = z.infer<typeof BiffoConfigSchema>
