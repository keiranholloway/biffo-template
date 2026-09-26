import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
}

export interface ComposeDeps {
  runner: CommandRunner
  findScript: (relativePath: string) => string | null
  spawnProcess: ProcessSpawner
  fetchFn: typeof fetch
  parentEnv: NodeJS.ProcessEnv
  freePort: () => Promise<number>
  makeWorkDir: () => string
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

  const script = deps.findScript(PG_TEST_DB_SCRIPT)
  if (!script) throw new Error(packagedScriptMissing(PG_TEST_DB_SCRIPT))
  const raised = raisePostgres(deps.runner, script, options.pluginRoot)
  if (!raised.dsn) {
    throw new Error(`could not provision Postgres (${PG_TEST_DB_SCRIPT} exited ${raised.status})`)
  }
  const dsn = raised.dsn

  const cleanups: Array<() => Promise<void>> = []
  const close = async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined)
    cleanups.length = 0
  }

  try {
    const sink = await startLocalAwsSink(config.parameters)
    cleanups.push(() => sink.close())

    const workDir = deps.makeWorkDir()
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
      [
        { proc: core, url: `${coreUrl}/api/v1/health`, name: 'Core' },
        { proc: host, url: `${hostUrl}/`, name: 'plugin host' },
      ],
      deps,
      options.readyTimeoutMs,
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

async function waitReady(
  targets: Array<{ proc: ManagedProcess; url: string; name: string }>,
  deps: ComposeDeps,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (const t of targets) {
    for (;;) {
      if (t.proc.hasExited()) {
        throw new Error(`${t.name} exited before it became ready — see its output above`)
      }
      try {
        // Any HTTP answer (even 401) proves the server is up; only a refused connection retries.
        await deps.fetchFn(t.url)
        break
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`${t.name} did not answer ${t.url} within ${timeoutMs}ms`)
        }
        await deps.sleep(500)
      }
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
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  }
}
