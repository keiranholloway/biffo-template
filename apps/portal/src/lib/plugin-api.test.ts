import { describe, expect, it, vi } from 'vitest'
import { fetchInstalledPlugins, type InstalledPlugin } from './plugin-api'

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
