import { describe, expect, it } from 'vitest'
import { sanitizeReturnTo } from './return-to'

describe('sanitizeReturnTo', () => {
  it('returns the default when null', () => {
    expect(sanitizeReturnTo(null)).toBe('/admin/')
  })

  it('returns the default when empty', () => {
    expect(sanitizeReturnTo('')).toBe('/admin/')
  })

  it('accepts a same-origin relative path', () => {
    expect(sanitizeReturnTo('/my-sibling/')).toBe('/my-sibling/')
  })

  it('accepts a custom fallback', () => {
    expect(sanitizeReturnTo(null, '/somewhere/')).toBe('/somewhere/')
  })

  it('rejects an absolute http(s) URL', () => {
    expect(sanitizeReturnTo('https://evil.com/')).toBe('/admin/')
    expect(sanitizeReturnTo('http://evil.com/')).toBe('/admin/')
  })

  it('rejects a protocol-relative URL', () => {
    expect(sanitizeReturnTo('//evil.com/')).toBe('/admin/')
  })

  it('rejects a path without a leading slash', () => {
    expect(sanitizeReturnTo('admin')).toBe('/admin/')
  })

  it('rejects a value containing "://" anywhere', () => {
    expect(sanitizeReturnTo('/redirect?to=https://evil.com')).toBe('/admin/')
  })

  /**
   * The default used to be `/dashboard`, which is not a route this portal has —
   * the dashboard lives at `/admin/`. A user completing first login was sent
   * straight to a 404. Observed on a live deployment (issue #275).
   */
  it('defaults to a route that actually exists', () => {
    expect(sanitizeReturnTo(null)).toBe('/admin/')
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
    expect(sanitizeReturnTo('//evil.com')).toBe('/admin/')
    expect(sanitizeReturnTo('https://evil.com')).toBe('/admin/')
  })
})
