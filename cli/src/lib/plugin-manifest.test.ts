import { describe, expect, it } from 'vitest'
import { validateManifest } from './plugin-manifest.js'

// The exact worked example ADR-0003 §2 committed after #69's correction —
// verified there to round-trip against biffo_plugin_sdk.plugin.PluginManifest
// and api.models.plugin_table.PluginTableDefinition. Used here (trimmed to
// one table) so this test asserts against the same ground truth as the
// Python side, not a shape invented independently for this file.
function validManifest() {
  return {
    name: 'rbac',
    version: '1.0.0',
    description: 'Fine-grained role-based access control.',
    author: 'Biffo Team',
    tags: ['auth', 'security'],
    tables: [
      {
        name: 'rbac_roles',
        columns: [
          { name: 'name', type: 'String(100)', nullable: false },
          { name: 'description', type: 'Text', nullable: true },
        ],
        indexes: [{ name: 'ix_rbac_roles_name', columns: ['name'], unique: true }],
      },
    ],
    api_routes: [
      {
        method: 'GET',
        path: '/roles',
        table: 'rbac_roles',
        operation: 'list',
      },
      {
        method: 'GET',
        path: '/roles/{id}',
        table: 'rbac_roles',
        operation: 'read',
      },
    ],
  }
}

describe('validateManifest — happy path', () => {
  it('accepts a well-formed manifest', () => {
    const manifest = validateManifest(validManifest())
    expect(manifest.name).toBe('rbac')
    expect(manifest.tables).toHaveLength(1)
    expect(manifest.api_routes).toHaveLength(2)
  })

  it('applies defaults for optional fields', () => {
    const manifest = validateManifest({ name: 'minimal', version: '0.1.0' })
    expect(manifest.description).toBe('')
    expect(manifest.author).toBe('Biffo Team')
    expect(manifest.tags).toEqual([])
    expect(manifest.tables).toEqual([])
    expect(manifest.api_routes).toEqual([])
    expect(manifest.required_core_version).toBe('>=0.0.0')
  })
})

describe('validateManifest — top-level fields', () => {
  it('rejects a name that is not lowercase kebab-case', () => {
    expect(() => validateManifest({ name: 'RBAC_plugin', version: '1.0.0' })).toThrow()
  })

  it('rejects a version that is not full semver', () => {
    expect(() => validateManifest({ name: 'rbac', version: '1.0' })).toThrow()
  })

  it('rejects a missing name', () => {
    expect(() => validateManifest({ version: '1.0.0' })).toThrow()
  })
})

describe('validateManifest — reserved auto-columns', () => {
  it.each(['id', 'tenant_id', 'created_at', 'updated_at'])(
    "rejects a manifest that declares the reserved column '%s'",
    (reservedName) => {
      const manifest = validManifest()
      manifest.tables[0]!.columns.push({ name: reservedName, type: 'String(36)' })
      expect(() => validateManifest(manifest)).toThrow(/reserved/)
    },
  )
})

describe('validateManifest — column types', () => {
  it('rejects a PostgreSQL-enum type instead of a SQLAlchemy constructor string', () => {
    const manifest = validManifest()
    manifest.tables[0]!.columns.push({ name: 'external_id', type: 'UUID' })
    expect(() => validateManifest(manifest)).toThrow()
  })

  it.each(['String(255)', 'Integer', 'Text', 'Boolean', 'Float', 'DateTime(timezone=True)'])(
    "accepts the base type '%s'",
    (type) => {
      const manifest = validManifest()
      manifest.tables[0]!.columns.push({ name: 'extra_col', type })
      expect(() => validateManifest(manifest)).not.toThrow()
    },
  )
})

describe('validateManifest — duplicate names', () => {
  it('rejects duplicate column names within a table', () => {
    const manifest = validManifest()
    manifest.tables[0]!.columns.push({ name: 'name', type: 'String(50)' })
    expect(() => validateManifest(manifest)).toThrow(/Duplicate column name/)
  })

  it('rejects duplicate index names within a table', () => {
    const manifest = validManifest()
    manifest.tables[0]!.indexes.push({ name: 'ix_rbac_roles_name', columns: ['description'] })
    expect(() => validateManifest(manifest)).toThrow(/Duplicate index name/)
  })

  it('rejects an index referencing an unknown column', () => {
    const manifest = validManifest()
    manifest.tables[0]!.indexes.push({ name: 'ix_bogus', columns: ['nonexistent'] })
    expect(() => validateManifest(manifest)).toThrow(/unknown column/)
  })
})

describe('validateManifest — routes', () => {
  it('rejects a route referencing a table not declared in this manifest', () => {
    const manifest = validManifest()
    manifest.api_routes.push({
      method: 'GET',
      path: '/widgets',
      table: 'widgets',
      operation: 'list',
    })
    expect(() => validateManifest(manifest)).toThrow(/not declared/)
  })

  it("rejects a 'create' route using GET instead of POST", () => {
    const manifest = validManifest()
    manifest.api_routes.push({
      method: 'GET',
      path: '/roles',
      table: 'rbac_roles',
      operation: 'create',
    })
    expect(() => validateManifest(manifest)).toThrow(/requires method/)
  })

  it("rejects a 'read' route missing the {id} path parameter", () => {
    const manifest = validManifest()
    manifest.api_routes.push({
      method: 'GET',
      path: '/roles',
      table: 'rbac_roles',
      operation: 'read',
    })
    expect(() => validateManifest(manifest)).toThrow(/requires an '\{id\}'/)
  })

  it("rejects a 'list' route that includes an {id} path parameter", () => {
    const manifest = validManifest()
    manifest.api_routes.push({
      method: 'GET',
      path: '/roles/{id}',
      table: 'rbac_roles',
      operation: 'list',
    })
    expect(() => validateManifest(manifest)).toThrow(/must not have an '\{id\}'/)
  })

  it('rejects a route path that does not start with /', () => {
    const manifest = validManifest()
    manifest.api_routes.push({
      method: 'GET',
      path: 'roles',
      table: 'rbac_roles',
      operation: 'list',
    })
    expect(() => validateManifest(manifest)).toThrow()
  })
})
