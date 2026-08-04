import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The defaults must not come through the aliased seam (#1308).
 *
 * `next.config.ts` maps the RESOLVED PATH of
 * `apps/portal/src/lib/login-destinations-default.ts` to an instance's own
 * file. So any module importing the defaults from there imports **itself** once
 * an instance exists. Both spellings were built and both died prerendering
 * `/login`:
 *
 *     RangeError: Maximum call stack size exceeded
 *       at Object.c (.next/server/app/(auth)/login/page.js:2:7755)
 *       ... same frame repeating
 *
 * - `@/lib/login-destinations-default` — SWC rewrites tsconfig `paths` at
 *   transform time to exactly the aliased resolved path.
 * - `./lib/login-destinations-default` — webpack matches the alias after
 *   resolution, so a relative request does not escape it either.
 *
 * The cost of not fixing it: `login-routing.ts` imported BOTH names from the
 * seam, and the seam replaces its module wholesale — so every instance had to
 * restate all six defaults, including `noAccess: '/login/no-access/'`, a
 * template-owned route the instance does not own. Move that route and every
 * instance breaks silently while the template's own tests stay green.
 *
 * The fix is that the defaults live in `login-destinations-contract.ts`, the one
 * module in this seam that is never aliased. This guard keeps them there.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PORTAL = join(ROOT, 'apps', 'portal')
const read = (p: string) => readFileSync(join(PORTAL, p), 'utf8')

/** Modules `next.config.ts` aliases away — importing defaults from these recurses. */
function aliasedModules(): string[] {
  const cfg = read('next.config.ts')
  const block = cfg.slice(
    cfg.indexOf('const instanceSeams'),
    cfg.indexOf('\n]', cfg.indexOf('const instanceSeams')),
  )
  // second element of each pair = the template default that gets aliased
  return [...block.matchAll(/join\([^)]*'lib',\s*'([\w-]+)\.ts'\s*\)/g)].map((m) => m[1])
}

describe('login-destinations defaults are outside the seam (#1308)', () => {
  it('finds the aliased modules, so this guard is not vacuous', () => {
    const aliased = aliasedModules()
    expect(aliased.length).toBeGreaterThan(0)
    expect(aliased).toContain('login-destinations-default')
  })

  it('the defaults live in the contract, which is never aliased', () => {
    expect(read('src/lib/login-destinations-contract.ts')).toContain(
      'export const DEFAULT_LOGIN_DESTINATIONS',
    )
    for (const mod of aliasedModules()) {
      expect(
        read('next.config.ts').includes(mod) &&
          !read(`src/lib/${mod}.ts`).includes('export const DEFAULT_LOGIN_DESTINATIONS'),
        `${mod}.ts is aliased by next.config.ts and must not export DEFAULT_LOGIN_DESTINATIONS — ` +
          `an instance file replacing it would have to restate every default, and importing them ` +
          `back recurses infinitely (#1308).`,
      ).toBe(true)
    }
  })

  it('login-routing takes only the OVERRIDES from the seam', () => {
    const src = read('src/lib/login-routing.ts')
    const seamImport = src.match(/import\s*\{([^}]*)\}\s*from\s*'@\/instance-login-destinations'/)
    expect(seamImport, 'login-routing must still import the overrides from the seam').not.toBeNull()
    expect(
      seamImport?.[1],
      'importing the DEFAULTS from the seam is what forced every instance to restate them',
    ).not.toContain('DEFAULT_LOGIN_DESTINATIONS')
  })

  it('the seam fallback exports only the override, so an instance may too', () => {
    const fallback = read('src/lib/login-destinations-default.ts')
    expect(fallback).toContain('export const INSTANCE_LOGIN_DESTINATIONS')
    expect(fallback).not.toContain('export const DEFAULT_LOGIN_DESTINATIONS')
  })
})
