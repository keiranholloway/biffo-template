import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../test-utils/tmp.js'
import type { CommandRunner } from './command-runner.js'
import {
  composeStack,
  toAsyncpgDsn,
  type ComposeDeps,
  type ManagedProcess,
} from './compose-stack.js'

const dirs: string[] = []
const tmp = (p: string) => {
  const d = makeTmpDir(p)
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach(removeTmpDir))

const MANIFEST = {
  name: 'demo',
  version: '0.1.0',
  description: 'd',
  author: 'a',
  config: [{ name: 'greeting', kind: 'setting', required: true, description: 'g' }],
  user_ingress: { required_group: 'members', app: 'demo.app:app' },
}

interface Harness {
  deps: ComposeDeps
  runnerCalls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }>
  spawned: Array<{
    name: string
    args: string[]
    env: Record<string, string>
    killed: boolean
    dead: boolean
  }>
  order: string[]
  pluginRoot: string
  coreRoot: string
  workDir: string
}

function harness(
  over: { bootstrapStatus?: number; hostDiesAtStart?: boolean; pgStatus?: number } = {},
): Harness {
  const pluginRoot = tmp('plugin-')
  writeFileSync(join(pluginRoot, 'biffo.plugin.json'), JSON.stringify(MANIFEST))
  const coreRoot = tmp('core-')
  const workDir = tmp('work-')
  const order: string[] = []
  const runnerCalls: Harness['runnerCalls'] = []
  const spawned: Harness['spawned'] = []
  const runner: CommandRunner = {
    run: (cmd, args, opts) => {
      runnerCalls.push({ cmd, args, ...(opts.env ? { env: opts.env } : {}) })
      if (cmd.endsWith('pg-test-db.sh')) {
        order.push('postgres')
        return { status: over.pgStatus ?? 0, stdout: 'postgresql+asyncpg://u:p@localhost:5/db\n' }
      }
      order.push('bootstrap')
      return { status: over.bootstrapStatus ?? 0, stdout: '' }
    },
  }
  let port = 40000
  const deps: ComposeDeps = {
    runner,
    findScript: (p) => `/pkg/${p}`,
    spawnProcess: (name, _cmd, args, opts) => {
      order.push(`spawn:${name}`)
      const rec = {
        name,
        args,
        env: opts.env,
        killed: false,
        dead: name === 'host' && !!over.hostDiesAtStart,
      }
      spawned.push(rec)
      const proc: ManagedProcess = {
        name,
        exited: Promise.resolve(0),
        hasExited: () => rec.dead,
        kill: async () => {
          rec.killed = true
          order.push(`kill:${name}`)
        },
      }
      return proc
    },
    fetchFn: async () => new Response('', { status: 200 }),
    parentEnv: { PATH: '/bin', AWS_PROFILE: 'operator', BIFFO_DATABASE_URL: 'postgresql://real' },
    freePort: async () => port++,
    makeWorkDir: () => workDir,
    sleep: async () => undefined,
    log: () => undefined,
  }
  return { deps, runnerCalls, spawned, order, pluginRoot, coreRoot, workDir }
}

const opts = (h: Harness, extra: Partial<Parameters<typeof composeStack>[0]> = {}) => {
  const cfg = join(h.pluginRoot, 'biffo.dev.json')
  writeFileSync(cfg, JSON.stringify({ greeting: 'hi' }))
  return {
    pluginRoot: h.pluginRoot,
    coreRoot: h.coreRoot,
    configFile: cfg,
    reload: true,
    readyTimeoutMs: 100,
    ...extra,
  }
}

describe('composeStack', () => {
  it('raises Postgres, migrates, then starts Core and the host — in that order', async () => {
    const h = harness()
    const stack = await composeStack(opts(h), h.deps)
    expect(h.order).toEqual(['postgres', 'bootstrap', 'spawn:core', 'spawn:host'])
    expect(stack.dsn).toBe('postgresql+asyncpg://u:p@localhost:5/db')
    await stack.close()
    expect(h.order.slice(-2)).toEqual(['kill:host', 'kill:core'])
  })

  it('runs every child off real AWS: no ambient credentials, DSN as asyncpg, sink as the endpoint', async () => {
    const h = harness()
    const stack = await composeStack(opts(h), h.deps)
    const boot = h.runnerCalls.find((c) => c.cmd === 'uv')!
    for (const env of [boot.env!, h.spawned[0]!.env, h.spawned[1]!.env]) {
      expect(env.AWS_PROFILE).toBeUndefined()
      expect(env.AWS_ENDPOINT_URL).toBe(stack.sink.url)
      expect(
        env.BIFFO_DATABASE_URL === undefined ||
          env.BIFFO_DATABASE_URL.startsWith('postgresql+asyncpg://u:p@localhost:5/'),
      ).toBe(true)
    }
    expect(h.spawned[0]!.env.BIFFO_DATABASE_URL).toBe('postgresql+asyncpg://u:p@localhost:5/db')
    expect(h.spawned[0]!.env.BIFFO_COGNITO_JWKS_JSON).toBe(stack.keypair.jwksJson)
    await stack.close()
  })

  it('gives the host the plugin config env (via the install resolution path) and Core does not get it', async () => {
    const h = harness()
    const stack = await composeStack(opts(h), h.deps)
    const key = 'BIFFO_PLUGIN_DEMO_GREETING'
    expect(h.spawned.find((s) => s.name === 'host')!.env[key]).toBe('hi')
    expect(h.spawned.find((s) => s.name === 'core')!.env[key]).toBeUndefined()
    expect(stack.configSummary).toEqual(['setting greeting -> BIFFO_PLUGIN_DEMO_GREETING'])
    await stack.close()
  })

  it('mints a token carrying the manifest ingress group as well as admin/founder', async () => {
    const h = harness()
    const stack = await composeStack(opts(h), h.deps)
    expect(stack.groups).toEqual(['admin', 'founder', 'members'])
    await stack.close()
  })

  it('symlinks the plugin repo under a services root named for the manifest', async () => {
    const h = harness()
    const stack = await composeStack(opts(h), h.deps)
    const link = join(h.workDir, 'services', 'demo')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(h.pluginRoot)
    expect(existsSync(join(h.workDir, 'apps', 'core_app.py'))).toBe(true)
    await stack.close()
  })

  it('hot reload is on only when asked', async () => {
    const on = harness()
    await (await composeStack(opts(on), on.deps)).close()
    expect(on.spawned[1]!.args).toContain('--reload')
    const off = harness()
    await (await composeStack(opts(off, { reload: false }), off.deps)).close()
    expect(off.spawned[1]!.args).not.toContain('--reload')
  })

  it('a missing required config value fails BEFORE anything is started', async () => {
    const h = harness()
    await expect(
      composeStack(
        {
          pluginRoot: h.pluginRoot,
          coreRoot: h.coreRoot,
          configFile: null,
          reload: true,
          readyTimeoutMs: 100,
        },
        h.deps,
      ),
    ).rejects.toThrow(/required config value/)
    expect(h.order).toEqual([])
  })

  it('a failed migration starts no server and leaves nothing running', async () => {
    const h = harness({ bootstrapStatus: 3 })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(/migrations failed \(exit 3\)/)
    expect(h.spawned).toEqual([])
  })

  it('a failed Postgres raise is an error, not an empty DSN', async () => {
    const h = harness({ pgStatus: 2 })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(/could not provision Postgres/)
  })

  it('a host that dies during startup fails the compose and tears down Core too', async () => {
    const h = harness({ hostDiesAtStart: true })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(
      /plugin host exited before it became ready/,
    )
    expect(h.spawned.every((s) => s.killed)).toBe(true)
  })

  it('a server that never answers times out with the URL named', async () => {
    const h = harness()
    h.deps.fetchFn = async () => {
      throw new Error('ECONNREFUSED')
    }
    let now = 0
    h.deps.sleep = async () => {
      now += 1
    }
    await expect(composeStack(opts(h, { readyTimeoutMs: -1 }), h.deps)).rejects.toThrow(
      /did not answer/,
    )
    void now
    expect(h.spawned.every((s) => s.killed)).toBe(true)
  })

  it('rejects a directory that is not a plugin repo', async () => {
    const h = harness()
    mkdirSync(join(h.pluginRoot, 'sub'))
    await expect(
      composeStack(
        {
          pluginRoot: join(h.pluginRoot, 'sub'),
          coreRoot: h.coreRoot,
          configFile: null,
          reload: false,
          readyTimeoutMs: 1,
        },
        h.deps,
      ),
    ).rejects.toThrow(/no biffo.plugin.json/)
  })
})

describe('toAsyncpgDsn', () => {
  it.each([
    ['postgresql://a@h/d', 'postgresql+asyncpg://a@h/d'],
    ['postgres://a@h/d', 'postgresql+asyncpg://a@h/d'],
    ['postgresql+asyncpg://a@h/d', 'postgresql+asyncpg://a@h/d'],
  ])('%s', (input, expected) => expect(toAsyncpgDsn(input)).toBe(expected))
})
