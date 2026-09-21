import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPluginRegistryReady,
  frontendUrlForSlug,
  pluginRegistryExists,
  PLUGIN_REGISTRY_RELATIVE_PATH,
  removePluginRegistryEntry,
  titleFromSlug,
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
  slug: 'widgets',
  title: 'Widgets',
  frontendUrl: '/api/v1/plugins/widgets/ui',
}

/**
 * The real `biffo-platform-app` `apps/frontend/src/lib/plugins.ts`
 * (`.worktrees/lander-reconverge-71-73`, PR #73) — declared type is
 * `{ slug: string; title: string; frontendUrl: string }`, and its two
 * pre-existing entries reference imported URL constants rather than string
 * literals, exactly as #2047 reproduced live (not a synthetic fixture).
 */
const REAL_PLUGINS_TS_PREAMBLE =
  'export type PluginManifest = {\n' +
  '  slug: string\n' +
  '  title: string\n' +
  '  frontendUrl: string\n' +
  '}\n\n' +
  'export const INSTALLED_PLUGINS: PluginManifest[] = [\n'

const REAL_PLUGINS_TS_BODY =
  "  { slug: 'ideation-engine', title: 'Ideation Engine', frontendUrl: IDEATION_ENGINE_URL },\n" +
  "  { slug: 'new-idea-scout', title: 'New Idea Scout', frontendUrl: IDEA_SCOUT_URL },\n"

/**
 * Reproduces #2047's repro step 3: the real file's two existing entries
 * wrapped in the managed-region markers (simulating the migration a sibling
 * adopting this pattern needs to do).
 */
function makeRealPlatformAppRegistry(root: string): void {
  const dir = join(root, 'apps', 'frontend', 'src', 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(root, PLUGIN_REGISTRY_RELATIVE_PATH),
    REAL_PLUGINS_TS_PREAMBLE +
      '  // BIFFO-PLUGIN-REGISTRY:START — managed by `biffo plugin install`/`uninstall`. Do not hand-edit.\n' +
      REAL_PLUGINS_TS_BODY +
      '  // BIFFO-PLUGIN-REGISTRY:END\n' +
      ']\n',
    'utf8',
  )
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

describe('titleFromSlug', () => {
  it('MUST-CATCH: title-cases a kebab-case slug, matching the real registry entries exactly', () => {
    // The exact two slugs/titles from biffo-platform-app's real plugins.ts (#2047).
    expect(titleFromSlug('ideation-engine')).toBe('Ideation Engine')
    expect(titleFromSlug('new-idea-scout')).toBe('New Idea Scout')
  })

  it('MUST-NOT-CATCH: a single-word slug is just capitalized, no stray space', () => {
    expect(titleFromSlug('widgets')).toBe('Widgets')
  })
})

describe('frontendUrlForSlug', () => {
  it('MUST-CATCH: derives the shared plugin host UI mount path (ADR-0021 §2)', () => {
    expect(frontendUrlForSlug('widgets')).toBe('/api/v1/plugins/widgets/ui')
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
  it('MUST-CATCH: adds a new entry into the managed region, shaped like the real PluginManifest type', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)

    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).toContain('slug: "widgets"')
    expect(contents).toContain('title: "Widgets"')
    expect(contents).toContain('frontendUrl: "/api/v1/plugins/widgets/ui"')
    // The old, non-conforming shape must never appear.
    expect(contents).not.toContain('requiredGroup')
    expect(contents).not.toContain('name: "widgets"')
    // The hand-authored parts of the file survive untouched.
    expect(contents).toContain('import type { PluginManifest } from "./plugin-types"')
    expect(contents).toContain('export const INSTALLED_PLUGINS')
  })

  it('MUST-CATCH: re-running install (e.g. a version bump changing the URL) replaces, not duplicates, the entry', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)

    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)
    upsertPluginRegistryEntry(root, { ...WIDGETS_ENTRY, title: 'Widgets v2' })

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents.match(/slug: "widgets"/g)).toHaveLength(1)
    expect(contents).toContain('title: "Widgets v2"')
    expect(contents).not.toContain('title: "Widgets"\n')
  })

  it('MUST-NOT-CATCH: leaves an unrelated plugin already registered by this CLI untouched', () => {
    const root = makeProjectRoot()
    writeManagedRegistry(root)
    upsertPluginRegistryEntry(root, {
      slug: 'acme-crm',
      title: 'Acme CRM',
      frontendUrl: '/api/v1/plugins/acme-crm/ui',
    })

    upsertPluginRegistryEntry(root, WIDGETS_ENTRY)

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).toContain('slug: "acme-crm"')
    expect(contents).toContain('slug: "widgets"')
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
      title: 'Say "hello" Widgets',
    })

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).toContain('title: "Say \\"hello\\" Widgets"')
  })

  describe('#2047 — preserving entries this CLI did not write', () => {
    it('MUST-CATCH: a create-or-update against the REAL biffo-platform-app registry preserves both pre-existing entries verbatim', () => {
      const root = makeProjectRoot()
      makeRealPlatformAppRegistry(root)

      upsertPluginRegistryEntry(root, {
        slug: 'verify-plugin',
        title: titleFromSlug('verify-plugin'),
        frontendUrl: frontendUrlForSlug('verify-plugin'),
      })

      const contents = readFileSync(registryFilePath(root), 'utf8')
      // The two hand-authored entries — including their bare-identifier
      // frontendUrl, which could never survive a JSON.stringify round-trip —
      // must still be present, exactly as written.
      expect(contents).toContain(
        "{ slug: 'ideation-engine', title: 'Ideation Engine', frontendUrl: IDEATION_ENGINE_URL }",
      )
      expect(contents).toContain(
        "{ slug: 'new-idea-scout', title: 'New Idea Scout', frontendUrl: IDEA_SCOUT_URL }",
      )
      // And the newly installed plugin is there too, in the conforming shape.
      expect(contents).toContain('slug: "verify-plugin"')
      expect(contents).toContain('frontendUrl: "/api/v1/plugins/verify-plugin/ui"')
    })

    it('MUST-CATCH: re-installing the same plugin against the real registry replaces only its own entry', () => {
      const root = makeProjectRoot()
      makeRealPlatformAppRegistry(root)
      upsertPluginRegistryEntry(root, {
        slug: 'verify-plugin',
        title: 'Verify Plugin',
        frontendUrl: '/api/v1/plugins/verify-plugin/ui',
      })

      upsertPluginRegistryEntry(root, {
        slug: 'verify-plugin',
        title: 'Verify Plugin v2',
        frontendUrl: '/api/v1/plugins/verify-plugin/ui',
      })

      const contents = readFileSync(registryFilePath(root), 'utf8')
      expect(contents.match(/slug: "verify-plugin"/g)).toHaveLength(1)
      expect(contents).toContain('title: "Verify Plugin v2"')
      expect(contents).toContain('IDEATION_ENGINE_URL')
      expect(contents).toContain('IDEA_SCOUT_URL')
    })
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
      slug: 'acme-crm',
      title: 'Acme CRM',
      frontendUrl: '/api/v1/plugins/acme-crm/ui',
    })

    removePluginRegistryEntry(root, 'widgets')

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).not.toContain('slug: "widgets"')
    expect(contents).toContain('slug: "acme-crm"')
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

  it('MUST-CATCH: removing against the REAL biffo-platform-app registry preserves the other pre-existing entry', () => {
    const root = makeProjectRoot()
    makeRealPlatformAppRegistry(root)
    upsertPluginRegistryEntry(root, {
      slug: 'verify-plugin',
      title: 'Verify Plugin',
      frontendUrl: '/api/v1/plugins/verify-plugin/ui',
    })

    removePluginRegistryEntry(root, 'verify-plugin')

    const contents = readFileSync(registryFilePath(root), 'utf8')
    expect(contents).not.toContain('verify-plugin')
    expect(contents).toContain(
      "{ slug: 'ideation-engine', title: 'Ideation Engine', frontendUrl: IDEATION_ENGINE_URL }",
    )
    expect(contents).toContain(
      "{ slug: 'new-idea-scout', title: 'New Idea Scout', frontendUrl: IDEA_SCOUT_URL }",
    )
  })
})
