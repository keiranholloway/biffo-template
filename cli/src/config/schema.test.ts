import { describe, expect, it } from 'vitest'
import { BiffoConfigSchema } from './schema.js'

const BASE = {
  project: { name: 'my-app', description: 'A test app', domain: 'myapp.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'admin@example.com', username: 'admin' },
} as const

describe('BiffoConfigSchema', () => {
  it('accepts a valid minimal config', () => {
    const result = BiffoConfigSchema.safeParse(BASE)
    expect(result.success).toBe(true)
  })

  it('applies defaults: environments=[dev], database={}, modules={}', () => {
    const result = BiffoConfigSchema.safeParse({ ...BASE, environments: undefined })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.environments).toEqual(['dev'])
    expect(result.data.database).toEqual({
      schema_path: null,
      migrations_path: 'services/api/migrations',
    })
  })

  it('rejects project name with uppercase letters', () => {
    const result = BiffoConfigSchema.safeParse({
      ...BASE,
      project: { ...BASE.project, name: 'MyApp' },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.path).toEqual(['project', 'name'])
  })

  it('rejects invalid AWS account ID (not 12 digits)', () => {
    const result = BiffoConfigSchema.safeParse({
      ...BASE,
      cloud: { provider: 'aws', config: { account_id: '12345', region: 'us-east-1' } },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.path).toContain('account_id')
  })

  it('rejects invalid admin email', () => {
    const result = BiffoConfigSchema.safeParse({
      ...BASE,
      admin: { email: 'not-an-email', username: 'admin' },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.path).toContain('email')
  })

  it('requires at least one environment', () => {
    const result = BiffoConfigSchema.safeParse({ ...BASE, environments: [] })
    expect(result.success).toBe(false)
  })

  it('database field defaults to empty object when omitted', () => {
    const result = BiffoConfigSchema.safeParse(BASE)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.database.migrations_path).toBe('services/api/migrations')
    expect(result.data.database.schema_path).toBeNull()
  })
})
