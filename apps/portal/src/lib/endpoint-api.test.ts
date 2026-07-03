import { describe, expect, it, vi } from 'vitest'
import {
  changeEndpointPermission,
  type EndpointPermissionRequest,
  fetchEndpoints,
} from './endpoint-api'

describe('fetchEndpoints', () => {
  it('calls GET /api/v1/admin/endpoints and returns the parsed body', async () => {
    const get = vi.fn().mockResolvedValue([])
    const result = await fetchEndpoints({ get })
    expect(get).toHaveBeenCalledWith('/api/v1/admin/endpoints')
    expect(result).toEqual([])
  })
})

describe('changeEndpointPermission', () => {
  const req: EndpointPermissionRequest = {
    plugin: 'rbac',
    table: 'rbac_roles',
    operation: 'create',
    allowed: true,
    required_role: ['admin'],
  }

  it('POSTs the change to /api/v1/admin/endpoints/permission and returns the PR result', async () => {
    const post = vi.fn().mockResolvedValue({ pr_url: 'https://gh/o/r/pull/1', branch: 'b' })

    const result = await changeEndpointPermission({ post }, req)

    expect(post).toHaveBeenCalledWith('/api/v1/admin/endpoints/permission', req)
    expect(result).toEqual({ pr_url: 'https://gh/o/r/pull/1', branch: 'b' })
  })

  it('propagates errors from the underlying client', async () => {
    const post = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(changeEndpointPermission({ post }, req)).rejects.toThrow('boom')
  })
})
