import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTemplatePlaceholderConfig } from './local-config.js'

describe('isTemplatePlaceholderConfig', () => {
  it("recognises the template's own committed biffo.config.json", () => {
    // The real file, read from the template repo root — so this test fails the
    // day the template's placeholder tokens change shape.
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../biffo.config.json'), 'utf8'),
    )
    expect(isTemplatePlaceholderConfig(raw)).toBe(true)
  })

  it('rejects a fully resolved config', () => {
    expect(
      isTemplatePlaceholderConfig({
        project: { name: 'my-app' },
        source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
        cloud: { provider: 'aws', config: { account_id: '123456789012' } },
        admin: { email: 'a@b.com' },
      }),
    ).toBe(false)
  })

  it('rejects a partially-filled config so it still fails validation loudly', () => {
    expect(
      isTemplatePlaceholderConfig({
        project: { name: 'my-app' },
        source_control: { provider: 'github', config: { org: '{{GITHUB_ORG}}', repo: 'my-app' } },
        cloud: { provider: 'aws', config: { account_id: '{{AWS_ACCOUNT_ID}}' } },
        admin: { email: '{{ADMIN_EMAIL}}' },
      }),
    ).toBe(false)
  })

  it('rejects non-objects and empty objects', () => {
    expect(isTemplatePlaceholderConfig(null)).toBe(false)
    expect(isTemplatePlaceholderConfig('{{PROJECT_NAME}}')).toBe(false)
    expect(isTemplatePlaceholderConfig({})).toBe(false)
  })
})
