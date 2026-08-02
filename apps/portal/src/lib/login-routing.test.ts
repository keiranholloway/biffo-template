import { describe, expect, it } from 'vitest'
import { resolveDestination, type WhoamiResponse } from './login-routing'

const baseWhoami: WhoamiResponse = {
  sub: 'sub-123',
  email: 'user@example.com',
  username: 'user@example.com',
  user_id: 'user-123',
  is_platform_admin: false,
  permissions: [],
  marketplace_role: null,
  roles: [],
}

describe('resolveDestination', () => {
  it('rule 1: returns returnTo when provided and valid', () => {
    const result = resolveDestination(baseWhoami, [], '/admin/plugins/')
    expect(result).toBe('/admin/plugins/')
  })

  it('rule 1: returnTo takes precedence over all other rules', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
    }
    const result = resolveDestination(whoami, ['admin'], '/custom/')
    expect(result).toBe('/custom/')
  })

  it('rule 2: routes to /admin/ when user is in admin group', () => {
    const result = resolveDestination(baseWhoami, ['admin'], null)
    expect(result).toBe('/admin/')
  })

  it('rule 2: routes to /admin/ when user is in admin group (empty roles)', () => {
    const result = resolveDestination(baseWhoami, ['admin'], null)
    expect(result).toBe('/admin/')
  })

  it('rule 3: routes to /crm/ when is_platform_admin is true', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/crm/')
  })

  it('rule 4: routes to /crm/ when user has a tenant-level role', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        {
          role: 'manager',
          scope_level: 'tenant',
          tenant_id: 'tenant-1',
        },
      ],
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/crm/')
  })

  it('rule 4: routes to /crm/ when user has a brand-level role', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        {
          role: 'brand_manager',
          scope_level: 'brand',
          brand_id: 'brand-1',
        },
      ],
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/crm/')
  })

  it('rule 4: routes to /crm/ when user has a region-level role', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        {
          role: 'region_manager',
          scope_level: 'region',
          region_id: 'region-1',
        },
      ],
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/crm/')
  })

  it('rule 5: routes to /lms/ when user has a unit-level role', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        {
          role: 'store_manager',
          scope_level: 'unit',
          unit_id: 'unit-1',
        },
      ],
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/lms/')
  })

  it('rule 4 still wins over rule 5 for a user holding both', () => {
    // An administrator who also holds a unit role is not a learner and must not
    // be dropped into the LMS. Worth asserting now because the ordering was
    // previously UNOBSERVABLE — both rules returned '/crm/', so nothing could
    // have caught them being swapped.
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        { role: 'store_manager', scope_level: 'unit', unit_id: 'unit-1' },
        { role: 'brand_hq', scope_level: 'brand', brand_id: 'brand-1' },
      ],
    }
    expect(resolveDestination(whoami, [], null)).toBe('/crm/')
  })

  it('rule 6: routes to /marketplace/ when user has marketplace_role and no roles', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      marketplace_role: 'seller',
      roles: [],
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/marketplace/')
  })

  it('rule 7: routes to /login/no-access/ when user has no roles and no marketplace_role', () => {
    const result = resolveDestination(baseWhoami, [], null)
    expect(result).toBe('/login/no-access/')
  })

  it('rule 7: routes to /login/no-access/ when user has roles but they are unrecognized scope levels', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        {
          role: 'custom_role',
          scope_level: 'unknown_scope',
        },
      ],
    }
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/login/no-access/')
  })

  it('does not produce /admin/ as a fallback — only rule 2 (admin group) produces it', () => {
    // A user with no group membership and no roles should not land on /admin/
    const result = resolveDestination(baseWhoami, [], null)
    expect(result).not.toBe('/admin/')
    expect(result).toBe('/login/no-access/')
  })

  it('respects rule ordering: platform_admin takes precedence over roles', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
      roles: [
        {
          role: 'store_manager',
          scope_level: 'unit',
          unit_id: 'unit-1',
        },
      ],
    }
    // Both rules match but platform_admin (rule 3) is checked first
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/crm/')
  })

  it('respects rule ordering: admin group takes precedence over platform_admin', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
    }
    // Admin group (rule 2) is checked before platform_admin (rule 3)
    const result = resolveDestination(whoami, ['admin'], null)
    expect(result).toBe('/admin/')
  })

  it('respects rule ordering: marketplace_role is only used when no other roles apply', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      marketplace_role: 'seller',
      roles: [
        {
          role: 'store_manager',
          scope_level: 'unit',
          unit_id: 'unit-1',
        },
      ],
    }
    // Unit role (rule 5) takes precedence over marketplace_role (rule 6).
    // The assertion is the PRECEDENCE; the destination changed to '/lms/' and
    // is incidental to what this test is about.
    const result = resolveDestination(whoami, [], null)
    expect(result).toBe('/lms/')
  })
})
