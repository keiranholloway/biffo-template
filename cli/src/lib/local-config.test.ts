import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTemplatePlaceholderConfig } from './local-config.js'

/**
 * Present in the template, deliberately absent in an instance: `biffo init`
 * deletes the placeholder `biffo.config.json` from the scaffolded repo (#269),
 * because an instance's real config lives in `~/.biffo/projects/` and
 * committing it would trip the `biffo-placeholder-config` gitleaks rule.
 *
 * `cli/` is template-owned, so this test file ships to every instance. Reading
 * the file unconditionally made CI fail on all three branches of every freshly
 * scaffolded repo, from its first push, naming a file that is *supposed* to be
 * missing — and because the JS job is a required status check, it wedged every
 * PR in a new instance until someone diagnosed it (#287).
 */
const TEMPLATE_CONFIG = resolve(import.meta.dirname, '../../../biffo.config.json')
const isTemplateRepo = existsSync(TEMPLATE_CONFIG)

describe('isTemplatePlaceholderConfig', () => {
  // Skipped in instances. The drift check below only means anything in the
  // template, where that file is the source of the very tokens being detected;
  // in an instance there is no placeholder config left to drift.
  it.skipIf(!isTemplateRepo)("recognises the template's own committed biffo.config.json", () => {
    // The real file, read from the template repo root — so this test fails the
    // day the template's placeholder tokens change shape.
    const raw = JSON.parse(readFileSync(TEMPLATE_CONFIG, 'utf8'))
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
