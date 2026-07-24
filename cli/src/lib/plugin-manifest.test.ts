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

describe('validateManifest — user-facing surfaces (ADR-0018)', () => {
  it('accepts an ADR-0021 app-ref ingress (shared host) + user_frontend', () => {
    const manifest = validateManifest({
      name: 'ideation',
      version: '1.0.0',
      user_ingress: { required_group: 'founder', app: 'ideation.app:app' },
      user_frontend: { dir: 'web/dist', required_group: 'founder' },
    })
    expect(manifest.user_ingress?.app).toBe('ideation.app:app')
    expect(manifest.user_ingress?.handler).toBeUndefined()
    expect(manifest.user_frontend?.dir).toBe('web/dist')
  })

  it('still accepts a legacy handler ingress', () => {
    const manifest = validateManifest({
      name: 'ideation',
      version: '1.0.0',
      user_ingress: { required_group: 'founder', handler: 'ideation.app.handler' },
    })
    expect(manifest.user_ingress?.handler).toBe('ideation.app.handler')
    expect(manifest.user_ingress?.path).toBe('api') // defaulted
  })

  it('rejects a user_ingress with neither app nor handler, and a malformed app-ref', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_ingress: { required_group: 'founder' },
      }),
    ).toThrow(/app.*or.*handler/)
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_ingress: { required_group: 'founder', app: 'nocolon' },
      }),
    ).toThrow(/app reference/)
  })

  it('is absent on an ordinary plugin', () => {
    const manifest = validateManifest({ name: 'rbac', version: '1.0.0' })
    expect(manifest.user_ingress).toBeUndefined()
    expect(manifest.user_frontend).toBeUndefined()
  })

  it('rejects a non-dotted handler, a bad path segment, and an unknown key', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_ingress: { required_group: 'founder', handler: 'nodots' },
      }),
    ).toThrow(/dotted import path/)
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_ingress: { required_group: 'founder', handler: 'a.b', path: 'Bad/Seg' },
      }),
    ).toThrow(/path segment/)
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_frontend: { dir: 'web/dist', required_group: 'founder', extra: true },
      }),
    ).toThrow()
  })
})

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

  it.each(['id', 'tenant_id', 'created_at', 'updated_at'])(
    "accepts an index referencing the auto-injected column '%s' " +
      '(mirrors plugin_table.py merging auto-columns in before index validation; ' +
      'a tenant-scoped plugin table typically indexes on tenant_id)',
    (autoColumn) => {
      const manifest = validManifest()
      manifest.tables[0]!.indexes.push({ name: `ix_auto_${autoColumn}`, columns: [autoColumn] })
      expect(() => validateManifest(manifest)).not.toThrow()
    },
  )
})

describe('validateManifest — permissions (ADR-0004)', () => {
  const DENIED = { allowed: false, required_role: [] }

  it('defaults an absent permissions block to all five ops fully denied', () => {
    // Mirrors plugin_table.py's TablePermissions default_factory semantics:
    // TablePermissions().model_dump() yields every op {allowed:false,
    // required_role:[]}. This asserts the exact zod-parsed equivalent so the
    // nested `.default({})` handling is pinned, not assumed.
    const manifest = validateManifest(validManifest())
    expect(manifest.tables[0]!.permissions).toEqual({
      list: DENIED,
      read: DENIED,
      create: DENIED,
      update: DENIED,
      delete: DENIED,
    })
  })

  it('fills in default-denied rules for operations omitted from a partial block', () => {
    const manifest = validManifest()
    // Only `read` is specified — the other four must default-deny.
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      read: { allowed: true, required_role: ['viewer'] },
    }
    const parsed = validateManifest(manifest)
    expect(parsed.tables[0]!.permissions).toEqual({
      list: DENIED,
      read: { allowed: true, required_role: ['viewer'] },
      create: DENIED,
      update: DENIED,
      delete: DENIED,
    })
  })

  it('accepts allowed:true with an empty required_role (any authenticated caller)', () => {
    const manifest = validManifest()
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      list: { allowed: true },
    }
    const parsed = validateManifest(manifest)
    expect(parsed.tables[0]!.permissions.list).toEqual({ allowed: true, required_role: [] })
  })

  it('rejects an unknown operation key (e.g. "delet")', () => {
    const manifest = validManifest()
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      delet: { allowed: true },
    }
    expect(() => validateManifest(manifest)).toThrow()
  })

  it('rejects an unknown key inside a rule (e.g. "role" for "required_role")', () => {
    const manifest = validManifest()
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      read: { allowed: true, role: ['viewer'] },
    }
    expect(() => validateManifest(manifest)).toThrow()
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
