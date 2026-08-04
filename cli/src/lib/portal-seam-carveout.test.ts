import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every instance seam must be BOTH resolvable and legally authorable (#1305).
 *
 * ## The defect this exists to prevent
 *
 * `apps/portal/next.config.ts` declared two seams — it aliases the template
 * default to the instance's own file whenever that file exists, so resolution
 * worked perfectly. `core-manifest.json` carved out only ONE of them.
 *
 * `apps/portal/` is `templateOwned`, so an instance creating
 * `src/instance-login-destinations.ts` had it refused by the ownership guard.
 * The seam resolved and could not be authored: a mechanism that works and a
 * mechanism nobody is allowed to use are indistinguishable from the outside.
 *
 * The visible cost was that every instance served the template defaults, so
 * every non-admin user was routed to `/admin/` and refused by `AuthGuard` — on
 * tabsii dev, every Brand HQ, region and unit user. ADR-0105 was in effect
 * nowhere.
 *
 * ## Why the two halves drift apart
 *
 * They live in different files, edited for different reasons, and each looks
 * complete on its own. `next.config.ts` reads like the whole mechanism; the
 * manifest reads like an unrelated ownership list. Nothing connected them, so
 * adding a seam meant remembering a second file — which is the "second copy of
 * a decision" this estate keeps paying for.
 *
 * Deriving the expected carve-outs FROM `next.config.ts` is what makes this a
 * guard rather than another list to remember.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const NEXT_CONFIG = join(ROOT, 'apps', 'portal', 'next.config.ts')
const MANIFEST = join(ROOT, 'core-manifest.json')

/**
 * The instance-side file of every seam `next.config.ts` declares.
 *
 * Read from `instanceSeams`, whose entries are `[instanceFile, templateDefault]`
 * — the FIRST of each pair. Taking every `instance-*.ts` in the file would also
 * match the template defaults (`instance-nav-empty.ts`), which are correctly
 * template-owned and must NOT be carved out.
 */
function declaredSeamFiles(): string[] {
  const src = readFileSync(NEXT_CONFIG, 'utf8')
  const start = src.indexOf('const instanceSeams')
  expect(start, 'instanceSeams not found — this guard is reading the wrong shape').toBeGreaterThan(
    -1,
  )
  const block = src.slice(start, src.indexOf('\n]', start))
  // Each pair opens with `[` then the instance file's join(...) on the next line.
  return [...block.matchAll(/\[\s*\n\s*join\([^)]*'([\w-]+)\.ts'\s*\)/g)].map((m) => `${m[1]}.ts`)
}

interface Manifest {
  userOwned: string[]
  templateOwned: string[]
}
function manifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

/**
 * Who owns `path`, by LONGEST-PREFIX-WINS across both lists.
 *
 * A naive "is it under any userOwned prefix" check is wrong here and silently
 * un-fireable: `apps/` is userOwned, so every portal path matches it — while
 * `apps/portal/` is templateOwned and, being longer, actually wins. The first
 * version of this guard made exactly that mistake and passed against the very
 * defect it was written for.
 */
function ownerOf(path: string): 'user' | 'template' | 'unclaimed' {
  const m = manifest()
  const match = (prefixes: string[]) =>
    prefixes
      .filter((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`) || path === p)
      .reduce((longest, p) => (p.length > longest.length ? p : longest), '')
  const u = match(m.userOwned)
  const t = match(m.templateOwned)
  if (!u && !t) return 'unclaimed'
  return u.length >= t.length ? 'user' : 'template'
}

describe('portal instance seams are authorable, not just resolvable (#1305)', () => {
  it('finds the declared seams, so the comparison is not vacuous', () => {
    const seams = declaredSeamFiles()
    expect(
      seams.length,
      'no seams parsed from next.config.ts — a rename would silently pass',
    ).toBeGreaterThanOrEqual(2)
    expect(seams).toContain('instance-nav.ts')
  })

  /**
   * Both files an instance needs per seam: the declaration and its test.
   *
   * The test is not a nicety here. The values a seam carries are **instance
   * data**, so the only place that can assert what they resolve to is the
   * instance — `login-routing.test.ts` deliberately INJECTS six distinct
   * destinations to test rule precedence, and its own docstring explains why it
   * must: against the real map five of six outcomes are `/admin/`, so those
   * assertions "go quiet rather than red". Correct upstream, and it means no
   * template test can ever cover an instance's actual destinations.
   *
   * Refusing the instance's test therefore leaves the values with no possible
   * test **anywhere**, which is how tabsii shipped every non-admin user to a
   * refusal page with a green suite in both repos (#1307).
   *
   * Derived from the seam file rather than listed, for the same reason the seam
   * list itself is derived: a third hand-written list is a third place to forget
   * a half. `vitest.config.ts`'s include already globs every `.test.ts` under
   * `src`, so a carve-out at this path needs no further wiring.
   */
  function requiredCarveOuts(): string[] {
    return declaredSeamFiles().flatMap((file) => [file, file.replace(/\.ts$/, '.test.ts')])
  }

  it('expects a test carve-out per seam, so the pairing cannot silently vanish', () => {
    // If the `.test.ts` derivation broke, the it.each below would still run and
    // still pass -- on half the cases. Assert the shape of what it iterates.
    const required = requiredCarveOuts()
    expect(required.filter((f) => f.endsWith('.test.ts')).length).toBe(declaredSeamFiles().length)
  })

  it.each(requiredCarveOuts())(
    '%s has a userOwned carve-out, so an instance may actually create it',
    (file) => {
      const expected = `apps/portal/src/${file}`
      const isTest = file.endsWith('.test.ts')
      expect(
        ownerOf(expected) === 'user',
        `next.config.ts declares a seam needing ${file} but core-manifest.json does not carve it ` +
          `out. apps/portal/ is templateOwned, so the ownership guard refuses any instance that ` +
          (isTest
            ? `creates it — the seam can be authored and cannot be tested, which is #1307. Only the ` +
              `instance can assert what its own seam data resolves to.`
            : `creates it — the seam resolves and cannot be authored, which is #1305.`),
      ).toBe(true)
    },
  )

  it('does not carve out the template defaults, which must stay template-owned', () => {
    // The inverse error: carving out `instance-nav-empty.ts` would let an
    // instance edit the fallback every other instance shares.
    expect(ownerOf('apps/portal/src/lib/instance-nav-empty.ts')).toBe('template')
    expect(ownerOf('apps/portal/src/lib/login-destinations-default.ts')).toBe('template')
  })
})
