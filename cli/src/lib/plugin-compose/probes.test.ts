import { describe, expect, it } from 'vitest'
import { validateManifest } from '../plugin-manifest.js'
import { buildProbes, probesGreen, probeableRoutes, runProbes } from './probes.js'

const table = { name: 'widgets', columns: [{ name: 'n', type: 'String(10)', nullable: false }] }
const manifest = validateManifest({
  name: 'demo',
  version: '0.1.0',
  description: 'd',
  author: 'a',
  tables: [table],
  api_routes: [
    { method: 'GET', path: '/widgets/{id}', table: 'widgets', operation: 'read' },
    { method: 'POST', path: '/widgets', table: 'widgets', operation: 'create' },
    { method: 'GET', path: '/widgets', table: 'widgets', operation: 'list' },
  ],
})
const ctx = {
  coreUrl: 'http://core',
  hostUrl: 'http://host',
  manifest,
  adminToken: 'ADMIN',
  privateKeyPem: (await import('./dev-auth.js')).generateDevKeypair().privateKeyPem,
  wrongKeyToken: 'WRONG',
}

/** A fake stack whose router knows exactly the declared routes — a real router, not a catch-all. */
const routerFetch =
  (opts: { catchAll?: boolean } = {}): typeof fetch =>
  async (input, init) => {
    const url = String(input)
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    if (url.endsWith('/health')) return new Response('ok', { status: 200 })
    if (auth !== 'Bearer ADMIN') return new Response('no', { status: 401 })
    const known = url.endsWith('/widgets')
    return new Response('x', { status: known || opts.catchAll ? 200 : 404 })
  }

describe('route probes', () => {
  it('only GET routes without path parameters are probed blind', () => {
    expect(probeableRoutes(manifest)).toEqual(['/widgets'])
  })

  it('pairs a REAL 200 with a BAD 404 using the SAME token and prefix', () => {
    const { probes } = buildProbes(ctx)
    const real = probes.find(
      (p) => p.label.includes('REAL') && p.label.includes('via core, minted'),
    )!
    const bad = probes.find((p) => p.label.startsWith('BAD') && p.label.includes('via core'))!
    expect(real.token).toBe(bad.token)
    expect(new URL(bad.url).pathname.startsWith('/api/v1/plugins/demo/')).toBe(true)
    expect(real.expect).toBe(200)
    expect(bad.expect).toBe(404)
  })

  it('a real route answers 200 with the minted token while a nonexistent one 404s (known-bad control)', async () => {
    const { probes } = buildProbes(ctx)
    const results = await runProbes(probes, routerFetch())
    expect(results.every((r) => r.ok)).toBe(true)
    expect(probesGreen(results, manifest).ok).toBe(true)
    // The denominator is real: 1 health + 5 REAL + 2 BAD.
    expect(results).toHaveLength(8)
  })

  it('a catch-all that answers 200 for a nonexistent route is caught by the control', async () => {
    const results = await runProbes(buildProbes(ctx).probes, routerFetch({ catchAll: true }))
    const failed = results.filter((r) => !r.ok)
    expect(failed.map((r) => r.label).every((l) => l.startsWith('BAD'))).toBe(true)
    expect(probesGreen(results, manifest).ok).toBe(false)
  })

  it('a connection error is a failed probe, never a pass', async () => {
    const results = await runProbes(buildProbes(ctx).probes, async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(results.every((r) => r.got === 'error' && !r.ok)).toBe(true)
  })

  it('a manifest with routes but none probeable is NOT green on the controls alone', async () => {
    const postOnly = validateManifest({
      ...manifest,
      api_routes: [{ method: 'POST', path: '/widgets', table: 'widgets', operation: 'create' }],
    })
    const { probes, notes } = buildProbes({ ...ctx, manifest: postOnly })
    expect(notes[0]).toMatch(/NOT run/)
    const results = await runProbes(probes, routerFetch())
    expect(results.every((r) => r.ok)).toBe(true)
    const verdict = probesGreen(results, postOnly)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/no real-route probe ran/)
  })

  it('a manifest with no routes at all can be green on health + controls', async () => {
    const none = validateManifest({ name: 'p', version: '0.1.0', description: 'd', author: 'a' })
    const results = await runProbes(buildProbes({ ...ctx, manifest: none }).probes, routerFetch())
    expect(probesGreen(results, none).ok).toBe(true)
  })

  it('no probes is not a pass', () => {
    expect(probesGreen([], manifest)).toEqual({ ok: false, reason: 'no probes ran' })
  })
})
