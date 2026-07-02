/**
 * Validation for a plugin's `biffo.plugin.json` manifest.
 *
 * This mirrors — field-for-field — the ground-truth Pydantic models the
 * Core API and biffo-plugin-sdk actually validate against:
 *
 *   - `packages/python-sdk/src/biffo_plugin_sdk/plugin.py`'s
 *     `ColumnDefinition` / `IndexDefinition` / `TableDefinition` /
 *     `RouteDef` / `PluginManifest`
 *   - `services/api/src/api/models/plugin_table.py`'s
 *     `ColumnDefinition` / `IndexDefinition` / `PluginTableDefinition`
 *   - `services/api/src/api/models/plugin_route.py`'s `RouteDefinition`
 *
 * NOT the older `_skeletons/registry/registry-schema.json` shape, which
 * (as of writing) still requires an `api_routes[].handler` free-form
 * function-name field — that predates issue #19's declarative
 * table/operation CRUD-synthesis design and no longer matches what the
 * Core API (or the SDK) actually parses. The CLI validates against the
 * real, currently-enforced shape so a manifest that passes here is
 * guaranteed to also pass `sync_plugin_migrations()` /
 * `parse_plugin_routes_from_manifest()` at the next db-init, rather than
 * failing there after already being committed to the user's repo.
 *
 * This package can't import the Python models directly (a plugin's CLI
 * install happens outside any Python environment), so the duplication is
 * unavoidable — same rationale the Python side already documents for why
 * biffo-plugin-sdk duplicates the Core API's models. If any of the three
 * Python sources above change, update this file too.
 */
import { z } from 'zod'

// Mirrors _AUTO_COLUMN_NAMES in plugin_table.py / plugin.py — these columns
// are injected automatically by the Core API (id, tenant_id, created_at,
// updated_at) and must not be redeclared, since doing so could silently
// weaken the tenant-isolation guarantee (ADR-0001).
const RESERVED_COLUMN_NAMES = new Set(['id', 'tenant_id', 'created_at', 'updated_at'])

// Mirrors plugin_table.py's _TYPE_MAP — the only base types the Core API
// actually resolves into SQLAlchemy columns. Anything else silently falls
// back to String there, so this schema rejects it up front instead.
const COLUMN_TYPE_PATTERN = /^(String|Integer|Text|Boolean|Float|DateTime)(\(.*\))?$/

const ColumnDefinitionSchema = z.object({
  name: z.string().refine(
    (n) => !RESERVED_COLUMN_NAMES.has(n),
    (n) => ({
      message: `Column '${n}' is reserved and added automatically; it must not be declared in the manifest.`,
    }),
  ),
  type: z
    .string()
    .regex(
      COLUMN_TYPE_PATTERN,
      "must be one of String, Integer, Text, Boolean, Float, DateTime (e.g. 'String(255)')",
    ),
  primary_key: z.boolean().default(false),
  nullable: z.boolean().default(false),
  index: z.boolean().default(false),
  default: z.string().optional(),
  description: z.string().default(''),
})

const IndexDefinitionSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()).min(1),
  unique: z.boolean().default(false),
})

const TableDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'table name must be snake_case, e.g. rbac_roles'),
    columns: z.array(ColumnDefinitionSchema).default([]),
    indexes: z.array(IndexDefinitionSchema).default([]),
  })
  .superRefine((table, ctx) => {
    const colCounts = new Map<string, number>()
    for (const c of table.columns) colCounts.set(c.name, (colCounts.get(c.name) ?? 0) + 1)
    for (const [name, count] of colCounts) {
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate column name '${name}' in table '${table.name}'`,
        })
      }
    }

    const idxCounts = new Map<string, number>()
    for (const i of table.indexes) idxCounts.set(i.name, (idxCounts.get(i.name) ?? 0) + 1)
    for (const [name, count] of idxCounts) {
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate index name '${name}' in table '${table.name}'`,
        })
      }
    }

    const validColumns = new Set(table.columns.map((c) => c.name))
    for (const idx of table.indexes) {
      for (const col of idx.columns) {
        if (!validColumns.has(col)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Index '${idx.name}' on table '${table.name}' references unknown column '${col}'`,
          })
        }
      }
    }
  })

// Mirrors _OPERATION_METHODS / _SINGLE_ROW_OPERATIONS in plugin_route.py.
const OPERATION_METHODS: Record<string, ReadonlySet<string>> = {
  list: new Set(['GET']),
  read: new Set(['GET']),
  create: new Set(['POST']),
  update: new Set(['PUT', 'PATCH']),
  delete: new Set(['DELETE']),
}
const SINGLE_ROW_OPERATIONS = new Set(['read', 'update', 'delete'])

const RouteDefSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/', "path must start with '/'"),
    table: z.string(),
    operation: z.enum(['list', 'read', 'create', 'update', 'delete']),
    description: z.string().default(''),
  })
  .superRefine((route, ctx) => {
    const allowed = OPERATION_METHODS[route.operation]
    if (allowed && !allowed.has(route.method)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `operation '${route.operation}' requires method in [${[...allowed].sort().join(', ')}], got '${route.method}'`,
      })
    }

    const hasId = route.path.includes('{id}')
    const needsId = SINGLE_ROW_OPERATIONS.has(route.operation)
    if (needsId && !hasId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `operation '${route.operation}' addresses a single row and requires an '{id}' path parameter: ${route.path}`,
      })
    }
    if (!needsId && hasId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `operation '${route.operation}' is collection-level and must not have an '{id}' path parameter: ${route.path}`,
      })
    }
  })

export const PluginManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase kebab-case slug'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a full semver, e.g. 1.2.3'),
    description: z.string().default(''),
    author: z.string().default('Biffo Team'),
    tags: z.array(z.string()).default([]),
    tables: z.array(TableDefinitionSchema).default([]),
    api_routes: z.array(RouteDefSchema).default([]),
    required_core_version: z.string().default('>=0.0.0'),
  })
  .superRefine((manifest, ctx) => {
    const tableNames = new Set(manifest.tables.map((t) => t.name))
    for (const route of manifest.api_routes) {
      if (!tableNames.has(route.table)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Route ${route.method} ${route.path} references table '${route.table}', ` +
            `which is not declared in this manifest's 'tables' (${[...tableNames].sort().join(', ') || 'none'})`,
        })
      }
    }
  })

export type PluginManifest = z.infer<typeof PluginManifestSchema>

/**
 * Parse and validate a plugin manifest, throwing a descriptive Error on
 * failure rather than a raw ZodError — the CLI surfaces this message
 * directly to the user.
 */
export function validateManifest(raw: unknown): PluginManifest {
  const result = PluginManifestSchema.safeParse(raw)
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.')
        return path ? `${path}: ${issue.message}` : issue.message
      })
      .join('; ')
    throw new Error(messages)
  }
  return result.data
}
