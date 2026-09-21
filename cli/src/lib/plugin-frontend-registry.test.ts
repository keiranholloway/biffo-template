import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPluginRegistryReady,
  pluginRegistryExists,
  PLUGIN_REGISTRY_RELATIVE_PATH,
  removePluginRegistryEntry,
  upsertPluginRegistryEntry,
} from './plugin-frontend-registry.js'
import { makeTmpDir } from '../test-utils/tmp.js'

function makeProjectRoot(): string {
  return makeTmpDir('biffo-project')
}

function registryFilePath(root: string): string {
  return join(root, PLUGIN_REGISTRY_RELATIVE_PATH)
}

function writeManagedRegistry(root: string, body = ''): void {
  const path = registryFilePath(root)
  mkdirSync(join(root, 'apps', 'frontend', 'src', 'lib'), { recursive: true })
  writeFileSync(
    path,
    'import type { PluginManifest } from "./plugin-types"\n\n' +
      'export const INSTALLED_PLUGINS: PluginManifest[] = [\n' +
      '  // BIFFO-PLUGIN-REGISTRY:START — managed by `biffo plugin install`/`uninstall`. Do not hand-edit.\n' +
      body +
      '  // BIFFO-PLUGIN-REGISTRY:END\n' +
      ']\n',
    'utf8',
  )
}

const WIDGETS_ENTRY = {
  name: 'widgets',
  version: '1.0.0',
  description: 'Widgets plugin',
  requiredGroup: 'founder',
}

describe('pluginRegistryExists', () => {
  it('MUST-NOT-CATCH: reports false when apps/frontend/src/lib/plugins.ts is absent', () => {
    const root = makeProjectRoot()
    expect(pluginRegistryExists(root)).toBe(false)
  })

  it('MUST-CATCH: reports true once the file exists', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    expect(pluginRegistryExists(root)).toBe(true)
  })
})

describe('assertPluginRegistryReady — fail-closed guard', () => {
  it('MUST-CATCH: throws a clear, actionable error when the registry file does not exist', () => {
    const root = makeProjectRoot()
    expect(() => assertPluginRegistryReady(root, 'widgets')).toThrow(
      /apps\/frontend\/src\/lib\/plugins\.ts does not exist/,
    )
    expect(() => assertPluginRegistryReady(root, 'widgets')).toThrow(/widgets/)
  })

  it('MUST-CATCH: throws when the file exists but carries no managed region', () => {
    const root = makeProjectRoot()
    mkdirSync(join(root, 'apps', 'frontend', 'src', 'lib'), { recursive: true })
    writeFileSync(
      registryFilePath(root),
      'export const INSTALLED_PLUGINS: PluginManifest[] = []\n',
      'utf8',
    )
    expect(() => assertPluginRegistryReady(root, 'widgets')).toThrow(/managed/)
  })

  it('MUST-NOT-CATCH: does not throw when the managed region is present (even empty)', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    expect(() => assertPluginRegistryReady(root, 'widgets')).not.toThrow()
  })
})

describe('upsertPluginRegistryEntry', () => {
  it('MUST-CATCH: adds a new entry into the managed region', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)

    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).toContain('name: "widgets"')
    expect(contents).toContain('version: "1.0.0"')
    expect(contents).toContain('description: "Widgets plugin"')
    expect(contents).toContain('requiredGroup: "founder"')
    // The hand-authored parts of the file survive untouched.
    expect(contents).toContain('import type { PluginManifest } from "./plugin-types"')
    expect(contents).toContain('export const INSTALLED_PLUGINS')
  })

  it('MUST-CATCH: re-running install (version bump) replaces, not duplicates, the entry', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)

    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)
    upsertPluginRegistryEntry(root, { ...WIDGETS_ENTRY, version: '1.1.0' })

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents.match(/name: "widgets"/g)).toHaveLength(1)
    expect(contents).toContain('version: "1.1.0"')
    expect(contents).not.toContain('version: "1.0.0"')
  })

  it('MUST-NOT-CATCH: leaves an unrelated plugin already registered untouched', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    upsertPluginRegistryEntry(root, {
      name: 'acme-crm',
      version: '2.0.0',
      description: 'CRM plugin',
      requiredGroup: 'founder',
    })

    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).toContain('name: "acme-crm"')
    expect(contents).toContain('name: "widgets"')
  })

  it('MUST-CATCH: throws and writes nothing when the registry file is missing (fail closed)', () => {
    const root = makeProjectRoot()
    expect(() => upsertPluginRegistryEntry(root, WIDGETS_ENTRY)).toThrow(
      /apps\/frontend\/src\/lib\/plugins\.ts does not exist/,
    )
  })

  it('MUST-CATCH: escapes a double-quote in a field so the written source stays valid', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)

    upsertPluginRegistryEntry(root, {
      ...WIDGETS_ENTRY,
      description: 'Say "hello" to widgets',
    })

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).toContain('description: "Say \\"hello\\" to widgets"')
  })
})

describe('removePluginRegistryEntry', () => {
  it('MUST-CATCH: removes a previously-installed entry', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)

    removePluginRegistryEntry(root, 'widgets')

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).not.toContain('widgets')
  })

  it('MUST-NOT-CATCH: leaves a different plugin entry in place', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)
    upsertPluginRegistryEntry(root, {
      name: 'acme-crm',
      version: '2.0.0',
      description: 'CRM plugin',
      requiredGroup: 'founder',
    })

    removePluginRegistryEntry(root, 'widgets')

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).not.toContain('name: "widgets"')
    expect(contents).toContain('name: "acme-crm"')
  })

  it('MUST-CATCH: throws (fail closed) when the registry file is missing', () => {
    const root = makeProjectRoot()
    expect(() => removePluginRegistryEntry(root, 'widgets')).toThrow(
      /apps\/frontend\/src\/lib\/plugins\.ts does not exist/,
    )
  })

  it('MUST-NOT-CATCH: removing an entry that was never present is a no-op, not an error', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    expect(() => removePluginRegistryEntry(root, 'never-installed')).not.toThrow()
  })
})
