import { describe, expect, it } from 'vitest'
import type { ConfigDeclaration } from './plugin-config-resolution.js'
import {
  missingRequiredConfigMessage,
  parseConfigOptionValues,
  pluginConfigEnvNames,
  resolvePluginConfigSupply,
} from './plugin-config-resolution.js'

// biffo-template#1947 — this module (resolvePluginConfigSupply,
// missingRequiredConfigMessage, pluginConfigEnvNames, parseConfigOptionValues)
// is the entire install-time enforcement logic for biffo-template#1517 Option
// B (shipped in #1946) and had zero test coverage anywhere in the repo before
// this file. A future refactor could silently break the fail-closed check
// and CI would stay green — these tests are what would catch that.

function decl(overrides: Partial<ConfigDeclaration> = {}): ConfigDeclaration {
  return {
    name: 'api_key',
    kind: 'setting',
    required: true,
    description: 'A test config need.',
    ...overrides,
  }
}

describe('pluginConfigEnvNames', () => {
  it('computes BIFFO_PLUGIN_<PLUGIN>_<NAME> and its _PARAMETER sibling', () => {
    expect(pluginConfigEnvNames('widgets', 'api_key')).toEqual({
      literalEnv: 'BIFFO_PLUGIN_WIDGETS_API_KEY',
      parameterEnv: 'BIFFO_PLUGIN_WIDGETS_API_KEY_PARAMETER',
    })
  })

  it('uppercases and replaces hyphens in a kebab-case plugin name', () => {
    // Manifest `name` is kebab-case (PluginManifestSchema regex
    // /^[a-z][a-z0-9-]*$/), so a real plugin name can contain hyphens — these
    // must not survive into the env var name (an env var name cannot contain
    // '-'). This is pinned byte-for-byte against the Python SDK's
    // plugin_config_env_names per the module's own docstring, so a drift here
    // silently breaks cross-language agreement.
    expect(pluginConfigEnvNames('acme-crm', 'db_password')).toEqual({
      literalEnv: 'BIFFO_PLUGIN_ACME_CRM_DB_PASSWORD',
      parameterEnv: 'BIFFO_PLUGIN_ACME_CRM_DB_PASSWORD_PARAMETER',
    })
  })

  it('scopes by plugin name so two plugins declaring the same config name never collide', () => {
    const a = pluginConfigEnvNames('widgets', 'api_key')
    const b = pluginConfigEnvNames('gadgets', 'api_key')
    expect(a.literalEnv).not.toBe(b.literalEnv)
    expect(a.parameterEnv).not.toBe(b.parameterEnv)
  })
})

describe('resolvePluginConfigSupply', () => {
  it('resolves a supplied setting to its literal env var name', () => {
    const result = resolvePluginConfigSupply(
      'widgets',
      [decl({ name: 'theme', kind: 'setting', required: true })],
      { theme: 'dark' },
    )
    expect(result.missingRequired).toEqual([])
    expect(result.resolved).toEqual([
      {
        name: 'theme',
        kind: 'setting',
        description: 'A test config need.',
        value: 'dark',
        envName: 'BIFFO_PLUGIN_WIDGETS_THEME',
      },
    ])
  })

  it('resolves a supplied secret (SSM path) to its _PARAMETER env var name', () => {
    const result = resolvePluginConfigSupply(
      'widgets',
      [decl({ name: 'api_key', kind: 'secret', required: true })],
      { api_key: '/widgets/dev/api_key' },
    )
    expect(result.missingRequired).toEqual([])
    expect(result.resolved).toEqual([
      {
        name: 'api_key',
        kind: 'secret',
        description: 'A test config need.',
        value: '/widgets/dev/api_key',
        envName: 'BIFFO_PLUGIN_WIDGETS_API_KEY_PARAMETER',
      },
    ])
  })

  it('reports a required declaration with no supplied value as missing', () => {
    const result = resolvePluginConfigSupply(
      'widgets',
      [decl({ name: 'api_key', kind: 'secret', required: true })],
      {},
    )
    expect(result.resolved).toEqual([])
    expect(result.missingRequired).toEqual([
      { name: 'api_key', kind: 'secret', description: 'A test config need.' },
    ])
  })

  it('does not report an optional (required: false) declaration with no supplied value as missing', () => {
    const result = resolvePluginConfigSupply(
      'widgets',
      [decl({ name: 'api_key', kind: 'setting', required: false })],
      {},
    )
    expect(result.resolved).toEqual([])
    expect(result.missingRequired).toEqual([])
  })

  it('treats a whitespace-only supplied value as not supplied', () => {
    // `.trim()` in the implementation — an operator passing `--config
    // api_key=  ` (accidental trailing/leading whitespace, or an empty value
    // from a shell variable substitution) must not silently satisfy a
    // required declaration.
    const result = resolvePluginConfigSupply(
      'widgets',
      [decl({ name: 'api_key', kind: 'setting', required: true })],
      { api_key: '   ' },
    )
    expect(result.resolved).toEqual([])
    expect(result.missingRequired).toEqual([
      { name: 'api_key', kind: 'setting', description: 'A test config need.' },
    ])
  })

  it('throws for a secret value that does not start with /', () => {
    expect(() =>
      resolvePluginConfigSupply(
        'widgets',
        [decl({ name: 'api_key', kind: 'secret', required: true })],
        { api_key: 'pasted-credential-not-a-path' },
      ),
    ).toThrow(/must be an SSM parameter PATH/)
  })

  it('throws for a secret value even when it is not required', () => {
    // The refusal is about the SHAPE of the supplied value, not whether it
    // was required — an operator who supplies a credential by mistake must
    // be stopped regardless of the declaration's `required` flag.
    expect(() =>
      resolvePluginConfigSupply(
        'widgets',
        [decl({ name: 'api_key', kind: 'secret', required: false })],
        { api_key: 'pasted-credential-not-a-path' },
      ),
    ).toThrow(/must be an SSM parameter PATH/)
  })

  it('accepts a secret value that starts with /', () => {
    expect(() =>
      resolvePluginConfigSupply(
        'widgets',
        [decl({ name: 'api_key', kind: 'secret', required: true })],
        { api_key: '/widgets/dev/api_key' },
      ),
    ).not.toThrow()
  })

  it('does not apply the SSM-path check to a setting kind', () => {
    // A 'setting' declaration's value is never a credential reference — a
    // literal value that happens not to start with '/' must resolve normally.
    const result = resolvePluginConfigSupply(
      'widgets',
      [decl({ name: 'theme', kind: 'setting', required: true })],
      { theme: 'dark-mode' },
    )
    expect(result.missingRequired).toEqual([])
    expect(result.resolved[0]!.value).toBe('dark-mode')
  })

  it('resolves multiple declarations independently, mixing resolved and missing', () => {
    const result = resolvePluginConfigSupply(
      'widgets',
      [
        decl({ name: 'theme', kind: 'setting', required: true }),
        decl({ name: 'api_key', kind: 'secret', required: true }),
        decl({ name: 'optional_flag', kind: 'setting', required: false }),
      ],
      { theme: 'dark' },
    )
    expect(result.resolved.map((r) => r.name)).toEqual(['theme'])
    expect(result.missingRequired.map((m) => m.name)).toEqual(['api_key'])
  })

  it('ignores a supplied value for a name the manifest does not declare', () => {
    const result = resolvePluginConfigSupply('widgets', [decl({ name: 'theme' })], {
      theme: 'dark',
      unrelated_key: 'value',
    })
    expect(result.resolved).toEqual([
      {
        name: 'theme',
        kind: 'setting',
        description: 'A test config need.',
        value: 'dark',
        envName: 'BIFFO_PLUGIN_WIDGETS_THEME',
      },
    ])
  })

  it('returns empty results for an empty declaration list', () => {
    const result = resolvePluginConfigSupply('widgets', [], { theme: 'dark' })
    expect(result).toEqual({ resolved: [], missingRequired: [] })
  })
})

describe('parseConfigOptionValues', () => {
  it('parses repeatable name=value entries into a record', () => {
    expect(parseConfigOptionValues(['theme=dark', 'api_key=/widgets/dev/api_key'])).toEqual({
      theme: 'dark',
      api_key: '/widgets/dev/api_key',
    })
  })

  it('returns an empty record for no entries', () => {
    expect(parseConfigOptionValues([])).toEqual({})
  })

  it('throws for an entry with no =', () => {
    expect(() => parseConfigOptionValues(['theme-dark'])).toThrow(/name=value/)
  })

  it('throws for an entry with an empty name', () => {
    expect(() => parseConfigOptionValues(['=dark'])).toThrow(/name=value/)
  })

  it('preserves = characters within the value (splits on the first = only)', () => {
    // A base64 or URL-encoded value can legitimately contain '=' — the option
    // must not be parsed with a naive split('=') that would truncate it.
    expect(parseConfigOptionValues(['token=abc=def=='])).toEqual({ token: 'abc=def==' })
  })

  it('allows an empty value after the =', () => {
    // Distinct from a missing entry entirely — parseConfigOptionValues must
    // not throw here; resolvePluginConfigSupply is what decides an empty
    // value counts as "not supplied" for a required declaration.
    expect(parseConfigOptionValues(['theme='])).toEqual({ theme: '' })
  })
})

describe('missingRequiredConfigMessage', () => {
  it('lists every missing declaration with its kind and description', () => {
    const message = missingRequiredConfigMessage('widgets', [
      { name: 'api_key', kind: 'secret', description: 'API credential for the widget service.' },
      { name: 'theme', kind: 'setting', description: 'UI theme.' },
    ])
    expect(message).toContain("Plugin 'widgets' declares 2 required config value(s)")
    expect(message).toContain('api_key (secret): API credential for the widget service.')
    expect(message).toContain('theme (setting): UI theme.')
    expect(message).toContain('--config <name>=<value>')
  })

  it('instructs never to pass the credential itself for a secret', () => {
    const message = missingRequiredConfigMessage('widgets', [
      { name: 'api_key', kind: 'secret', description: 'API credential.' },
    ])
    expect(message).toMatch(/never the credential itself/i)
  })
})
