import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../test-utils/tmp.js'
import type { CommandRunner } from './command-runner.js'
import {
  composeStack,
  realComposeDeps,
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
  removed: string[]
  psqlCalls: Array<{ args: string[]; env?: Record<string, string> }>
  pluginRoot: string
  coreRoot: string
  workDir: string
}

function harness(
  over: {
    bootstrapStatus?: number
    hostDiesAtStart?: boolean
    coreDiesAtStart?: boolean
    pgStatus?: number
    /** uv-run preflight exit: 0 importable, 3 = plugin_host missing, anything else = uv failed. */
    preflightStatus?: number
    dsn?: string
  } = {},
): Harness {
  const pluginRoot = tmp('plugin-')
  writeFileSync(join(pluginRoot, 'biffo.plugin.json'), JSON.stringify(MANIFEST))
  const coreRoot = tmp('core-')
  const workDir = tmp('work-')
  const order: string[] = []
  const removed: string[] = []
  const psqlCalls: Harness['psqlCalls'] = []
  const runnerCalls: Harness['runnerCalls'] = []
  const spawned: Harness['spawned'] = []
  const runner: CommandRunner = {
    run: (cmd, args, opts) => {
      runnerCalls.push({ cmd, args, ...(opts.env ? { env: opts.env } : {}) })
      if (cmd.endsWith('pg-test-db.sh')) {
        order.push('postgres')
        return {
          status: over.pgStatus ?? 0,
          stdout: `${over.dsn ?? 'postgresql+asyncpg://u:p@localhost:5/db'}\n`,
        }
      }
      if (cmd === 'psql') {
        order.push('psql')
        psqlCalls.push({ args, ...(opts.env ? { env: opts.env } : {}) })
        return { status: 0, stdout: '' }
      }
      if (args.includes('-c')) {
        order.push('preflight')
        return { status: over.preflightStatus ?? 0, stdout: '' }
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
        dead:
          (name === 'host' && !!over.hostDiesAtStart) ||
          (name === 'core' && !!over.coreDiesAtStart),
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
    removeDir: (dir) => {
      order.push('rm-workdir')
      removed.push(dir)
    },
    sleep: async () => undefined,
    log: () => undefined,
  }
  return { deps, runnerCalls, spawned, order, removed, psqlCalls, pluginRoot, coreRoot, workDir }
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
    expect(h.order).toEqual(['preflight', 'postgres', 'bootstrap', 'spawn:core', 'spawn:host'])
    expect(stack.dsn).toBe('postgresql+asyncpg://u:p@localhost:5/db')
    await stack.close()
    expect(h.order.slice(-3)).toEqual(['kill:host', 'kill:core', 'rm-workdir'])
  })

  it('runs every child off real AWS: no ambient credentials, DSN as asyncpg, sink as the endpoint', async () => {
    const h = harness()
    const stack = await composeStack(opts(h), h.deps)
    const boot = h.runnerCalls.find((c) => c.args.some((a) => a.endsWith('bootstrap.py')))!
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

const CLONE_DSN = 'postgresql+asyncpg://u:p@localhost:5/biffo_test_abcd1234_r0f1e2d3c'

describe('composeStack — Core is healthy before the host starts (#1525 finding 1)', () => {
  it('does not spawn the host until Core has answered its health URL', async () => {
    const h = harness()
    const coreAnswered = { value: false }
    let coreProbes = 0
    h.deps.fetchFn = async (input) => {
      if (String(input).includes(':40000/')) {
        coreProbes += 1
        // Core is slow: refuses twice before it comes up.
        if (coreProbes <= 2) throw new Error('ECONNREFUSED')
        coreAnswered.value = true
      }
      return new Response('', { status: 200 })
    }
    // A plugin whose startup calls Core (ideation: admin_app._seed_agent_config) is,
    // to the composition, a host that needs Core answering at the moment it spawns.
    let coreUpWhenHostSpawned: boolean | null = null
    const spawn = h.deps.spawnProcess
    h.deps.spawnProcess = (name, cmd, args, o) => {
      if (name === 'host') coreUpWhenHostSpawned = coreAnswered.value
      return spawn(name, cmd, args, o)
    }
    const stack = await composeStack(opts(h, { readyTimeoutMs: 10_000 }), h.deps)
    expect(coreUpWhenHostSpawned).toBe(true)
    await stack.close()
  })

  it('a Core that dies before it is ready fails the compose and the host is never started', async () => {
    const h = harness({ coreDiesAtStart: true })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(
      /Core exited before it became ready/,
    )
    expect(h.spawned.map((s) => s.name)).toEqual(['core'])
    expect(h.spawned[0]!.killed).toBe(true)
  })

  it('a Core that never answers times out naming Core, and no host is started', async () => {
    const h = harness()
    h.deps.fetchFn = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(composeStack(opts(h, { readyTimeoutMs: -1 }), h.deps)).rejects.toThrow(
      /Core did not answer/,
    )
    expect(h.spawned.map((s) => s.name)).toEqual(['core'])
  })
})

describe('composeStack — the plugin environment must carry the host (#1525 finding 2)', () => {
  it('fails fast, naming biffo-plugin-host and the fix, before Postgres or any process', async () => {
    const h = harness({ preflightStatus: 3 })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(/biffo-plugin-host/)
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(/uv add --dev/)
    expect(h.order.filter((o) => o !== 'preflight')).toEqual([])
    expect(h.spawned).toEqual([])
  })

  it('preflights with the plugin repo as the uv project, the same one the host runs from', async () => {
    const h = harness()
    await (await composeStack(opts(h), h.deps)).close()
    const call = h.runnerCalls.find((c) => c.args.includes('-c'))!
    expect(call.cmd).toBe('uv')
    expect(call.args).toEqual(expect.arrayContaining(['--directory', h.pluginRoot, 'python']))
    expect(call.args.join(' ')).toContain('plugin_host')
  })

  it('a uv failure is reported as uv failing, not as a missing dependency', async () => {
    const h = harness({ preflightStatus: 2 })
    const err = await composeStack(opts(h), h.deps).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/could not run the plugin's Python environment/)
    expect((err as Error).message).toMatch(/exit(ed)? 2/)
    expect((err as Error).message).not.toMatch(/uv add --dev/)
  })
})

describe('composeStack — teardown leaves nothing behind (#1525 finding 3)', () => {
  it('close() removes the run directory and the cloned Postgres database, after the servers stop', async () => {
    const h = harness({ dsn: CLONE_DSN })
    const stack = await composeStack(opts(h), h.deps)
    expect(h.psqlCalls).toEqual([])
    await stack.close()
    expect(h.order.slice(-4)).toEqual(['kill:host', 'kill:core', 'rm-workdir', 'psql'])
    expect(h.removed).toEqual([h.workDir])
    const drop = h.psqlCalls[0]!
    expect(drop.args.join(' ')).toContain('"biffo_test_abcd1234_r0f1e2d3c" WITH (FORCE)')
    expect(drop.args.join(' ')).toMatch(/DROP DATABASE IF EXISTS/)
    expect(drop.args).toEqual(expect.arrayContaining(['-h', 'localhost', '-p', '5', '-U', 'u']))
    // Never the database the run used: an admin connection to `postgres`.
    expect(drop.args).toEqual(expect.arrayContaining(['-d', 'postgres']))
    expect(drop.env!.PGPASSWORD).toBe('p')
  })

  it('never removes a shared (non-clone) database', async () => {
    const h = harness({ dsn: 'postgresql+asyncpg://u:p@localhost:5/biffo_test_abcd1234' })
    await (await composeStack(opts(h), h.deps)).close()
    expect(h.psqlCalls).toEqual([])
    const named = harness({ dsn: 'postgresql+asyncpg://u:p@localhost:5/mydata_r0f1e2d3c_x' })
    await (await composeStack(opts(named), named.deps)).close()
    expect(named.psqlCalls).toEqual([])
  })

  it('close() is idempotent', async () => {
    const h = harness({ dsn: CLONE_DSN })
    const stack = await composeStack(opts(h), h.deps)
    await Promise.all([stack.close(), stack.close()])
    await stack.close()
    expect(h.psqlCalls).toHaveLength(1)
    expect(h.removed).toHaveLength(1)
  })

  it('a compose that fails part-way also removes the clone and the run directory', async () => {
    const h = harness({ dsn: CLONE_DSN, hostDiesAtStart: true })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(/plugin host exited/)
    expect(h.removed).toEqual([h.workDir])
    expect(h.psqlCalls).toHaveLength(1)
  })

  it('a failed migration (Postgres raised, no servers) still removes the clone', async () => {
    const h = harness({ dsn: CLONE_DSN, bootstrapStatus: 3 })
    await expect(composeStack(opts(h), h.deps)).rejects.toThrow(/migrations failed/)
    expect(h.psqlCalls).toHaveLength(1)
  })

  it('a failing clone removal is reported, not thrown, and does not stop the rest of teardown', async () => {
    const h = harness({ dsn: CLONE_DSN })
    const logged: string[] = []
    h.deps.log = (l) => logged.push(l)
    const run = h.deps.runner.run.bind(h.deps.runner)
    h.deps.runner.run = (cmd, args, o) =>
      cmd === 'psql' ? { status: 2, stdout: '' } : run(cmd, args, o)
    const stack = await composeStack(opts(h), h.deps)
    await stack.close()
    expect(logged.join('\n')).toMatch(/could not remove .*biffo_test_abcd1234_r0f1e2d3c/)
    expect(h.removed).toEqual([h.workDir])
  })

  it('an interrupt (SIGTERM/SIGINT) mid-startup tears everything down and fails the compose', async () => {
    const h = harness({ dsn: CLONE_DSN })
    const ac = new AbortController()
    h.deps.fetchFn = async () => {
      ac.abort() // the signal lands while waiting for Core
      throw new Error('ECONNREFUSED')
    }
    await expect(
      composeStack(opts(h, { signal: ac.signal, readyTimeoutMs: 10_000 }), h.deps),
    ).rejects.toThrow(/interrupted/)
    expect(h.spawned.map((s) => [s.name, s.killed])).toEqual([['core', true]])
    expect(h.removed).toEqual([h.workDir])
    expect(h.psqlCalls).toHaveLength(1)
  })

  it('an interrupt that lands during a blocking step stops the compose before the next one', async () => {
    const h = harness({ dsn: CLONE_DSN })
    const ac = new AbortController()
    const run = h.deps.runner.run.bind(h.deps.runner)
    h.deps.runner.run = (cmd, args, o) => {
      const r = run(cmd, args, o)
      if (args.some((a) => a.endsWith('bootstrap.py'))) ac.abort()
      return r
    }
    await expect(composeStack(opts(h, { signal: ac.signal }), h.deps)).rejects.toThrow(
      /interrupted/,
    )
    expect(h.spawned).toEqual([])
    expect(h.psqlCalls).toHaveLength(1)
  })

  it('an interrupt after the stack is up tears it down without waiting for the caller', async () => {
    const h = harness({ dsn: CLONE_DSN })
    const ac = new AbortController()
    await composeStack(opts(h, { signal: ac.signal }), h.deps)
    ac.abort()
    await vi.waitFor(() => expect(h.removed).toEqual([h.workDir]))
    expect(h.spawned.every((s) => s.killed)).toBe(true)
    expect(h.psqlCalls).toHaveLength(1)
  })
})

describe('realComposeDeps.removeDir', () => {
  it('removes the run directory and the symlink inside it, never the plugin repo it points at', () => {
    const plugin = tmp('plugin-')
    writeFileSync(join(plugin, 'biffo.plugin.json'), '{}')
    const run = tmp('run-')
    mkdirSync(join(run, 'services'))
    symlinkSync(plugin, join(run, 'services', 'demo'), 'dir')
    const deps = realComposeDeps(
      { run: () => ({ status: 0, stdout: '' }) },
      () => null,
      () => undefined,
    )
    deps.removeDir(run)
    expect(existsSync(run)).toBe(false)
    expect(existsSync(join(plugin, 'biffo.plugin.json'))).toBe(true)
  })
})

describe('toAsyncpgDsn', () => {
  it.each([
    ['postgresql://a@h/d', 'postgresql+asyncpg://a@h/d'],
    ['postgres://a@h/d', 'postgresql+asyncpg://a@h/d'],
    ['postgresql+asyncpg://a@h/d', 'postgresql+asyncpg://a@h/d'],
  ])('%s', (input, expected) => expect(toAsyncpgDsn(input)).toBe(expected))
})
