import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger.js'
import { composeStack, type ComposeDeps, type ComposedStack } from './compose-stack.js'
import { generateDevKeypair, mintDevToken } from './dev-auth.js'
import { buildProbes, probesGreen, runProbes, type ProbeResult } from './probes.js'

export interface DevUpOptions {
  pluginRoot: string
  coreRoot: string
  configFile: string | null
  reload: boolean
  /** Compose, run the probes, tear down, exit — instead of staying up. */
  check: boolean
  /** Fires on SIGINT/SIGTERM/SIGHUP for the whole run; handed to the composition so it can tear down mid-startup. */
  signal?: AbortSignal
  /** Prefix for what this run prints. `dev up` by default; `plugin verify` names its own seam. */
  label?: string
}

export interface DevUpHooks {
  /** Resolves when the user asks to stop (interactive mode). */
  untilInterrupted: () => Promise<void>
  write: (line: string) => void
}

/** Conventional exit for a run cut short by a signal (128 + SIGINT). */
const INTERRUPTED_EXIT = 130

export const DEFAULT_DEV_CONFIG = 'biffo.dev.json'

/** The config file to use: explicit, else `biffo.dev.json` if present, else none. */
export function pickConfigFile(pluginRoot: string, explicit?: string): string | null {
  if (explicit) return explicit
  const fallback = join(pluginRoot, DEFAULT_DEV_CONFIG)
  return existsSync(fallback) ? fallback : null
}

export function formatProbeTable(results: ProbeResult[]): string[] {
  return results.map(
    (r) =>
      `  ${r.ok ? 'OK      ' : 'MISMATCH'} ${String(r.got).padEnd(5)} (want ${r.expect})  ${r.label}`,
  )
}

/** `git check-ignore -q`: 0 ignored, 1 tracked-or-unignored, anything else (not a repo) = say nothing. */
function isGitIgnored(deps: ComposeDeps, cwd: string, file: string): boolean {
  const { status } = deps.runner.run('git', ['check-ignore', '-q', file], {
    cwd,
    captureStdout: false,
  })
  return status !== 1
}

/**
 * `biffo dev up`: composeStack + probes + stay-up. Owns no composition logic —
 * everything that starts a process lives in `composeStack`, shared with verify.
 */
export async function runDevUp(
  options: DevUpOptions,
  deps: ComposeDeps,
  hooks: DevUpHooks,
): Promise<number> {
  const label = options.label ?? 'dev up'
  if (options.configFile && !isGitIgnored(deps, options.pluginRoot, options.configFile)) {
    log.warn(
      `${label}: ${options.configFile} may hold secret values and is NOT git-ignored — add it to ` +
        `.gitignore before it is committed (Secret Scan reads history, not just your diff)`,
    )
  }
  let stack: ComposedStack
  try {
    stack = await composeStack({ ...options, readyTimeoutMs: 120_000 }, deps)
  } catch (err) {
    if (options.signal?.aborted) {
      // Not a failure: the operator (or a supervisor) stopped it, and the composition tore itself down.
      log.info(`${label}: interrupted — everything started so far was torn down`)
      return INTERRUPTED_EXIT
    }
    log.error(`${label}: ${(err as Error).message}`)
    return 1
  }

  try {
    const wrongKey = generateDevKeypair()
    const { probes, notes } = buildProbes({
      coreUrl: stack.coreUrl,
      hostUrl: stack.hostUrl,
      manifest: stack.manifest,
      adminToken: stack.adminToken,
      privateKeyPem: stack.keypair.privateKeyPem,
      wrongKeyToken: mintDevToken(wrongKey.privateKeyPem, { groups: stack.groups }),
    })
    const results = await runProbes(probes, deps.fetchFn)
    hooks.write(`${label}: ${results.filter((r) => r.ok).length}/${results.length} probes matched`)
    for (const line of formatProbeTable(results)) hooks.write(line)
    for (const note of notes) hooks.write(`  note: ${note}`)
    const verdict = probesGreen(results, stack.manifest)

    if (stack.sink.unexpected.length > 0) {
      hooks.write(
        `${label}: WARNING ${stack.sink.unexpected.length} AWS call(s) hit the local sink with no ` +
          `implementation (${[...new Set(stack.sink.unexpected)].join(', ')}) — refused, not forwarded`,
      )
    }

    if (options.check) {
      // A signal during the probes means the answers cannot be trusted as a verdict either way.
      if (options.signal?.aborted) return INTERRUPTED_EXIT
      if (!verdict.ok) log.error(`${label} --check: ${verdict.reason}`)
      else log.success(`${label} --check: composition healthy`)
      return verdict.ok ? 0 : 1
    }

    if (!verdict.ok)
      log.warn(`${label}: ${verdict.reason} — the stack is up, but do not trust it yet`)
    hooks.write('')
    hooks.write(`  Core         ${stack.coreUrl}/api/v1   (health: /health)`)
    hooks.write(`  Plugin host  ${stack.hostUrl}/${stack.manifest.name}/<route>`)
    hooks.write(`  Postgres     ${stack.dsn}`)
    hooks.write(`  Token groups ${stack.groups.join(', ')}`)
    if (stack.configSummary.length > 0) {
      hooks.write(`  Config       ${stack.configSummary.join('; ')}`)
    }
    hooks.write(
      `  Hot reload   ${options.reload ? 'host restarts on plugin source changes' : 'off'}; a manifest/table change needs dev up restarted`,
    )
    hooks.write('')
    hooks.write('  export TOKEN=' + stack.adminToken)
    hooks.write(
      `  curl -H "Authorization: Bearer $TOKEN" ${stack.hostUrl}/${stack.manifest.name}/<declared route>`,
    )
    hooks.write('')
    hooks.write(`${label}: running — Ctrl-C to stop`)
    await hooks.untilInterrupted()
    return 0
  } finally {
    await stack.close()
  }
}

/**
 * Compose the stack, run the self-check probes, tear down, and say whether the
 * composition is healthy: `biffo dev up --check`, as a function. It is the ONE
 * implementation of "does Core + host start and answer" — `biffo plugin verify`'s
 * `real_core` seam (#1523 item 3, #2105) calls this rather than composing anything
 * itself, so the dev loop and CI cannot disagree about what a healthy composition is.
 * Returns 0 healthy, 1 not, 130 interrupted.
 */
export function runCompositionCheck(
  options: Omit<DevUpOptions, 'check'>,
  deps: ComposeDeps,
  write: (line: string) => void,
): Promise<number> {
  return runDevUp({ ...options, check: true }, deps, { write, untilInterrupted: async () => {} })
}
