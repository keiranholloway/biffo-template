import { describe, expect, it, vi } from 'vitest'
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
import { canEnterReturnTo, resolveDestination, type WhoamiResponse } from './login-routing'

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

/** A brand-scoped user: the identity #1309 was reproduced with on tabsii dev. */
const brandWhoami: WhoamiResponse = {
  ...baseWhoami,
  roles: [{ role: 'brand_manager', scope_level: 'brand', brand_id: 'brand-1' }],
}

describe('resolveDestination', () => {
  it('rule 1: returns returnTo when the caller can enter it', () => {
    // Within the portal's own surface, and this caller holds the group its gate
    // requires — so rule 1 is honoured, which is the feature.
    const result = resolveDestination(baseWhoami, ['admin'], '/admin/plugins/', D)
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

/**
 * #1309 — rule 1 used to win before every role rule with no entitlement check,
 * so a `return_to` naming a surface the caller cannot enter routed them there
 * for `AuthGuard` to refuse.
 *
 * ## What these tests can and cannot prove
 *
 * They exercise the **precedence**, which is the template-owned part: whether an
 * unusable `returnTo` yields to the role rules, and whether a usable one still
 * wins. That is testable here and worth pinning here.
 *
 * They cannot prove anything about an instance's real values, and #1312 is the
 * reason to say so out loud: `destinations` is INJECTED, so every assertion
 * below is against sentinels. Whether tabsii's brand-scoped user actually lands
 * somewhere useful depends on tabsii's own
 * `src/instance-login-destinations.ts`, which this repo never sees. Only that
 * instance can verify the landing; this suite verifies the rule that chooses it.
 *
 * Note the entitlement check reads the portal's real route prefix
 * (`PORTAL_BASE_PATH`), never the injected map — `/admin/**` is where the
 * portal's routes physically live, whatever an instance points `D.admin` at.
 */
describe('resolveDestination: returnTo entitlement (#1309)', () => {
  it('discards a portal-admin returnTo for a caller without the admin group', () => {
    // The exact reproduction: a real Brand HQ, no cognito:groups, following
    // /login?return_to=%2Fadmin%2F. Must land on their role's surface, not on
    // the one that will refuse them.
    const result = resolveDestination(brandWhoami, [], '/admin/', D)
    expect(result).toBe(D.orgScoped)
    expect(result).not.toBe('/admin/')
  })

  it('discards a DEEP portal-admin returnTo too, not just the bare surface', () => {
    // The whole /admin subtree sits inside one AuthGuard, so a nested path is
    // refused exactly as the root is.
    const result = resolveDestination(brandWhoami, [], '/admin/users/?sort=name', D)
    expect(result).toBe(D.orgScoped)
  })

  it('honours a portal-admin returnTo for an admin-group caller (unaffected)', () => {
    const result = resolveDestination(baseWhoami, ['admin'], '/admin/users/', D)
    expect(result).toBe('/admin/users/')
  })

  it('honours a sibling returnTo for a caller the portal cannot judge', () => {
    // A deep link into a sibling app must survive login: the portal does not
    // know what /crm/ admits and must not guess. This is the feature.
    const result = resolveDestination(brandWhoami, [], '/crm/leads/123/', D)
    expect(result).toBe('/crm/leads/123/')
  })

  it('honours a sibling returnTo even for a caller with no roles at all', () => {
    // Rule 7 would send them to noAccess, but the sibling gates itself and may
    // well admit them on grounds this module cannot see (e.g. marketplace).
    const result = resolveDestination(baseWhoami, [], '/marketplace/', D)
    expect(result).toBe('/marketplace/')
  })

  it('falls through to noAccess when the discarded returnTo leaves no rule matching', () => {
    // Discarding must not invent a landing — it hands over to the role rules and
    // accepts their answer, including "nowhere". This is the case that makes
    // #1310's page reachable, which is why the two issues ship together.
    const result = resolveDestination(baseWhoami, [], '/admin/', D)
    expect(result).toBe(D.noAccess)
  })

  it('discards for a unit-scoped caller as well, landing them on unitScoped', () => {
    const whoami: WhoamiResponse = {
      ...baseWhoami,
      roles: [{ role: 'store_manager', scope_level: 'unit', unit_id: 'unit-1' }],
    }
    const result = resolveDestination(whoami, [], '/admin/', D)
    expect(result).toBe(D.unitScoped)
  })

  it('does NOT honour a portal-admin returnTo on is_platform_admin alone', () => {
    // #1309 suggested testing "rule 2 or rule 3". AuthGuard checks group
    // membership ONLY -- nothing there reads whoami -- so admitting a platform
    // admin outside the group would route them straight into the refusal this
    // change exists to prevent.
    const whoami: WhoamiResponse = { ...baseWhoami, is_platform_admin: true }
    const result = resolveDestination(whoami, [], '/admin/', D)
    expect(result).toBe(D.platformAdmin)
    expect(result).not.toBe('/admin/')
  })

  it('leaves a trace rather than swallowing the intent silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      resolveDestination(brandWhoami, [], '/admin/', D)
      expect(warn).toHaveBeenCalledTimes(1)
      // The discarded value must appear, or the trace cannot be acted on.
      expect(warn.mock.calls[0]?.[0]).toContain('/admin/')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn when returnTo is honoured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      resolveDestination(brandWhoami, [], '/crm/leads/1/', D)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('canEnterReturnTo', () => {
  it.each([
    ['/admin/', undefined, false],
    ['/admin/', [], false],
    ['/admin/', ['editor', 'viewer'], false],
    ['/admin/', ['admin'], true],
    ['/admin/users/?tab=1', ['admin'], true],
    // Not the portal's surface, so not the portal's call.
    ['/crm/', undefined, true],
    ['/', undefined, true],
    ['/marketplace/anything/', [], true],
    // A prefix that merely LOOKS like the portal's is a different app.
    ['/administration/', [], true],
  ] as const)('%s with groups %j -> %s', (returnTo, groups, expected) => {
    expect(canEnterReturnTo(returnTo, groups as string[] | undefined)).toBe(expected)
  })
})
