import { describe, expect, it } from 'vitest'
import { sanitizeReturnTo } from './return-to'

describe('sanitizeReturnTo', () => {
  it('returns the default when null', () => {
    expect(sanitizeReturnTo(null)).toBe('/dashboard')
  })

  it('returns the default when empty', () => {
    expect(sanitizeReturnTo('')).toBe('/dashboard')
  })

  it('accepts a same-origin relative path', () => {
    expect(sanitizeReturnTo('/my-sibling/')).toBe('/my-sibling/')
  })

  it('accepts a custom fallback', () => {
    expect(sanitizeReturnTo(null, '/admin')).toBe('/admin')
  })

  it('rejects an absolute http(s) URL', () => {
    expect(sanitizeReturnTo('https://evil.com/')).toBe('/dashboard')
    expect(sanitizeReturnTo('http://evil.com/')).toBe('/dashboard')
  })

  it('rejects a protocol-relative URL', () => {
    expect(sanitizeReturnTo('//evil.com/')).toBe('/dashboard')
  })

  it('rejects a path without a leading slash', () => {
    expect(sanitizeReturnTo('dashboard')).toBe('/dashboard')
  })

  it('rejects a value containing "://" anywhere', () => {
    expect(sanitizeReturnTo('/redirect?to=https://evil.com')).toBe('/dashboard')
  })
})
