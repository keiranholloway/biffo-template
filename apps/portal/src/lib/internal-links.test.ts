import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Drift guard (issue #275).
 *
 * The portal builds with `output: 'export'` and `trailingSlash: true`, so the
 * canonical URL of every route ends in `/` and its App Router RSC payload is
 * emitted alongside the HTML as `<route>/index.txt`.
 *
 * A client-side navigation to the *unslashed* form resolves onto that payload
 * file: the browser lands on `/admin/index.txt` and renders raw serialised
 * React. On a Next server, a redirect to the canonical form would fix it in
 * flight. Static hosting issues no such redirect — S3/CloudFront answer
 * `/admin` with `200 index.html` directly — so the mismatch is never corrected.
 *
 * That is not a theoretical failure. Every internal href in this app was
 * written without its trailing slash, and "Go to dashboard" on the home page
 * sent users of a live deployment to `/admin/index.txt`.
 *
 * Nothing in the build catches it: both `/admin` and `/admin/index.txt` return
 * 200, so a build check or a curl passes while the bug is live. Only clicking
 * reproduces it — which is why the check belongs here, coupling the hrefs to
 * the `trailingSlash` setting they depend on.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '..')
const NEXT_CONFIG = resolve(here, '../../next.config.ts')

/** Every `.ts`/`.tsx` file under `src/`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

/**
 * Internal navigation targets: `href="/..."` on a `Link`, and `router.push('/...')`.
 * Deliberately literal — a dynamic target cannot be checked here, which is why
 * `sanitizeReturnTo` normalises the one dynamic target this app has.
 */
function internalTargets(source: string): string[] {
  const targets: string[] = []
  for (const m of source.matchAll(/href="(\/[^"]*)"/g)) {
    const target = m[1]
    if (target !== undefined) targets.push(target)
  }
  for (const m of source.matchAll(/router\.push\('(\/[^']*)'\)/g)) {
    const target = m[1]
    if (target !== undefined) targets.push(target)
  }
  // Template-literal pushes, e.g. router.push(`/login/?return_to=${x}`).
  // Only the literal prefix is captured — up to the first interpolation — which
  // is all this guard needs, since it asserts on the *pathname* and stops at the
  // query string anyway. Without this, a push whose target is built rather than
  // written silently leaves the guard's coverage while every assertion still
  // passes: the count check only requires more than five targets overall, so
  // losing one is invisible. That is exactly what happened when AuthGuard
  // started carrying a return_to.
  for (const m of source.matchAll(/router\.push\(`(\/[^`$]*)/g)) {
    const target = m[1]
    if (target !== undefined) targets.push(target)
  }
  return targets
}

/** The path portion of a target, with any query string or hash removed. */
function pathnameOf(target: string): string {
  return target.split(/[?#]/)[0] ?? target
}

/** A route needs a trailing slash; a file (final segment has a dot) must not gain one. */
function isRoute(target: string): boolean {
  const pathname = pathnameOf(target)
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  return !lastSegment.includes('.')
}

describe('internal navigation targets', () => {
  it('the portal is configured with trailingSlash: true', () => {
    // The whole point of the assertion below. If this ever flips, the guard
    // must be inverted rather than deleted.
    expect(readFileSync(NEXT_CONFIG, 'utf8')).toMatch(/trailingSlash:\s*true/)
  })

  it('every internal route target ends with a trailing slash', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC)) {
      for (const target of internalTargets(readFileSync(file, 'utf8'))) {
        if (!isRoute(target)) continue
        if (!pathnameOf(target).endsWith('/')) {
          offenders.push(`${file.slice(SRC.length + 1)} -> ${target}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('finds targets at all, so the guard cannot silently pass on a bad regex', () => {
    const all = sourceFiles(SRC).flatMap((f) => internalTargets(readFileSync(f, 'utf8')))
    expect(all.length).toBeGreaterThan(5)
  })
})
