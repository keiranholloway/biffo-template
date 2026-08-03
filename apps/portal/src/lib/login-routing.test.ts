import { describe, expect, it } from 'vitest'
import type { LoginDestinations } from './login-destinations-contract'

/**
 * Six DISTINCT destinations, so each rule is distinguishable from every other.
 *
 * The template default deliberately sends five of the six outcomes to
 * `/admin/`, which is right for a fresh instance and useless for testing
 * precedence: "a unit role does not land where a tenant role lands" would pass
 * against any rule table at all. These sentinels make the assertions real.
 */
const D: LoginDestinations = {
  admin: '/d-admin/',
  platformAdmin: '/d-platform-admin/',
  orgScoped: '/d-org/',
  unitScoped: '/d-unit/',
  marketplace: '/d-marketplace/',
  noAccess: '/d-no-access/',
}
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
    const result = resolveDestination(baseWhoami, [], '/admin/plugins/', D)
    expect(result).toBe('/admin/plugins/')
  })

  it('rule 1: returnTo takes precedence over all other rules', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
    }
    const result = resolveDestination(whoami, ['admin'], '/custom/', D)
    expect(result).toBe('/custom/')
  })

  it('rule 2: routes to /admin/ when user is in admin group', () => {
    const result = resolveDestination(baseWhoami, ['admin'], null, D)
    expect(result).toBe(D.admin)
  })

  it('rule 2: routes to /admin/ when user is in admin group (empty roles)', () => {
    const result = resolveDestination(baseWhoami, ['admin'], null, D)
    expect(result).toBe(D.admin)
  })

  it('rule 3: resolves through platformAdmin when is_platform_admin is true', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
    }
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.platformAdmin)
  })

  it('rule 4: resolves through orgScoped when user has a tenant-level role', () => {
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
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.orgScoped)
  })

  it('rule 4: resolves through orgScoped when user has a brand-level role', () => {
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
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.orgScoped)
  })

  it('rule 4: resolves through orgScoped when user has a region-level role', () => {
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
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.orgScoped)
  })

  it('rule 5: resolves through unitScoped when user has a unit-level role', () => {
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
    // ADR-0105: training is a section of the same surface, not a destination
    // of its own. The row was briefly '/lms/'; see the module docstring before
    // changing it. WHICH surface `unitScoped` names is now the instance's call
    // (#1098) -- the rule is that a unit role resolves through this key.
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.unitScoped)
  })

  it('rule 5: a unit role does not send an above-unit colleague anywhere else', () => {
    // Rule 4 is checked first, so someone holding both a brand role and a unit
    // role resolves through `orgScoped`, not `unitScoped`. Under the real
    // instance map these were the same path and the case discriminated on
    // nothing; against six distinct keys (#1098) it pins the ORDER for real.
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [
        {
          role: 'store_manager',
          scope_level: 'unit',
          unit_id: 'unit-1',
        },
        {
          role: 'brand_manager',
          scope_level: 'brand',
          brand_id: 'brand-1',
        },
      ],
    }
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.orgScoped)
  })

  it('rule 5: returnTo still wins for a unit-level user', () => {
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
    const result = resolveDestination(whoami, [], '/crm/onboarding/', D)
    expect(result).toBe('/crm/onboarding/')
  })

  it('rule 6: routes to /marketplace/ when user has marketplace_role and no roles', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      marketplace_role: 'seller',
      roles: [],
    }
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.marketplace)
  })

  it('rule 7: routes to /login/no-access/ when user has no roles and no marketplace_role', () => {
    const result = resolveDestination(baseWhoami, [], null, D)
    expect(result).toBe(D.noAccess)
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
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.noAccess)
  })

  it('does not produce /admin/ as a fallback — only rule 2 (admin group) produces it', () => {
    // A user with no group membership and no roles should not land on /admin/
    const result = resolveDestination(baseWhoami, [], null, D)
    expect(result).not.toBe(D.admin)
    expect(result).toBe(D.noAccess)
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
    // Both rules match but platform_admin (rule 3) is checked first — and
    // Rule 5 yields '/crm/' again under ADR-0105, so this agrees by
    // coincidence rather than discriminating. Kept for the ordering it pins.
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.platformAdmin)
  })

  it('respects rule ordering: admin group takes precedence over platform_admin', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      is_platform_admin: true,
    }
    // Admin group (rule 2) is checked before platform_admin (rule 3)
    const result = resolveDestination(whoami, ['admin'], null, D)
    expect(result).toBe(D.admin)
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
    // Unit role (rule 5) takes precedence over marketplace_role (rule 6)
    const result = resolveDestination(whoami, [], null, D)
    expect(result).toBe(D.unitScoped)
  })
})
