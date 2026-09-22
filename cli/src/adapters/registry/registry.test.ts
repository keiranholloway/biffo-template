import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REGISTRY_URL, RegistryAdapter } from './index.js'

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  })
}

const VALID_REGISTRY = {
  schema_version: '1.0',
  last_updated: '2026-06-30T00:00:00Z',
  plugins: [
    {
      name: 'rbac',
      version: '1.2.3',
      minor_version: '1.2',
      repo: 'https://github.com/keiranholloway/biffo-plugin-rbac',
      description: 'RBAC plugin',
      status: 'active',
    },
    {
      name: 'rbac',
      version: '2.0.0',
      minor_version: '2.0',
      repo: 'https://github.com/keiranholloway/biffo-plugin-rbac',
      status: 'disabled',
    },
  ],
}

describe('RegistryAdapter', () => {
  const originalFetch = global.fetch
  const originalEnvUrl = process.env['BIFFO_REGISTRY_URL']

  beforeEach(() => {
    delete process.env['BIFFO_REGISTRY_URL']
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalEnvUrl === undefined) delete process.env['BIFFO_REGISTRY_URL']
    else process.env['BIFFO_REGISTRY_URL'] = originalEnvUrl
    vi.restoreAllMocks()
  })

  describe('construction', () => {
    it('defaults to the real biffo-plugins-registry raw URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      global.fetch = fetchMock
      await new RegistryAdapter().fetchRegistry()
      expect(fetchMock).toHaveBeenCalledWith(DEFAULT_REGISTRY_URL)
    })

    it('honours an explicit constructor URL over the env var', async () => {
      process.env['BIFFO_REGISTRY_URL'] = 'https://example.com/env-registry.json'
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      global.fetch = fetchMock
      await new RegistryAdapter('https://example.com/explicit-registry.json').fetchRegistry()
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/explicit-registry.json')
    })

    it('falls back to BIFFO_REGISTRY_URL when set', async () => {
      process.env['BIFFO_REGISTRY_URL'] = 'https://example.com/env-registry.json'
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      global.fetch = fetchMock
      await new RegistryAdapter().fetchRegistry()
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/env-registry.json')
    })
  })

  describe('fetchRegistry', () => {
    it('parses a valid registry response', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      const registry = await adapter.fetchRegistry()
      expect(registry.plugins).toHaveLength(2)
    })

    it('skips a single malformed entry (legacy string ui_components, #1555) and still resolves the rest (#2050)', async () => {
      // Real reproduction shape (#2050 issue body, verified 2026-09-22
      // against the live registry): `ui_components` used to be `string[]`
      // and #1555 tightened it to an array of objects. A registry entry
      // still carrying the old shape must not take down every OTHER entry's
      // resolution — only its own.
      const registryWithOneBadEntry = {
        schema_version: '1.0',
        last_updated: '2026-09-22T00:00:00Z',
        plugins: [
          {
            name: 'idea-scout',
            version: '1.0.0',
            minor_version: '1.0',
            repo: 'https://github.com/keiranholloway/biffo-plugin-idea-scout',
            status: 'active',
            ui_components: ['nav-link', 'page'], // legacy string[] shape — malformed
          },
          {
            name: 'marketing',
            version: '2.1.0',
            minor_version: '2.1',
            repo: 'https://github.com/keiranholloway/biffo-plugin-marketing',
            status: 'active',
            ui_components: [{ type: 'nav-link', label: 'Marketing', path: '/marketing' }],
          },
        ],
      }
      global.fetch = vi.fn().mockImplementation(() => jsonResponse(registryWithOneBadEntry))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const adapter = new RegistryAdapter('https://example.com/plugins.json')

      const registry = await adapter.fetchRegistry()

      // The malformed 'idea-scout' entry is dropped...
      expect(registry.plugins.map((p) => p.name)).toEqual(['marketing'])
      // ...but 'marketing' still resolves, which is the whole point: one bad
      // entry must never break lookup of another plugin.
      const marketing = await adapter.resolvePlugin('marketing', '2.1')
      expect(marketing.status).toBe('active')
      // And the drop is visible, not silent.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("'idea-scout'"),
      )
      warnSpy.mockRestore()
    })

    it('still throws on a genuinely wrong envelope shape, not just a bad entry', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ oops: true }))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.fetchRegistry()).rejects.toThrow('invalid shape')
    })

    it('throws a clear error when the network request fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.fetchRegistry()).rejects.toThrow('Could not reach the plugin registry')
    })

    it('throws when the registry responds with a non-2xx status', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, { status: 404, statusText: 'Not Found' }))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.fetchRegistry()).rejects.toThrow('404')
    })

    it('throws when the response body is not valid JSON', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
        )
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.fetchRegistry()).rejects.toThrow('did not return valid JSON')
    })

    it('throws when the registry JSON does not match the expected shape', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ oops: true }))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.fetchRegistry()).rejects.toThrow('invalid shape')
    })
  })

  describe('resolvePlugin', () => {
    it('resolves an active plugin at the requested minor version', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      const entry = await adapter.resolvePlugin('rbac', '1.2')
      expect(entry.version).toBe('1.2.3')
    })

    it('throws when the plugin name is not in the registry', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.resolvePlugin('invoicing', '1.0')).rejects.toThrow(
        "Plugin 'invoicing' was not found",
      )
    })

    it('throws with available versions when the minor does not match', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.resolvePlugin('rbac', '9.9')).rejects.toThrow('rbac@1.2 (active)')
    })

    it('throws when the resolved entry is disabled', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.resolvePlugin('rbac', '2.0')).rejects.toThrow('is disabled')
    })

    it('throws when the registry itself is empty', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          schema_version: '1.0',
          last_updated: '2026-06-30T00:00:00Z',
          plugins: [],
        }),
      )
      const adapter = new RegistryAdapter('https://example.com/plugins.json')
      await expect(adapter.resolvePlugin('rbac', '1.0')).rejects.toThrow('was not found')
    })
  })
})
