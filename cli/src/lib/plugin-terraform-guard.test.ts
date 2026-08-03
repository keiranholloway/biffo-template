import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPluginTerraform, findPluginManifests } from './plugin-terraform-guard.js'
import { makeTmpDir } from '../test-utils/tmp.js'

let root: string

beforeEach(() => {
  root = makeTmpDir('plugin-tf-guard')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  { withTerraform = false } = {},
): void {
  const pluginDir = join(root, dir)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'biffo.plugin.json'), JSON.stringify(manifest, null, 2))
  if (withTerraform) {
    mkdirSync(join(pluginDir, 'terraform'))
    writeFileSync(join(pluginDir, 'terraform', 'main.tf'), '# module\n')
  }
}

const SUBSCRIBING = {
  name: 'example',
  event_subscriptions: [{ source: 'biffo.core', detail_type: 'UserCreated' }],
}

describe('findPluginManifests', () => {
  it('finds manifests at any depth and skips vendored trees', () => {
    writePlugin('services/orchestrator', SUBSCRIBING, { withTerraform: true })
    writePlugin('_skeletons/plugin-template', SUBSCRIBING, { withTerraform: true })
    writePlugin('node_modules/some-dep', SUBSCRIBING)
    writePlugin('.worktrees/wip/services/other', SUBSCRIBING)

    expect(findPluginManifests(root)).toEqual([
      '_skeletons/plugin-template/biffo.plugin.json',
      'services/orchestrator/biffo.plugin.json',
    ])
  })
})

describe('checkPluginTerraform', () => {
  it('flags a manifest declaring subscriptions with no terraform/', () => {
    writePlugin('services/example', SUBSCRIBING)

    const violations = checkPluginTerraform(root)

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      manifest: 'services/example/biffo.plugin.json',
      expectedTerraformDir: 'services/example/terraform',
      subscriptions: ['biffo.core/UserCreated'],
    })
  })

  it('passes when terraform/ is present', () => {
    writePlugin('services/example', SUBSCRIBING, { withTerraform: true })

    expect(checkPluginTerraform(root)).toEqual([])
  })

  it('passes a plugin that declares no subscriptions and needs no infra', () => {
    writePlugin('services/quiet', { name: 'quiet', event_subscriptions: [] })
    writePlugin('services/silent', { name: 'silent' })

    expect(checkPluginTerraform(root)).toEqual([])
  })

  it('covers the skeleton, which belongs to no workspace and no other CI job', () => {
    writePlugin('_skeletons/plugin-template', SUBSCRIBING)

    expect(checkPluginTerraform(root).map((v) => v.manifest)).toEqual([
      '_skeletons/plugin-template/biffo.plugin.json',
    ])
  })

  it('reports every offending plugin, not just the first', () => {
    writePlugin('services/a', SUBSCRIBING)
    writePlugin('services/b', SUBSCRIBING)
    writePlugin('services/ok', SUBSCRIBING, { withTerraform: true })

    expect(checkPluginTerraform(root).map((v) => v.manifest)).toEqual([
      'services/a/biffo.plugin.json',
      'services/b/biffo.plugin.json',
    ])
  })

  it('lists each subscription so the failure names what would go dead', () => {
    writePlugin('services/multi', {
      name: 'multi',
      event_subscriptions: [
        { source: 'biffo.core', detail_type: 'UserCreated' },
        { source: 'biffo.billing', detail_type: 'InvoicePaid' },
      ],
    })

    expect(checkPluginTerraform(root)[0]?.subscriptions).toEqual([
      'biffo.core/UserCreated',
      'biffo.billing/InvoicePaid',
    ])
  })

  it('ignores unparseable manifests — schema validation is a different check', () => {
    const dir = join(root, 'services/broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'biffo.plugin.json'), '{ not json')

    expect(checkPluginTerraform(root)).toEqual([])
  })
})

describe('template-owned scope (#327)', () => {
  // When a core-manifest.json is present, the guard must only assert over
  // template-owned plugin locations. A third-party plugin the instance installed
  // into user-owned services/<name>/ is not the template's to fix, so a
  // template-shipped gate must never red an instance's CI on it (the #325 class).
  function writeManifest(): void {
    writeFileSync(
      join(root, 'core-manifest.json'),
      JSON.stringify({
        version: 1,
        templateOwned: ['services/_plugins/', 'services/_template/', '_skeletons/'],
        userOwned: ['services/'],
      }),
    )
  }

  it('skips a user-owned third-party plugin, flags a template-owned one', () => {
    writeManifest()
    // Both declare a subscription and ship no terraform/ — the exact #194 defect.
    writePlugin('services/stripe-sync', SUBSCRIBING) // user-owned (services/<name>/)
    writePlugin('services/_plugins/orchestrator', SUBSCRIBING) // template-owned

    const violations = checkPluginTerraform(root)

    // Only the template-owned plugin is flagged; the third-party one is out of scope.
    expect(violations.map((v) => v.manifest)).toEqual([
      'services/_plugins/orchestrator/biffo.plugin.json',
    ])
  })

  it('still flags a skeleton plugin (template-owned) with the defect', () => {
    writeManifest()
    writePlugin('_skeletons/plugin-template', SUBSCRIBING)

    expect(checkPluginTerraform(root).map((v) => v.manifest)).toEqual([
      '_skeletons/plugin-template/biffo.plugin.json',
    ])
  })
})

describe('the real repository', () => {
  it('has no plugin declaring subscriptions without terraform/', () => {
    // Guards the guard: this is the assertion that would have caught #194, run
    // against the actual tree rather than a fixture.
    const repoRoot = join(__dirname, '..', '..', '..')

    expect(checkPluginTerraform(repoRoot)).toEqual([])
  })
})
