import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { type CoreManifest, isTemplateOwned } from './core-manifest.js'

/**
 * Ownership split for plugin Terraform modules.
 *
 * `modules/` is template-owned, but `biffo plugin install` copies a THIRD-party
 * plugin's `terraform/` into `modules/plugins/<name>/` (ADR-0003). That copy is
 * instance content the template will never ship, so it must be user-owned:
 *   - too broad (template-owned), and the ownership guard blocks the very
 *     install that writes it, and `core upgrade` proposes deleting it;
 *   - too narrow, and the scaffold source `modules/plugins/_template/` — which
 *     the template DOES maintain — stops riding `core upgrade`.
 *
 * So `modules/plugins/` is user-owned, and `modules/plugins/_template/` is carved
 * back to template-owned (a longer prefix wins). First-party plugins are
 * unaffected: their Terraform lives in template-owned `services/_plugins/<name>/`
 * and is referenced in place, never copied here.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const manifest: CoreManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'core-manifest.json'), 'utf8'),
)

describe('plugin modules ownership split', () => {
  it('marks the manifest prefixes so longest-prefix wins the right way', () => {
    expect(manifest.userOwned).toContain('modules/plugins/')
    expect(manifest.templateOwned).toContain('modules/plugins/_template/')
    expect(manifest.templateOwned).toContain('modules/')
  })

  it('a third-party plugin module is user-owned (install can commit it)', () => {
    expect(isTemplateOwned('modules/plugins/ideation/main.tf', manifest)).toBe(false)
    expect(isTemplateOwned('modules/plugins/acme-crm/variables.tf', manifest)).toBe(false)
  })

  it('the scaffold source stays template-owned (rides core upgrade)', () => {
    expect(isTemplateOwned('modules/plugins/_template/main.tf', manifest)).toBe(true)
  })

  it('other modules stay template-owned', () => {
    expect(isTemplateOwned('modules/cloud/aws/cdn/main.tf', manifest)).toBe(true)
    expect(isTemplateOwned('modules/cloud/aws/plugin-allowlist/main.tf', manifest)).toBe(true)
  })

  it('first-party plugin terraform stays template-owned (never copied to modules/plugins/)', () => {
    expect(isTemplateOwned('services/_plugins/orchestrator/terraform/main.tf', manifest)).toBe(true)
  })
})
