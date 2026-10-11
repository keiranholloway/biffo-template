import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { statusBadgeClass, statusLabel } from './status.mjs'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const KIT = read('kit.css')
const KIT_BODY = KIT.replace(/\/\*[\s\S]*?\*\//g, '')
const TOKENS = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '')
const pkg = JSON.parse(read('package.json')) as {
  files: string[]
  exports: Record<string, unknown>
}

describe('admin UI kit', () => {
  it('is exported and shipped', () => {
    expect(pkg.exports['./kit.css']).toBe('./kit.css')
    expect(pkg.exports['./status.mjs']).toBeTruthy()
    expect(pkg.files).toEqual(expect.arrayContaining(['kit.css', 'status.mjs']))
  })

  it.each([
    'biffo-heading',
    'biffo-btn-primary',
    'biffo-btn-delete',
    'biffo-badge',
    'biffo-confirm',
  ])('defines .%s', (cls) => {
    expect(KIT_BODY).toMatch(new RegExp(`\\.${cls}[\\s,{:]`))
  })

  it('is built only from existing tokens', () => {
    const declared = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = [...KIT_BODY.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((n) => !declared.has(n))).toEqual([])
    expect(KIT_BODY).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })

  it("matches the portal's look", () => {
    expect(KIT_BODY).toMatch(/font-size:\s*24px/)
    expect(KIT_BODY).toMatch(/ui-sans-serif,\s*system-ui/)
  })
})

describe('status wording', () => {
  it('uses one casing regardless of the stored value', () => {
    expect(statusLabel('ACTIVE')).toBe('Active')
    expect(statusLabel('Active')).toBe('Active')
    expect(statusLabel('enabled')).toBe('Enabled')
    expect(statusBadgeClass('ACTIVE')).toBe('biffo-badge biffo-badge--positive')
  })
})
