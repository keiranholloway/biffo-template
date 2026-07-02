import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REGISTRY_URL,
  fetchPluginBySlug,
  fetchPluginRegistry,
  installCommandFor,
  RegistryFetchError,
} from './plugin-registry'

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
      name: 'invoicing',
      version: '1.2.3',
      minor_version: '1.2',
      repo: 'https://github.com/keiranholloway/biffo-plugin-invoicing',
      description: 'Invoicing and billing',
      author: 'Biffo Team',
      tags: ['finance', 'billing'],
      required_core_version: '>=1.0.0',
      status: 'active',
    },
  ],
}

describe('plugin-registry', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('fetchPluginRegistry', () => {
    it('defaults to the real biffo-plugins-registry raw URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      global.fetch = fetchMock
      await fetchPluginRegistry()
      expect(fetchMock).toHaveBeenCalledWith(DEFAULT_REGISTRY_URL)
    })

    it('parses a valid registry response', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const registry = await fetchPluginRegistry('https://example.com/plugins.json')
      expect(registry.plugins).toHaveLength(1)
      expect(registry.plugins[0]?.name).toBe('invoicing')
    })

    it('throws a RegistryFetchError when the network request fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
      await expect(fetchPluginRegistry('https://example.com/plugins.json')).rejects.toThrow(
        RegistryFetchError,
      )
      await expect(fetchPluginRegistry('https://example.com/plugins.json')).rejects.toThrow(
        'Could not reach the plugin registry',
      )
    })

    it('throws when the registry responds with a non-2xx status', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, { status: 500, statusText: 'Internal Server Error' }))
      await expect(fetchPluginRegistry('https://example.com/plugins.json')).rejects.toThrow('500')
    })

    it('throws when the response body is not valid JSON', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
        )
      await expect(fetchPluginRegistry('https://example.com/plugins.json')).rejects.toThrow(
        'did not return valid JSON',
      )
    })

    it('throws when the registry JSON does not match the expected shape', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ oops: true }))
      await expect(fetchPluginRegistry('https://example.com/plugins.json')).rejects.toThrow(
        'unexpected shape',
      )
    })

    it('rejects a plugins array with a malformed entry', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          schema_version: '1.0',
          last_updated: '2026-06-30T00:00:00Z',
          plugins: [{ name: 'invoicing' }],
        }),
      )
      await expect(fetchPluginRegistry('https://example.com/plugins.json')).rejects.toThrow(
        'unexpected shape',
      )
    })
  })

  describe('fetchPluginBySlug', () => {
    it('returns the matching plugin entry', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const plugin = await fetchPluginBySlug('invoicing', 'https://example.com/plugins.json')
      expect(plugin?.version).toBe('1.2.3')
    })

    it('returns null (not an error) when the plugin is not in the registry', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const plugin = await fetchPluginBySlug('does-not-exist', 'https://example.com/plugins.json')
      expect(plugin).toBeNull()
    })

    it('returns null when the registry is empty (the current production state)', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          schema_version: '1.0',
          last_updated: '2026-06-30T00:00:00Z',
          plugins: [],
        }),
      )
      const plugin = await fetchPluginBySlug('invoicing', 'https://example.com/plugins.json')
      expect(plugin).toBeNull()
    })
  })

  describe('installCommandFor', () => {
    it('matches the exact CLI syntax: biffo plugin install <name>@<minor>', () => {
      expect(installCommandFor({ name: 'invoicing', minor_version: '1.2' })).toBe(
        'biffo plugin install invoicing@1.2',
      )
    })
  })
})
