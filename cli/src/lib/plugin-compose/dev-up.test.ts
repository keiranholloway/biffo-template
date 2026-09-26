import { describe, expect, it, vi } from 'vitest'
import { validateManifest } from '../plugin-manifest.js'
import { generateDevKeypair, mintDevToken } from './dev-auth.js'
import type { ComposeDeps, ComposedStack } from './compose-stack.js'

const composeStackMock = vi.fn()
vi.mock('./compose-stack.js', () => ({ composeStack: (...a: unknown[]) => composeStackMock(...a) }))

const { runDevUp, pickConfigFile, formatProbeTable } = await import('./dev-up.js')

const manifest = validateManifest({
  name: 'demo',
  version: '0.1.0',
  description: 'd',
  author: 'a',
  tables: [{ name: 'w', columns: [{ name: 'n', type: 'String(10)', nullable: false }] }],
  api_routes: [{ method: 'GET', path: '/w', table: 'w', operation: 'list' }],
})

function stackWith(fetchFn: typeof fetch): {
  stack: ComposedStack
  closed: () => boolean
  deps: ComposeDeps
} {
  const kp = generateDevKeypair()
  let closed = false
  const stack = {
    coreUrl: 'http://core',
    hostUrl: 'http://host',
    dsn: 'postgresql://x',
    manifest,
    keypair: kp,
    groups: ['admin'],
    adminToken: mintDevToken(kp.privateKeyPem, { groups: ['admin'] }),
    sink: { unexpected: [] },
    workDir: '/w',
    configSummary: [],
    close: async () => {
      closed = true
    },
  } as unknown as ComposedStack
  composeStackMock.mockResolvedValue(stack)
  return { stack, closed: () => closed, deps: { fetchFn } as unknown as ComposeDeps }
}

/** Answers like a real router: only /w exists, and only for the minted token. */
const realRouter =
  (catchAll = false): typeof fetch =>
  async (input, init) => {
    const url = String(input)
    if (url.endsWith('/health')) return new Response('', { status: 200 })
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? ''
    const token = stackToken()
    if (auth !== `Bearer ${token}`) return new Response('', { status: 401 })
    return new Response('', { status: catchAll || url.endsWith('/w') ? 200 : 404 })
  }
let stackToken = () => ''

const base = { pluginRoot: '/p', coreRoot: '/c', configFile: null, reload: true }
const hooks = () => {
  const lines: string[] = []
  return {
    lines,
    h: { write: (l: string) => lines.push(l), untilInterrupted: async () => undefined },
  }
}

describe('runDevUp', () => {
  it('--check exits 0 when the real route answers and the nonexistent one 404s, then tears down', async () => {
    const ctx = stackWith(realRouter())
    stackToken = () => ctx.stack.adminToken
    const { lines, h } = hooks()
    expect(await runDevUp({ ...base, check: true }, ctx.deps, h)).toBe(0)
    expect(lines[0]).toBe('dev up: 8/8 probes matched')
    expect(ctx.closed()).toBe(true)
  })

  it('--check exits 1 when a nonexistent route answers 200 (a catch-all fails the control)', async () => {
    const ctx = stackWith(realRouter(true))
    stackToken = () => ctx.stack.adminToken
    const { lines, h } = hooks()
    expect(await runDevUp({ ...base, check: true }, ctx.deps, h)).toBe(1)
    expect(lines.join('\n')).toContain('MISMATCH')
    expect(ctx.closed()).toBe(true)
  })

  it('a compose failure is exit 1, never a crash, and nothing to close', async () => {
    composeStackMock.mockRejectedValue(new Error('no docker'))
    const { h } = hooks()
    expect(await runDevUp({ ...base, check: true }, {} as ComposeDeps, h)).toBe(1)
  })

  it('interactive mode prints the endpoints + token, stays up until interrupted, then tears down', async () => {
    const ctx = stackWith(realRouter())
    stackToken = () => ctx.stack.adminToken
    const { lines, h } = hooks()
    let interrupted = false
    const code = await runDevUp({ ...base, check: false }, ctx.deps, {
      write: h.write,
      untilInterrupted: async () => {
        interrupted = true
        expect(ctx.closed()).toBe(false)
      },
    })
    expect(code).toBe(0)
    expect(interrupted).toBe(true)
    expect(ctx.closed()).toBe(true)
    const out = lines.join('\n')
    expect(out).toContain('http://host/demo/<route>')
    expect(out).toContain(`export TOKEN=${ctx.stack.adminToken}`)
    expect(out).toContain('host restarts on plugin source changes')
  })

  it('hands the interrupt signal to the composition, so a SIGTERM mid-startup can tear it down', async () => {
    const ctx = stackWith(realRouter())
    stackToken = () => ctx.stack.adminToken
    const ac = new AbortController()
    await runDevUp({ ...base, check: true, signal: ac.signal }, ctx.deps, hooks().h)
    expect(composeStackMock.mock.calls.at(-1)![0].signal).toBe(ac.signal)
  })

  it('a compose interrupted by a signal exits 130 and says so, rather than reporting a failure', async () => {
    const ac = new AbortController()
    ac.abort()
    composeStackMock.mockRejectedValue(new Error('interrupted'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { lines, h } = hooks()
    expect(await runDevUp({ ...base, check: true, signal: ac.signal }, {} as ComposeDeps, h)).toBe(
      130,
    )
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/failed/)
    expect(lines).toEqual([])
    errors.mockRestore()
  })

  it('--check interrupted while probing exits 130 and does not claim the stack healthy', async () => {
    const ac = new AbortController()
    const ctx = stackWith(async (input, init) => {
      ac.abort()
      return realRouter()(input, init)
    })
    stackToken = () => ctx.stack.adminToken
    const { lines, h } = hooks()
    expect(await runDevUp({ ...base, check: true, signal: ac.signal }, ctx.deps, h)).toBe(130)
    expect(ctx.closed()).toBe(true)
    expect(lines.join('\n')).not.toContain('composition healthy')
  })

  it('surfaces AWS calls the sink refused', async () => {
    const ctx = stackWith(realRouter())
    stackToken = () => ctx.stack.adminToken
    ;(ctx.stack.sink as { unexpected: string[] }).unexpected.push('AWSLambda.Invoke')
    const { lines, h } = hooks()
    await runDevUp({ ...base, check: true }, ctx.deps, h)
    expect(lines.join('\n')).toContain('AWSLambda.Invoke')
  })
})

describe('secret-file hygiene', () => {
  const runnerWith = (status: number | null) =>
    ({ run: () => ({ status, stdout: '' }) }) as unknown as ComposeDeps['runner']

  it('warns when the config file is not git-ignored, and still proceeds', async () => {
    const ctx = stackWith(realRouter())
    stackToken = () => ctx.stack.adminToken
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { h } = hooks()
    const code = await runDevUp(
      { ...base, configFile: '/p/biffo.dev.json', check: true },
      { ...ctx.deps, runner: runnerWith(1) },
      h,
    )
    expect(code).toBe(0)
    expect(warn.mock.calls.flat().join(' ')).toContain('NOT git-ignored')
    warn.mockRestore()
  })

  it('stays quiet when the file is ignored, or when the directory is not a git repo', async () => {
    for (const status of [0, 128]) {
      const ctx = stackWith(realRouter())
      stackToken = () => ctx.stack.adminToken
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await runDevUp(
        { ...base, configFile: '/p/biffo.dev.json', check: true },
        { ...ctx.deps, runner: runnerWith(status) },
        hooks().h,
      )
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    }
  })
})

describe('helpers', () => {
  it('pickConfigFile prefers an explicit path, else biffo.dev.json only if it exists', () => {
    expect(pickConfigFile('/nonexistent', '/x.json')).toBe('/x.json')
    expect(pickConfigFile('/nonexistent')).toBeNull()
  })
  it('formatProbeTable marks mismatches', () => {
    expect(formatProbeTable([{ label: 'a', expect: 200, got: 404, ok: false }])[0]).toContain(
      'MISMATCH',
    )
  })
})
