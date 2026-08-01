import { describe, expect, it } from 'vitest'
import { isWithinPortal, sanitizeReturnTo } from './return-to'

describe('sanitizeReturnTo', () => {
  it('returns an empty string when null and no fallback provided', () => {
    expect(sanitizeReturnTo(null)).toBe('')
  })

  it('returns an empty string when empty and no fallback provided', () => {
    expect(sanitizeReturnTo('')).toBe('')
  })

  it('accepts a same-origin relative path', () => {
    expect(sanitizeReturnTo('/my-sibling/')).toBe('/my-sibling/')
  })

  it('accepts a custom fallback', () => {
    expect(sanitizeReturnTo(null, '/somewhere/')).toBe('/somewhere/')
  })

  it('rejects an absolute http(s) URL', () => {
    expect(sanitizeReturnTo('https://evil.com/')).toBe('')
    expect(sanitizeReturnTo('http://evil.com/')).toBe('')
  })

  it('rejects a protocol-relative URL', () => {
    expect(sanitizeReturnTo('//evil.com/')).toBe('')
  })

  it('rejects a path without a leading slash', () => {
    expect(sanitizeReturnTo('admin')).toBe('')
  })

  it('rejects a value containing "://" anywhere', () => {
    expect(sanitizeReturnTo('/redirect?to=https://evil.com')).toBe('')
  })

  /**
   * The caller (login page, now using resolveDestination) is responsible for
   * determining the default destination when no returnTo is provided — the
   * sanitizer's job is only to validate and normalize, not to choose a route.
   */
  it('returns empty string as a fallback, delegating destination choice to caller', () => {
    expect(sanitizeReturnTo(null)).toBe('')
  })

  /**
   * Trailing-slash normalisation (issue #275).
   *
   * The portal builds with `trailingSlash: true`, so a client-side navigation
   * to the unslashed form resolves onto the App Router RSC payload and the
   * browser lands on `/admin/index.txt` showing raw serialised React. Static
   * hrefs are written with their slash; `return_to` arrives from outside and
   * must be normalised here.
   */
  it('appends a trailing slash to a slashless path', () => {
    expect(sanitizeReturnTo('/admin')).toBe('/admin/')
    expect(sanitizeReturnTo('/admin/plugins')).toBe('/admin/plugins/')
  })

  it('leaves an already-slashed path unchanged', () => {
    expect(sanitizeReturnTo('/admin/')).toBe('/admin/')
  })

  it('puts the slash before a query string, not after it', () => {
    expect(sanitizeReturnTo('/admin/plugins?slug=rbac')).toBe('/admin/plugins/?slug=rbac')
  })

  it('puts the slash before a hash, not after it', () => {
    expect(sanitizeReturnTo('/admin#section')).toBe('/admin/#section')
  })

  /**
   * A final segment containing a dot is a file, not a route. Appending a slash
   * would break it — and `/admin/index.txt` is precisely the URL this fix
   * exists to stop users landing on, so it must never be manufactured here.
   */
  it('does not append a slash to a file path', () => {
    expect(sanitizeReturnTo('/logo.svg')).toBe('/logo.svg')
    expect(sanitizeReturnTo('/admin/index.txt')).toBe('/admin/index.txt')
  })

  /**
   * Normalisation runs only after the origin checks, so it can never turn a
   * rejected value into an accepted one.
   */
  it('normalises only values that already passed the origin checks', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('')
    expect(sanitizeReturnTo('https://evil.com')).toBe('')
  })
})

/**
 * The post-login redirect boundary test (issue #351).
 *
 * The portal is a standalone app at /admin. A `return_to` under /admin is one
 * its own client router can `push`; anything else — most importantly the root
 * sibling at `/` — is a different app and must be reached with a full page
 * load, or the portal router fetches the sibling's RSC payload and strands the
 * browser on `/index.txt` (the #275 failure, now cross-app).
 */
describe('isWithinPortal', () => {
  it('treats the bare /admin route as in-portal', () => {
    expect(isWithinPortal('/admin')).toBe(true)
    expect(isWithinPortal('/admin/')).toBe(true)
  })

  it('treats nested /admin routes as in-portal', () => {
    expect(isWithinPortal('/admin/plugins/')).toBe(true)
    expect(isWithinPortal('/admin/users/')).toBe(true)
  })

  it('treats the root sibling as outside the portal', () => {
    expect(isWithinPortal('/')).toBe(false)
  })

  it('treats a named sibling route as outside the portal', () => {
    expect(isWithinPortal('/my-sibling/')).toBe(false)
  })

  /**
   * A sibling path that merely starts with the letters "admin" (e.g. an
   * "/administration" sibling) is NOT under the /admin prefix — the boundary
   * is the path segment, so only "/admin" or "/admin/…" counts.
   */
  it('does not treat a same-prefix sibling as in-portal', () => {
    expect(isWithinPortal('/administration/')).toBe(false)
  })

  /**
   * The check is on the pathname only — a query string or hash naming /admin
   * must not smuggle a sibling route past it.
   */
  it('ignores the query string and hash', () => {
    expect(isWithinPortal('/?next=/admin')).toBe(false)
    expect(isWithinPortal('/#/admin')).toBe(false)
    expect(isWithinPortal('/admin/plugins/?slug=rbac')).toBe(true)
  })
})
