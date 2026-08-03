import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every `@/instance-*` seam must be declared in **all three** resolvers.
 *
 * ## Why this exists
 *
 * An optional instance-owned module (ADR-0028) is resolved by three independent
 * things that never read each other:
 *
 *  - `tsconfig.json` `paths`  — for `tsc`
 *  - `next.config.ts` webpack alias — for `next build`
 *  - `vitest.config.ts` `resolve.alias` — for the test run
 *
 * `vitest.config.ts` already warned in prose that "all three must agree or the
 * seam breaks in whichever one was forgotten". #1098 added a second seam and
 * **reproduced that failure immediately**: `@/instance-login-destinations` was
 * declared in `tsconfig.json` and `next.config.ts`, forgotten here, and vitest
 * failed with *"Failed to resolve import"* while `tsc` and `next build` were
 * both green.
 *
 * A warning in a comment is not a mechanism. This is.
 *
 * ## What it asserts
 *
 * The three lists name the same specifiers. It deliberately does **not** check
 * that they resolve to the same file — `next.config.ts` and `vitest.config.ts`
 * prefer the instance's copy when it exists while `tsconfig.json` always names
 * the template default, and that asymmetry is the design (see
 * `instance-nav-empty.ts`). The failure this catches is a specifier declared in
 * some resolvers and not others, which is the one that has actually happened.
 */

const portalRoot = join(import.meta.dirname, '..', '..')
const read = (name: string): string => readFileSync(join(portalRoot, name), 'utf8')

/**
 * `@/instance-*` specifiers a config file actually DECLARES.
 *
 * Comments are stripped first, and that is load-bearing rather than tidiness.
 * The first cut of this guard matched the raw source, so the prose in
 * `vitest.config.ts` explaining the seam counted as a declaration — deleting
 * the real alias left the comment behind and **the guard still passed**. It was
 * asserting on text where it meant structure, which is the exact defect
 * `structural-assertion-guard.test.ts` was added for the same day. Caught by
 * removing the alias and watching this stay green.
 */
function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return [...new Set(code.match(/@\/instance-[a-z0-9-]+/g) ?? [])].sort()
}

describe('instance seam resolvers agree', () => {
  // tsconfig is JSON and parses, so read its `paths` keys rather than its text.
  const tsconfigPaths = (
    JSON.parse(read('tsconfig.json')) as { compilerOptions: { paths: Record<string, string[]> } }
  ).compilerOptions.paths
  const inTsconfig = Object.keys(tsconfigPaths)
    .filter((k) => k.startsWith('@/instance-'))
    .sort()
  const inVitest = specifiers(read('vitest.config.ts'))

  it('finds at least one seam, so the comparison is not vacuous', () => {
    // Three empty lists are trivially equal. A regex that stopped matching --
    // a rename, a reformat -- would otherwise turn this guard green against
    // everything, which is the shape the estate keeps finding.
    expect(inTsconfig.length).toBeGreaterThan(0)
  })

  it('declares every seam in tsconfig, next.config and vitest.config', () => {
    // `next.config.ts` names instance files by path rather than by specifier,
    // so compare against the union and report what each is missing.
    const all = [...new Set([...inTsconfig, ...inVitest])].sort()
    expect(
      { tsconfig: inTsconfig, vitest: inVitest },
      'A seam declared in one resolver and not another builds green in two of ' +
        'three and fails in the third (#1098). Declare it in all of them.',
    ).toEqual({ tsconfig: all, vitest: all })
  })

  it('aliases every seam in next.config, which names FILES rather than specifiers', () => {
    // The third resolver cannot be compared by specifier: its webpack alias maps
    // a resolved template-default path to the instance file, so `@/instance-*`
    // appears in it only in prose. Compare what it actually needs -- both file
    // basenames -- or this resolver silently leaves the guard's scope, which is
    // the "shrinks its own scope and reports the remainder as the whole" defect
    // AGENTS.md section 2 records.
    const nextConfig = read('next.config.ts')
    const missing: string[] = []
    for (const specifier of inTsconfig) {
      const fallback = tsconfigPaths[specifier]?.[0]
      if (!fallback) continue
      const fallbackFile = fallback.split('/').pop() as string
      // `@/instance-login-destinations` -> `instance-login-destinations.ts`
      const instanceFile = `${specifier.replace('@/', '')}.ts`
      for (const needed of [fallbackFile, instanceFile]) {
        if (!nextConfig.includes(needed))
          missing.push(`${specifier}: next.config.ts omits ${needed}`)
      }
    }
    expect(
      missing,
      'A seam missing from next.config.ts builds green under tsc and vitest and ' +
        'silently ships the template default in the real build (#1098).',
    ).toEqual([])
  })

  it('gives every seam a template-owned fallback that exists', () => {
    // Without a fallback the specifier is unresolvable in any instance that has
    // not created the file -- and `core upgrade` never carries user-owned
    // paths, so an older instance would fail `module not found` on upgrade.
    const missing: string[] = []
    for (const [specifier, targets] of Object.entries(tsconfigPaths)) {
      if (!specifier.startsWith('@/instance-')) continue
      for (const target of targets) {
        if (!existsSync(join(portalRoot, target))) missing.push(`${specifier} -> ${target}`)
      }
    }
    expect(missing, 'tsconfig names a fallback that is not in the tree').toEqual([])
  })
})
