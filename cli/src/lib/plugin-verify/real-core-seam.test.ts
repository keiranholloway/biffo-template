import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../test-utils/tmp.js'
import type { CommandResult, CommandRunner } from '../plugin-compose/command-runner.js'
import type { ComposeDeps, ManagedProcess } from '../plugin-compose/compose-stack.js'
import {
  type PluginVerifyDeps,
  type PluginVerifyOptions,
  runPluginVerify,
} from './run-plugin-verify.js'

vi.mock('../logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
}))

/**
 * The real_core seam (biffo-template#2105, #1523 item 3), fail-first.
 *
 * `composeStack` is deliberately NOT mocked here: the whole point is that the verify
 * lane runs the very composition `biffo dev up` runs, so a change to `compose-stack.ts`
 * that breaks Core start-up must turn `runPluginVerify` red. Only the edges are faked —
 * the process spawner, the network and the command runner — and the fake Core behaves
 * like the real one in the ways that matter to start-up: it only comes up when it is
 * launched as `core_app:core_app` with a database URL in its environment.
 */
const dirs: string[] = []
const tmp = (p: string) => {
  const d = makeTmpDir(p)
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach(removeTmpDir))
beforeEach(() => vi.clearAllMocks())

interface Spawned {
  name: string
  args: string[]
  env: Record<string, string>
  dead: boolean
  killed: boolean
}

function setup(over: { conformanceStatus?: number; bootstrapStatus?: number } = {}) {
  const pluginRoot = tmp('plugin-')
  writeFileSync(
    join(pluginRoot, 'biffo.plugin.json'),
    JSON.stringify({ name: 'demo', version: '0.1.0', description: 'd', author: 'a' }),
  )
  const coreRoot = tmp('core-')
  const workDir = tmp('work-')
  const calls: string[] = []
  const spawned: Spawned[] = []

  const runner: CommandRunner = {
    run: (cmd, args): CommandResult => {
      if (cmd.endsWith('pg-test-db.sh')) {
        calls.push('postgres')
        return { status: 0, stdout: 'postgresql://u:p@localhost:5/biffo_test_aaaaaaaa\n' }
      }
      if (cmd === 'psql') return { status: 0, stdout: '' }
      if (args.includes('biffo_plugin_sdk.conformance')) {
        calls.push('conformance')
        return { status: over.conformanceStatus ?? 0, stdout: '' }
      }
      if (args.includes('-c')) return { status: 0, stdout: '' } // host preflight
      calls.push('bootstrap')
      return { status: over.bootstrapStatus ?? 0, stdout: '' }
    },
  }

  let port = 41000
  const compose: ComposeDeps = {
    runner,
    findScript: (p) => `/pkg/${p}`,
    spawnProcess: (name, _cmd, args, opts) => {
      calls.push(`spawn:${name}`)
      const isCore = name === 'core'
      const rec: Spawned = {
        name,
        args,
        env: opts.env,
        killed: false,
        // Core starts only as `core_app:core_app` with a database URL — the two things
        // `compose-stack.ts` is responsible for getting right.
        dead: isCore && !(args.includes('core_app:core_app') && !!opts.env.BIFFO_DATABASE_URL),
      }
      spawned.push(rec)
      const proc: ManagedProcess = {
        name,
        exited: Promise.resolve(rec.dead ? 1 : 0),
        hasExited: () => rec.dead,
        kill: async () => {
          rec.killed = true
        },
      }
      return proc
    },
    // Answers like a router: health is open, everything else needs a token and 404s.
    fetchFn: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/health') || url.endsWith('/')) return new Response('', { status: 200 })
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      return new Response('', { status: auth ? 404 : 401 })
    },
    parentEnv: { PATH: '/bin' },
    freePort: async () => port++,
    makeWorkDir: () => workDir,
    removeDir: () => undefined,
    sleep: async () => undefined,
    log: () => undefined,
  }

  const options: PluginVerifyOptions = { cwd: pluginRoot, listChecks: false, realCore: true }
  const deps: PluginVerifyDeps = {
    runner,
    findScript: (p) => `/pkg/${p}`,
    realCore: { coreRoot: () => coreRoot, compose, configFile: null },
  }
  return { options, deps, calls, spawned }
}

describe('plugin verify real_core seam consumes plugin-compose/compose-stack', () => {
  it('is green when the composition the dev loop runs comes up healthy', async () => {
    const { options, deps, calls } = setup()
    expect(await runPluginVerify(options, deps)).toBe(0)
    // Core, then the host — the start order `compose-stack.ts` owns, seen from verify.
    expect(calls.filter((c) => c.startsWith('spawn:'))).toEqual(['spawn:core', 'spawn:host'])
  })

  it('goes RED when compose-stack cannot start Core, and tears down what it started', async () => {
    const { options, deps, spawned } = setup()
    const compose = deps.realCore!.compose
    const realSpawn = compose.spawnProcess
    // The shape of a compose-stack change that breaks Core start-up: Core is launched wrong.
    compose.spawnProcess = (name, cmd, args, opts) =>
      realSpawn(
        name,
        cmd,
        name === 'core'
          ? args.map((a) => (a === 'core_app:core_app' ? 'core_app:missing' : a))
          : args,
        opts,
      )
    expect(await runPluginVerify(options, deps)).toBe(1)
    expect(spawned.map((s) => s.name)).toEqual(['core']) // the host was never started
    expect(spawned[0]!.killed).toBe(true)
  })

  it('goes RED when Core has no database wired (BIFFO_DATABASE_URL dropped)', async () => {
    const { options, deps } = setup()
    const compose = deps.realCore!.compose
    const realSpawn = compose.spawnProcess
    compose.spawnProcess = (name, cmd, args, opts) => {
      const env = { ...opts.env }
      if (name === 'core') delete env.BIFFO_DATABASE_URL
      return realSpawn(name, cmd, args, { ...opts, env })
    }
    expect(await runPluginVerify(options, deps)).toBe(1)
  })

  it('goes RED when Core/plugin migrations fail', async () => {
    const { options, deps, spawned } = setup({ bootstrapStatus: 1 })
    expect(await runPluginVerify(options, deps)).toBe(1)
    expect(spawned).toEqual([])
  })

  it('goes RED when a route that does not exist answers 200 (the known-bad control)', async () => {
    const { options, deps } = setup()
    deps.realCore!.compose.fetchFn = async () => new Response('', { status: 200 })
    expect(await runPluginVerify(options, deps)).toBe(1)
  })

  it('does not compose at all when the conformance passes are already red', async () => {
    const { options, deps, calls } = setup({ conformanceStatus: 1 })
    expect(await runPluginVerify(options, deps)).toBe(1)
    expect(calls.some((c) => c.startsWith('spawn:'))).toBe(false)
  })

  it('fails closed when the seam is required but not wired (never a silent skip)', async () => {
    const { options, deps, calls } = setup()
    delete deps.realCore
    expect(await runPluginVerify(options, deps)).toBe(2)
    expect(calls).toEqual([]) // refused before raising Postgres or running any check
  })

  it('--no-real-core skips the seam, loudly, without composing', async () => {
    const { options, deps, calls } = setup()
    const { log } = await import('../logger.js')
    expect(await runPluginVerify({ ...options, realCore: false }, deps)).toBe(0)
    expect(calls.some((c) => c.startsWith('spawn:'))).toBe(false)
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('real_core')
  })

  it('reports a Core that could not be located as a red seam, not a crash', async () => {
    const { options, deps } = setup()
    deps.realCore!.coreRoot = () => {
      throw new Error('could not fetch Core')
    }
    expect(await runPluginVerify(options, deps)).toBe(1)
  })
})
