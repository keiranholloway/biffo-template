import { z } from 'zod'
import { CloudConfigSchema, SourceControlConfigSchema } from './schema.js'

// Deliberately separate from BiffoConfigSchema, not bolted onto it (ADR-0007)
// — a sibling has no admin/database/modules block of its own (no Cognito
// pool, no CloudFront distribution, no Postgres schema: those belong to
// whichever core project it's paired with). Its identity fields
// (source_control/cloud) reuse the exact same shapes as the core project's
// own config, since it's provisioned the same way (its own GitHub repo, its
// own AWS account/region).
export const SiblingConfigSchema = z
  .object({
    $schema: z.string().optional(),
    project: z.object({
      name: z
        .string()
        .min(1)
        .regex(
          /^[a-z][a-z0-9-]*$/,
          'Must be lowercase kebab-case, starting with a letter (it becomes a URL path segment)',
        ),
      description: z.string().default(''),
    }),
    source_control: SourceControlConfigSchema,
    cloud: CloudConfigSchema,
    environments: z
      .array(z.enum(['dev', 'staging', 'prod']))
      .min(1)
      .default(['dev', 'staging', 'prod']),
    // The core project this sibling is paired with (ADR-0007) — never
    // provisions its own Cognito pool or CloudFront distribution, always
    // plugs into the core project's.
    core: z.object({
      // Exactly one of these two must be set — see the superRefine below.
      project_name: z
        .string()
        .min(1)
        .optional()
        .describe('Name of a project previously scaffolded with `biffo init` on this machine'),
      config_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Path to the core project's biffo.config.json, for when it wasn't scaffolded here",
        ),
      // Defaults to project.name at parse time by the caller (sibling-create.ts),
      // not here — z.object() has no access to sibling fields from within core's
      // own schema without restructuring the whole object, and the caller
      // already has both values in hand when it validates.
      path_prefix: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/, 'Must be lowercase kebab-case')
        .optional(),
    }),
  })
  .superRefine((config, ctx) => {
    if (!config.core.project_name && !config.core.config_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['core'],
        message: 'Either core.project_name or core.config_path is required',
      })
    }
  })

export type SiblingConfig = z.infer<typeof SiblingConfigSchema>
