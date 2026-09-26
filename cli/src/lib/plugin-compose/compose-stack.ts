import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { packagedScriptMissing } from '../packaged-scripts.js'
import { validateManifest, type PluginManifest } from '../plugin-manifest.js'
import { isolatedBaseEnv } from './aws-isolation.js'
import type { CommandRunner } from './command-runner.js'
import { readDevConfigFile, resolveDevConfig } from './dev-config.js'
import { cognitoEnv, generateDevKeypair, mintDevToken, type DevKeypair } from './dev-auth.js'
import { startLocalAwsSink, type LocalAwsSink } from './local-aws-sink.js'
import { raisePostgres } from './raise-postgres.js'
import { BOOTSTRAP_PY, CORE_APP_PY, HOST_APP_PY } from './python-assets.js'

/**
 * THE composition (biffo-template#1525): Postgres + Core + the shared plugin host
 * + the plugin under development, on one machine, off real AWS. `biffo dev up` is
 * its interactive form; `biffo plugin verify` reuses the same Postgres raising,
 * command runner and uv invocation (`raise-postgres.ts`, `command-runner.ts`) and
 * is where the `real_core` seam (#1523 item 3) will consume `composeStack` rather
 * than growing a second copy. What the spike (#1522) proved runs here, unchanged:
 * Core boots under plain uvicorn against real Postgres, and a dev-minted RS256
 * token is accepted by Core AND the host's real Cognito authorizer through the
 * baked-JWKS path both already have.
 */
export interface ManagedProcess {
  name: string
  /** Resolves with the exit code once the process is gone (null = signalled). */
  exited: Promise<number | null>
  hasExited(): boolean
  kill(): Promise<void>
}

export type ProcessSpawner = (
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ManagedProcess

export interface ComposeOptions {
  pluginRoot: string
  coreRoot: string
  /** Local plugin-config file, or null when the plugin has no config to supply. */
  configFile: string | null
  /** Hot-reload the host on plugin source changes. */
  reload: boolean
  readyTimeoutMs: number
  /**
   * Fires when the process is asked to stop (SIGINT/SIGTERM/SIGHUP). Everything
   * started so far is torn down at once — even mid-startup, when the caller is
   * still blocked in `composeStack` and has no `close()` to call yet.
   */
  signal?: AbortSignal
}

export interface ComposeDeps {
  runner: CommandRunner
  findScript: (relativePath: string) => string | null
  spawnProcess: ProcessSpawner
  fetchFn: typeof fetch
  parentEnv: NodeJS.ProcessEnv
  freePort: () => Promise<number>
  makeWorkDir: () => string
  /** Removes a directory made by `makeWorkDir`, with everything under it. */
  removeDir: (dir: string) => void
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

export interface ComposedStack {
  coreUrl: string
  hostUrl: string
  dsn: string
  manifest: PluginManifest
  keypair: DevKeypair
  /** Groups the minted tokens carry: admin + founder + the manifest's own ingress groups. */
  groups: string[]
  adminToken: string
  sink: LocalAwsSink
  workDir: string
  configSummary: string[]
  close(): Promise<void>
}

const PG_TEST_DB_SCRIPT = 'scripts/pg-test-db.sh'

/** Exit code of the preflight snippet when `plugin_host` is not importable (distinct from uv's own failures). */
const HOST_MISSING_EXIT = 3
const HOST_PREFLIGHT_PY =
  `import importlib.util, sys; ` +
  `sys.exit(0 if importlib.util.find_spec('plugin_host') else ${HOST_MISSING_EXIT})`

/**
 * The per-run clone `scripts/pg-test-db.sh` makes (`<template>_r<8 hex>`, where the
 * template is `biffo_test_<8 hex>`). Only this exact shape is ever removed: a shared
 * database (`BIFFO_PG_SHARED`, an explicit `BIFFO_PG_DB`) is somebody else's, and
 * a teardown that removed it would destroy the fixture every later run reuses.
 */
const CLONE_DB_NAME = /^biffo_test_[0-9a-f]{8}_r[0-9a-f]{8}$/

interface CloneDrop {
  name: string
  args: string[]
  env: Record<string, string>
}

/** The `psql` invocation that removes the run's cloned database, or null if `dsn` is not a clone. */
export function cloneDropCommand(dsn: string): CloneDrop | null {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  const name = decodeURIComponent(url.pathname.slice(1))
  if (!CLONE_DB_NAME.test(name)) return null
  return {
    name,
    // Admin connection to `postgres`: a session cannot drop the database it is connected to.
    args: [
      '-q',
      '-h',
      url.hostname,
      '-p',
      url.port || '5432',
      '-U',
      decodeURIComponent(url.username),
      '-d',
      'postgres',
      '-c',
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ],
    env: { PGPASSWORD: decodeURIComponent(url.password) },
  }
}

export function toAsyncpgDsn(dsn: string): string {
  return dsn.replace(/^postgres(ql)?:\/\//, 'postgresql+asyncpg://')
}

export async function composeStack(
  options: ComposeOptions,
  deps: ComposeDeps,
): Promise<ComposedStack> {
  const manifestPath = join(options.pluginRoot, 'biffo.plugin.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`no biffo.plugin.json at ${manifestPath} — run from a plugin repo checkout`)
  }
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))

  // Config first: a missing required value must fail before anything is started.
  const configValues = options.configFile ? readDevConfigFile(options.configFile) : {}
  const config = resolveDevConfig(
    manifest,
    configValues,
    options.configFile ? `dev config ${options.configFile}` : 'dev config (no --config-file given)',
  )

  const signal = options.signal
  const throwIfInterrupted = () => {
    if (signal?.aborted) throw new Error('interrupted by a signal — tore down what had started')
  }
  throwIfInterrupted()

  preflightHost(options.pluginRoot, manifest.name, deps)
  throwIfInterrupted()

  const script = deps.findScript(PG_TEST_DB_SCRIPT)
  if (!script) throw new Error(packagedScriptMissing(PG_TEST_DB_SCRIPT))
  const raised = raisePostgres(deps.runner, script, options.pluginRoot)
  if (!raised.dsn) {
    throw new Error(`could not provision Postgres (${PG_TEST_DB_SCRIPT} exited ${raised.status})`)
  }
  const dsn = raised.dsn

  // Teardown, in reverse order of what was started. Idempotent and shared: the
  // signal handler, the failure path and the caller's own close() may all race here.
  const cleanups: Array<() => Promise<void>> = []
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    closing ??= (async () => {
      signal?.removeEventListener('abort', onAbort)
      for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined)
      cleanups.length = 0
    })()
    return closing
  }
  const onAbort = () => void close()
  signal?.addEventListener('abort', onAbort, { once: true })

  // Registered first, so it runs last: every process that holds the clone open is gone by then.
  cleanups.push(async () => {
    const drop = cloneDropCommand(dsn)
    if (!drop) return
    const { status } = deps.runner.run('psql', drop.args, {
      cwd: options.pluginRoot,
      captureStdout: false,
      env: { ...definedEnv(deps.parentEnv), ...drop.env },
    })
    if (status !== 0) {
      deps.log(`dev: could not remove cloned database ${drop.name} (psql exited ${status})`)
    }
  })

  try {
    throwIfInterrupted()
    const sink = await startLocalAwsSink(config.parameters)
    cleanups.push(() => sink.close())

    const workDir = deps.makeWorkDir()
    cleanups.push(async () => deps.removeDir(workDir))
    const servicesRoot = join(workDir, 'services')
    const appDir = join(workDir, 'apps')
    mkdirSync(servicesRoot, { recursive: true })
    mkdirSync(appDir, { recursive: true })
    // Discovery expects `<root>/<name>/biffo.plugin.json`; the repo root IS that directory.
    symlinkSync(options.pluginRoot, join(servicesRoot, manifest.name), 'dir')
    writeFileSync(join(appDir, 'core_app.py'), CORE_APP_PY)
    writeFileSync(join(appDir, 'host_app.py'), HOST_APP_PY)
    writeFileSync(join(appDir, 'bootstrap.py'), BOOTSTRAP_PY)

    const keypair = generateDevKeypair()
    const groups = [
      ...new Set(
        [
          'admin',
          'founder',
          manifest.user_ingress?.required_group,
          manifest.admin_ingress?.required_group,
        ].filter((g): g is string => Boolean(g)),
      ),
    ]
    const adminToken = mintDevToken(keypair.privateKeyPem, { groups })

    const coreApi = join(options.coreRoot, 'services', 'api')
    const base = isolatedBaseEnv(deps.parentEnv, sink.url)
    const corePort = await deps.freePort()
    const hostPort = await deps.freePort()
    const coreUrl = `http://127.0.0.1:${corePort}`
    const hostUrl = `http://127.0.0.1:${hostPort}`
    const iamArn = 'arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-host-role/session'
    const coreEnv = {
      ...base,
      ...cognitoEnv(keypair.jwksJson),
      PYTHONPATH: join(coreApi, 'src'),
      BIFFO_DATABASE_URL: toAsyncpgDsn(dsn),
      BIFFO_PLUGIN_SERVICES_ROOT: servicesRoot,
      BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST: JSON.stringify([
        'arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-host-role/*',
      ]),
      BIFFO_DEV_IAM_ARN: iamArn,
    }

    deps.log('dev: applying Core + plugin migrations (alembic upgrade head)')
    const boot = deps.runner.run(
      'uv',
      [
        'run',
        '--frozen',
        '--directory',
        coreApi,
        'python',
        join(appDir, 'bootstrap.py'),
        join(workDir, 'state'),
        servicesRoot,
      ],
      { cwd: coreApi, captureStdout: false, env: coreEnv },
    )
    if (boot.status !== 0) {
      throw new Error(`Core/plugin migrations failed (exit ${boot.status}) — see output above`)
    }
    throwIfInterrupted()

    const core = deps.spawnProcess(
      'core',
      'uv',
      [
        'run',
        '--frozen',
        '--directory',
        coreApi,
        '--with',
        'uvicorn',
        'uvicorn',
        '--app-dir',
        appDir,
        'core_app:core_app',
        '--port',
        String(corePort),
        '--log-level',
        'warning',
      ],
      { cwd: coreApi, env: coreEnv },
    )
    cleanups.push(() => core.kill())

    // Core first, and healthy, BEFORE the host exists. A plugin's startup may call
    // Core (ideation seeds its agent config through a signed Core call); a host
    // spawned alongside a not-yet-listening Core hits ConnectError, is quarantined
    // by the shared host, and answers 503 on every route for the life of the
    // process (#1525 verdict, finding 1). Start order is the fix, not a probe.
    await waitReady(
      { proc: core, url: `${coreUrl}/api/v1/health`, name: 'Core' },
      deps,
      options.readyTimeoutMs,
      signal,
    )

    const hostEnv = {
      ...base,
      ...cognitoEnv(keypair.jwksJson),
      ...config.env,
      BIFFO_PLUGINS_ROOT: servicesRoot,
      BIFFO_CORE_API_URL: coreUrl,
    }
    const host = deps.spawnProcess(
      'host',
      'uv',
      [
        'run',
        '--frozen',
        '--directory',
        options.pluginRoot,
        '--with',
        'uvicorn',
        ...(options.reload ? ['--with', 'watchfiles'] : []),
        'uvicorn',
        '--app-dir',
        appDir,
        'host_app:host_app',
        '--port',
        String(hostPort),
        '--log-level',
        'warning',
        ...(options.reload ? ['--reload', '--reload-dir', options.pluginRoot] : []),
      ],
      { cwd: options.pluginRoot, env: hostEnv },
    )
    cleanups.push(() => host.kill())

    await waitReady(
      { proc: host, url: `${hostUrl}/`, name: 'plugin host' },
      deps,
      options.readyTimeoutMs,
      signal,
    )

    return {
      coreUrl,
      hostUrl,
      dsn,
      manifest,
      keypair,
      groups,
      adminToken,
      sink,
      workDir,
      configSummary: config.summary,
      close,
    }
  } catch (err) {
    await close()
    throw err
  }
}

/**
 * Refuses, before anything is started, a plugin whose own Python environment cannot
 * import the shared host. The host runs from the plugin's venv (`uv run --directory
 * <plugin>`); a repo that predates the plugin skeleton's `biffo-plugin-host`
 * dev-dependency otherwise costs a 120s readiness wait and a bare
 * `ModuleNotFoundError: plugin_host` traceback (#1525 verdict, finding 2).
 */
function preflightHost(pluginRoot: string, name: string, deps: ComposeDeps): void {
  const { status } = deps.runner.run(
    'uv',
    ['run', '--frozen', '--directory', pluginRoot, 'python', '-c', HOST_PREFLIGHT_PY],
    { cwd: pluginRoot, captureStdout: false },
  )
  if (status === 0) return
  if (status === HOST_MISSING_EXIT) {
    throw new Error(
      `plugin ${name} cannot run under the shared plugin host: biffo-plugin-host is not ` +
        `installed in ${pluginRoot}'s Python environment. Add it with ` +
        `\`uv add --dev biffo-plugin-host\` (the plugin skeleton pins ~=0.1.0), then re-run.`,
    )
  }
  throw new Error(
    `could not run the plugin's Python environment to check for biffo-plugin-host ` +
      `(uv run exited ${status}) — see output above`,
  )
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  )
}

async function waitReady(
  target: { proc: ManagedProcess; url: string; name: string },
  deps: ComposeDeps,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw new Error('interrupted by a signal — tore down what had started')
    if (target.proc.hasExited()) {
      throw new Error(`${target.name} exited before it became ready — see its output above`)
    }
    try {
      // Any HTTP answer (even 401) proves the server is up; only a refused connection retries.
      await deps.fetchFn(target.url)
      return
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${target.name} did not answer ${target.url} within ${timeoutMs}ms`)
      }
      await deps.sleep(500)
    }
  }
}

// ---------------------------------------------------------------- real deps

export function spawnManaged(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): ManagedProcess {
  // detached => its own process group, so kill() takes `uv` AND the uvicorn (and
  // any --reload child) beneath it; killing only `uv` would orphan the server.
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = ''
    stream?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        sink(`[${name}] ${buf.slice(0, nl)}`)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
  let done = false
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      done = true
      resolve(code)
    })
    child.on('error', () => {
      done = true
      resolve(null)
    })
  })
  return {
    name,
    exited,
    hasExited: () => done,
    kill: async () => {
      if (done || child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        return
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-(child.pid as number), 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, 5000)
      await exited
      clearTimeout(timer)
    },
  }
}

export function realFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export function realComposeDeps(
  runner: CommandRunner,
  findScript: (relativePath: string) => string | null,
  log: (line: string) => void,
): ComposeDeps {
  return {
    runner,
    findScript,
    spawnProcess: (name, cmd, args, opts) => spawnManaged(name, cmd, args, opts),
    fetchFn: fetch,
    parentEnv: process.env,
    freePort: realFreePort,
    // Under ~/.cache, never /tmp: /tmp is RAM-backed and a Core copy carries a venv-sized tree.
    makeWorkDir: () => {
      const root = join(homedir(), '.cache', 'biffo', 'compose')
      mkdirSync(root, { recursive: true })
      return mkdtempSync(join(root, 'run-'))
    },
    // rmSync never follows the symlink to the plugin repo inside the run directory: it unlinks it.
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  }
}
