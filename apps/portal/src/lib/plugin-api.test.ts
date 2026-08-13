import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchActivePlugins,
  fetchInstalledPlugins,
  fetchPluginRegistry,
  PluginRegistryError,
  REGISTRY_URL,
  type InstalledPlugin,
} from './plugin-api'

describe('fetchInstalledPlugins', () => {
  it('calls GET /api/v1/admin/plugins/available and returns the parsed body', async () => {
    const plugins: InstalledPlugin[] = [
      {
        name: 'rbac',
        version: '0.1.0',
        description: 'Fine-grained role-based access control.',
        tables: [{ name: 'rbac_roles', columns: [], indexes: [] }],
        routes: [
          {
            method: 'GET',
            path: '/roles',
            table: 'rbac_roles',
            operation: 'list',
            description: '',
          },
        ],
        has_admin_ingress: false,
        admin_required_group: null,
        admin_nav_label: null,
      },
    ]
    const get = vi.fn().mockResolvedValue(plugins)

    const result = await fetchInstalledPlugins({ get })

    expect(get).toHaveBeenCalledWith('/api/v1/admin/plugins/available')
    expect(result).toEqual(plugins)
  })

  it('propagates errors from the underlying client', async () => {
    const get = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(fetchInstalledPlugins({ get })).rejects.toThrow('boom')
  })
})

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  })
}

// Mirrors the real keiranholloway/biffo-plugins-registry registry-schema.json
// entry shape (fetched 2026-07-02), also asserted independently by
// cli/src/adapters/registry/index.ts.
const VALID_REGISTRY = {
  schema_version: '1.0',
  last_updated: '2026-06-30T00:00:00Z',
  plugins: [
    {
      name: 'rbac',
      version: '1.2.3',
      minor_version: '1.2',
      repo: 'https://github.com/keiranholloway/biffo-plugin-rbac',
      description: 'Fine-grained role-based access control.',
      author: 'Biffo Team',
      tags: ['auth', 'security'],
      status: 'active',
    },
    {
      name: 'legacy-widget',
      version: '2.0.0',
      minor_version: '2.0',
      repo: 'https://github.com/keiranholloway/biffo-plugin-legacy-widget',
      status: 'disabled',
    },
  ],
}

describe('plugin-api', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('fetchPluginRegistry', () => {
    it('fetches the real biffo-plugins-registry raw URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      global.fetch = fetchMock
      await fetchPluginRegistry()
      expect(fetchMock).toHaveBeenCalledWith(REGISTRY_URL)
      expect(REGISTRY_URL).toBe(
        'https://raw.githubusercontent.com/keiranholloway/biffo-plugins-registry/main/plugins.json',
      )
    })

    it('returns the parsed registry on success', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const registry = await fetchPluginRegistry()
      expect(registry).toEqual(VALID_REGISTRY)
    })

    it('throws a PluginRegistryError on a non-OK response', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, { status: 404, statusText: 'Not Found' }))
      await expect(fetchPluginRegistry()).rejects.toThrow(PluginRegistryError)
    })

    it('throws a PluginRegistryError when the network request fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network down'))
      await expect(fetchPluginRegistry()).rejects.toThrow(PluginRegistryError)
    })

    it('throws a PluginRegistryError on malformed JSON', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await expect(fetchPluginRegistry()).rejects.toThrow(PluginRegistryError)
    })

    it('throws a PluginRegistryError when the response has an unexpected shape', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ oops: true }))
      await expect(fetchPluginRegistry()).rejects.toThrow(PluginRegistryError)
    })

    it('handles the currently-empty registry gracefully', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          schema_version: '1.0',
          last_updated: '2026-06-30T00:00:00Z',
          plugins: [],
        }),
      )
      const registry = await fetchPluginRegistry()
      expect(registry.plugins).toEqual([])
    })
  })

  describe('fetchActivePlugins', () => {
    it('filters out disabled plugins', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(VALID_REGISTRY))
      const plugins = await fetchActivePlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0]?.name).toBe('rbac')
    })
  })
})
