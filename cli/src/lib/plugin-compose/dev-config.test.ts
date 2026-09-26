import { describe, expect, it } from 'vitest'
import { validateManifest } from '../plugin-manifest.js'
import { pluginConfigEnvNames } from '../plugin-config-resolution.js'
import { resolveDevConfig } from './dev-config.js'

const manifest = validateManifest({
  name: 'my-plugin',
  version: '0.1.0',
  description: 'd',
  author: 'a',
  config: [
    { name: 'greeting', kind: 'setting', required: true, description: 'text' },
    { name: 'api_key', kind: 'secret', required: true, description: 'key' },
    { name: 'optional_one', kind: 'setting', required: false, description: 'opt' },
  ],
})

describe('resolveDevConfig — the install resolution path, fed from a local file', () => {
  it('produces the SAME env var names install computes, and parks a secret behind an SSM path', () => {
    const cfg = resolveDevConfig(manifest, { greeting: 'hi', api_key: 'sekrit' }, 'test file')
    const g = pluginConfigEnvNames('my-plugin', 'greeting')
    const k = pluginConfigEnvNames('my-plugin', 'api_key')
    expect(cfg.env[g.literalEnv]).toBe('hi')
    // The secret env var holds a PATH (what install holds), never the value itself.
    expect(cfg.env[k.parameterEnv]).toBe('/biffo-dev/my-plugin/api_key')
    expect(Object.values(cfg.env)).not.toContain('sekrit')
    expect(cfg.parameters.get('/biffo-dev/my-plugin/api_key')).toBe('sekrit')
    expect(k.literalEnv in cfg.env).toBe(false)
  })

  it('never puts a secret value in the printed summary', () => {
    const cfg = resolveDevConfig(manifest, { greeting: 'hi', api_key: 'sekrit' }, 'f')
    expect(cfg.summary.join('\n')).not.toContain('sekrit')
    expect(cfg.summary).toHaveLength(2)
  })

  it('a missing REQUIRED value fails, naming it and the source', () => {
    expect(() => resolveDevConfig(manifest, { greeting: 'hi' }, 'biffo.dev.json')).toThrow(
      /api_key.*\n?[\s\S]*biffo\.dev\.json|biffo\.dev\.json[\s\S]*api_key/,
    )
  })

  it('an empty file for a manifest with required config still fails (no vacuous pass)', () => {
    expect(() => resolveDevConfig(manifest, {}, 'no file')).toThrow(/2 required config value/)
  })

  it('a key the manifest does not declare is rejected — a typo must not leave the real entry unconfigured', () => {
    expect(() =>
      resolveDevConfig(manifest, { greeting: 'x', api_key: 'y', grating: 'typo' }, 'f'),
    ).toThrow(/does not declare: grating/)
  })

  it('a plugin with no config declarations and no file resolves to nothing', () => {
    const bare = validateManifest({ name: 'p', version: '0.1.0', description: 'd', author: 'a' })
    expect(resolveDevConfig(bare, {}, 'f')).toEqual({
      env: {},
      parameters: new Map(),
      summary: [],
    })
  })
})
