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

describe('validateManifest — user-facing surfaces (ADR-0021 / frontend)', () => {
  it('accepts an app-ref ingress (shared host) + user_frontend', () => {
    const manifest = validateManifest({
      name: 'ideation',
      version: '1.0.0',
      user_ingress: { required_group: 'founder', app: 'ideation.app:app' },
      user_frontend: { dir: 'web/dist', required_group: 'founder' },
    })
    expect(manifest.user_ingress?.app).toBe('ideation.app:app')
    expect(manifest.user_frontend?.dir).toBe('web/dist')
  })

  it('rejects a user_ingress with no app, and a malformed app-ref', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_ingress: { required_group: 'founder' },
      }),
    ).toThrow()
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_ingress: { required_group: 'founder', app: 'nocolon' },
      }),
    ).toThrow(/app reference/)
  })

  it('rejects the removed legacy handler/path keys (strict schema)', () => {
    for (const legacy of [{ handler: 'ideation.app.handler' }, { path: 'api' }]) {
      expect(() =>
        validateManifest({
          name: 'x',
          version: '1.0.0',
          user_ingress: { required_group: 'founder', app: 'm:a', ...legacy },
        }),
      ).toThrow()
    }
  })

  it('is absent on an ordinary plugin', () => {
    const manifest = validateManifest({ name: 'rbac', version: '1.0.0' })
    expect(manifest.user_ingress).toBeUndefined()
    expect(manifest.user_frontend).toBeUndefined()
  })

  it('rejects an unknown key on user_frontend', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        user_frontend: { dir: 'web/dist', required_group: 'founder', extra: true },
      }),
    ).toThrow()
  })

  // admin_ingress (biffo-template#1517): before this, `grep -rn "admin_ingress"
  // cli/src` returned zero non-test hits — the field wasn't in this schema at
  // all, so it validated fine as an unrecognised top-level key and was silently
  // stripped. `biffo plugin install` had no way to see the surface it was
  // vendoring. These mirror the user_ingress tests above.
  it('accepts an admin_ingress alongside a user_ingress', () => {
    const manifest = validateManifest({
      name: 'marketing',
      version: '1.0.0',
      user_ingress: { required_group: 'founder', app: 'marketing.user_app:app' },
      admin_ingress: { required_group: 'admin', app: 'marketing.admin_app:app' },
    })
    expect(manifest.admin_ingress?.app).toBe('marketing.admin_app:app')
    expect(manifest.admin_ingress?.required_group).toBe('admin')
  })

  it('accepts an admin_ingress with no user_ingress (admin-only plugin)', () => {
    const manifest = validateManifest({
      name: 'marketing',
      version: '1.0.0',
      admin_ingress: { required_group: 'admin', app: 'marketing.admin_app:app' },
    })
    expect(manifest.user_ingress).toBeUndefined()
    expect(manifest.admin_ingress?.app).toBe('marketing.admin_app:app')
  })

  it('rejects an admin_ingress with no app, and a malformed app-ref', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        admin_ingress: { required_group: 'admin' },
      }),
    ).toThrow()
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        admin_ingress: { required_group: 'admin', app: 'nocolon' },
      }),
    ).toThrow(/app reference/)
  })

  it('rejects an unknown key on admin_ingress', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        admin_ingress: { required_group: 'admin', app: 'm:a', extra: true },
      }),
    ).toThrow()
  })

  it('is absent on an ordinary plugin', () => {
    const manifest = validateManifest({ name: 'rbac', version: '1.0.0' })
    expect(manifest.admin_ingress).toBeUndefined()
  })
})

describe('validateManifest — seed (baseline-row declaration, biffo-template#1554)', () => {
  it('accepts a well-formed seed declaring dir and baseline_tables', () => {
    const manifest = validateManifest({
      ...validManifest(),
      seed: { dir: 'db/seed', baseline_tables: ['rbac_roles'] },
    })
    expect(manifest.seed?.dir).toBe('db/seed')
    expect(manifest.seed?.baseline_tables).toEqual(['rbac_roles'])
  })

  it('defaults baseline_tables to empty when only dir is declared', () => {
    const manifest = validateManifest({
      ...validManifest(),
      seed: { dir: 'db/seed' },
    })
    expect(manifest.seed?.baseline_tables).toEqual([])
  })

  it('is absent on a plugin that declares no seed — no default object materialises', () => {
    const manifest = validateManifest(validManifest())
    expect(manifest.seed).toBeUndefined()
  })

  it('rejects seed.baseline_tables referencing a table not in this manifest', () => {
    expect(() =>
      validateManifest({
        ...validManifest(),
        seed: { dir: 'db/seed', baseline_tables: ['no_such_table'] },
      }),
    ).toThrow(/baseline_tables references table 'no_such_table'/)
  })

  it('rejects a seed with no dir', () => {
    expect(() =>
      validateManifest({
        ...validManifest(),
        seed: { baseline_tables: ['rbac_roles'] },
      }),
    ).toThrow()
  })

  it('rejects a seed.dir with a leading slash or path traversal', () => {
    for (const dir of ['/etc/seed', '../escape']) {
      expect(() =>
        validateManifest({
          ...validManifest(),
          seed: { dir, baseline_tables: [] },
        }),
      ).toThrow()
    }
  })

  it('rejects an unknown key on seed (strict schema)', () => {
    expect(() =>
      validateManifest({
        ...validManifest(),
        seed: { dir: 'db/seed', baseline_tables: [], extra: true },
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
  const DENIED = { allowed: false, required_role: [], permission_code: '' }

  it('defaults an absent permissions block to all five ops fully denied', () => {
    // Mirrors plugin_table.py's TablePermissions default_factory semantics:
    // TablePermissions().model_dump() yields every op {allowed:false,
    // required_role:[], permission_code:''}. This asserts the exact
    // zod-parsed equivalent so the nested `.default({})` handling is pinned,
    // not assumed.
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
      read: { allowed: true, required_role: ['viewer'], permission_code: '' },
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
    expect(parsed.tables[0]!.permissions.list).toEqual({
      allowed: true,
      required_role: [],
      permission_code: '',
    })
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

  // --- permission_code (#1606) ---------------------------------------------

  it('accepts a declared permission_code and defaults it to "" when omitted', () => {
    const manifest = validManifest()
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      read: { allowed: true, permission_code: 'crm.lead.read' },
    }
    const parsed = validateManifest(manifest)
    expect(parsed.tables[0]!.permissions.read).toEqual({
      allowed: true,
      required_role: [],
      permission_code: 'crm.lead.read',
    })
    // The other four ops still default permission_code to '' — the
    // backward-compatibility claim for every manifest that doesn't use it.
    expect(parsed.tables[0]!.permissions.list.permission_code).toBe('')
  })

  it('rejects a typo of permission_code (e.g. "permision_code")', () => {
    const manifest = validManifest()
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      read: { allowed: true, permision_code: 'crm.lead.read' },
    }
    expect(() => validateManifest(manifest)).toThrow()
  })

  it('does not accept allowed_principals — that axis is deliberately not mirrored (ADR-0014 §7)', () => {
    const manifest = validManifest()
    ;(manifest.tables[0] as Record<string, unknown>).permissions = {
      read: { allowed: true, allowed_principals: ['system:agent-runtime'] },
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

describe('validateManifest — chat agents (ADR-0017)', () => {
  const agent = {
    key: 'ideation-challenger',
    system_prompt: 'Ask one sharp question.',
    model: 'anthropic/claude-sonnet-4',
    required_group: 'chat_agent_group',
  }
  // required_group is a REFERENCE, not a value (biffo-template#1517) — it must
  // name a declared `config` entry of kind: "setting", never a literal
  // Cognito group name baked into the manifest.
  const groupSetting = {
    name: 'chat_agent_group',
    kind: 'setting' as const,
    description: 'Cognito group allowed to use the chat agent.',
  }

  it('accepts a well-formed chat_agents entry and defaults the bounds', () => {
    const m = validateManifest({
      name: 'ideation',
      version: '1.0.0',
      chat_agents: [agent],
      config: [groupSetting],
    })
    expect(m.chat_agents).toHaveLength(1)
    expect(m.chat_agents[0]!.key).toBe('ideation-challenger')
    expect(m.chat_agents[0]!.max_history_messages).toBe(40)
    expect(m.chat_agents[0]!.timeout_seconds).toBe(20)
  })

  it('defaults chat_agents to empty and rejects a bad key / unknown field', () => {
    expect(validateManifest({ name: 'rbac', version: '1.0.0' }).chat_agents).toEqual([])
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        chat_agents: [{ ...agent, key: 'Bad' }],
        config: [groupSetting],
      }),
    ).toThrow()
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        chat_agents: [{ ...agent, extra: true }],
        config: [groupSetting],
      }),
    ).toThrow()
  })

  it('rejects a required_group with no matching config declaration (the migration this issue requires)', () => {
    // The exact defect biffo-template#1517 names: a literal group name (e.g.
    // "founder") baked straight into the manifest, unreachable on a platform
    // that doesn't define it — now structurally impossible to express.
    expect(() =>
      validateManifest({
        name: 'ideation',
        version: '1.0.0',
        chat_agents: [{ ...agent, required_group: 'founder' }],
      }),
    ).toThrow(/must name a 'config' declaration/)
  })

  it('rejects a required_group referencing a kind: secret config entry', () => {
    // A Cognito group name is not confidential — pointing a chat agent at a
    // secret is a category mistake, not a valid reference.
    expect(() =>
      validateManifest({
        name: 'ideation',
        version: '1.0.0',
        chat_agents: [agent],
        config: [{ ...groupSetting, kind: 'secret' as const }],
      }),
    ).toThrow(/must name a 'config' declaration/)
  })
})

describe('validateManifest — config declarations (biffo-template#1517)', () => {
  it('defaults config to empty', () => {
    expect(validateManifest({ name: 'x', version: '1.0.0' }).config).toEqual([])
  })

  it('accepts a well-formed secret and setting declaration', () => {
    const m = validateManifest({
      name: 'marketing',
      version: '1.0.0',
      config: [
        {
          name: 'image_provider_api_key',
          kind: 'secret',
          required: true,
          description: 'API key for the still-image provider.',
        },
        {
          name: 'user_ingress_group',
          kind: 'setting',
          required: false,
          description: 'Which group may reach the unit-facing surface.',
        },
      ],
    })
    expect(m.config).toHaveLength(2)
    expect(m.config[0]!.kind).toBe('secret')
    expect(m.config[0]!.required).toBe(true)
    expect(m.config[1]!.required).toBe(false)
  })

  it('defaults required to true', () => {
    const m = validateManifest({
      name: 'x',
      version: '1.0.0',
      config: [{ name: 'x', kind: 'setting', description: 'd' }],
    })
    expect(m.config[0]!.required).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        config: [{ name: 'x', kind: 'credential', description: 'd' }],
      }),
    ).toThrow()
  })

  it('rejects a missing description', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        config: [{ name: 'x', kind: 'setting', description: '' }],
      }),
    ).toThrow()
  })

  it('rejects an unknown key (strict schema)', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        config: [{ name: 'x', kind: 'setting', description: 'd', extra: true }],
      }),
    ).toThrow()
  })

  it('rejects a non-snake_case name', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        config: [{ name: 'Not-Snake-Case', kind: 'setting', description: 'd' }],
      }),
    ).toThrow()
  })

  it('rejects duplicate config declaration names', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        config: [
          { name: 'dup', kind: 'setting', description: 'a' },
          { name: 'dup', kind: 'secret', description: 'b' },
        ],
      }),
    ).toThrow(/Duplicate config declaration/)
  })
})

describe('validateManifest — tool declarations (ADR-0014 §7, #569)', () => {
  const tool = {
    name: 'web_search',
    description: 'Search the public web and return the top results.',
    parameters: { type: 'object', properties: {} },
  }

  it('accepts a well-formed tools entry and round-trips it', () => {
    // The landmine this closes: before #569, `tools` validated fine and the
    // top-level schema's non-`.strict()` object silently dropped it — a
    // manifest author following the SDK's own ToolDeclaration docs got no
    // error and no field. It must now survive validation intact.
    const m = validateManifest({ name: 'agent-runtime', version: '1.0.0', tools: [tool] })
    expect(m.tools).toHaveLength(1)
    expect(m.tools[0]).toEqual(tool)
  })

  it('defaults tools to empty and applies the parameters default', () => {
    expect(validateManifest({ name: 'rbac', version: '1.0.0' }).tools).toEqual([])
    const m = validateManifest({
      name: 'x',
      version: '1.0.0',
      tools: [{ name: 'web_search', description: 'Search the web.' }],
    })
    expect(m.tools[0]!.parameters).toEqual({})
  })

  it('rejects a tool declaration missing its required description', () => {
    expect(() =>
      validateManifest({
        name: 'x',
        version: '1.0.0',
        tools: [{ name: 'web_search' }],
      }),
    ).toThrow()
  })
})
