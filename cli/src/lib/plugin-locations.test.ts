import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findInstalledPlugin, findInstalledPlugins, pluginDir } from './plugin-locations.js'
import { makeTmpDir } from '../test-utils/tmp.js'

let cwd: string

function install(relDir: string): void {
  mkdirSync(join(cwd, relDir), { recursive: true })
  writeFileSync(join(cwd, relDir, 'biffo.plugin.json'), '{}')
}

beforeEach(() => {
  cwd = makeTmpDir('biffo-plugin-locations')
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('pluginDir', () => {
  it('routes first-party plugins into the template-owned carve-out', () => {
    expect(pluginDir('orchestrator', 'first-party')).toBe('services/_plugins/orchestrator')
  })
  it('routes third-party plugins into the user-owned services/ subtree', () => {
    expect(pluginDir('acme-crm', 'third-party')).toBe('services/acme-crm')
  })
})

describe('findInstalledPlugins', () => {
  it('returns nothing when there is no services/ directory at all', () => {
    expect(findInstalledPlugins(cwd)).toEqual([])
  })

  it('finds plugins in both channels and labels each with its channel', () => {
    install('services/_plugins/orchestrator')
    install('services/acme-crm')

    expect(findInstalledPlugins(cwd).map((p) => [p.relDir, p.channel])).toEqual([
      ['services/_plugins/orchestrator', 'first-party'],
      ['services/acme-crm', 'third-party'],
    ])
  })

  it('does not mistake the _plugins container itself for a plugin', () => {
    // A stray manifest directly in services/_plugins/ is not a plugin: the
    // container is a channel marker, only its children are plugins.
    mkdirSync(join(cwd, 'services', '_plugins'), { recursive: true })
    writeFileSync(join(cwd, 'services', '_plugins', 'biffo.plugin.json'), '{}')
    expect(findInstalledPlugins(cwd)).toEqual([])
  })

  it('ignores a service directory with no manifest (services/api is not a plugin)', () => {
    mkdirSync(join(cwd, 'services', 'api', 'src'), { recursive: true })
    expect(findInstalledPlugins(cwd)).toEqual([])
  })

  it('is sorted by repo-relative path for deterministic output', () => {
    install('services/zeta')
    install('services/alpha')
    install('services/_plugins/orchestrator')
    expect(findInstalledPlugins(cwd).map((p) => p.relDir)).toEqual([
      'services/_plugins/orchestrator',
      'services/alpha',
      'services/zeta',
    ])
  })
})

describe('findInstalledPlugin', () => {
  it('resolves a name in either channel', () => {
    install('services/_plugins/orchestrator')
    install('services/acme-crm')
    expect(findInstalledPlugin(cwd, 'orchestrator')?.channel).toBe('first-party')
    expect(findInstalledPlugin(cwd, 'acme-crm')?.channel).toBe('third-party')
  })

  it('returns null for a name that is not installed', () => {
    expect(findInstalledPlugin(cwd, 'nope')).toBeNull()
  })

  it('prefers first-party when a name is (mis)configured in both channels', () => {
    // A plugin name is globally unique — it keys the Terraform module and the
    // Lambda — so this is a misconfiguration, but resolution must be defined.
    install('services/_plugins/dupe')
    install('services/dupe')
    expect(findInstalledPlugin(cwd, 'dupe')?.relDir).toBe('services/_plugins/dupe')
  })
})
