import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BiffoConfigSchema, type BiffoConfig } from '../config/schema.js'
import type { SiblingSession } from './sibling-session.js'

export type CompletedStep =
  | 'verify_credentials'
  | 'create_repo'
  | 'oidc_trust'
  | 'terraform_backend'
  /**
   * Step 5 used to be one checkpoint guarding ~15 GitHub side effects
   * (issue #316). It is now three, split at the two boundaries that actually
   * matter on a resume:
   *
   *   github_branches       — creating dev/staging from main
   *   github_instance_files — the commits that write biffo.core.json, drop the
   *                           template biffo.config.json, and register the app
   *                           sibling, on all three branches. This is the only
   *                           part that writes git objects, and re-running it
   *                           against a repo whose git state has moved on is
   *                           what produced the GitRPC::BadObjectState in #316.
   *   github_settings       — default branch, protection, environments,
   *                           variables, secrets. Every call is an idempotent
   *                           upsert, so this stays one checkpoint.
   */
  | 'github_branches'
  | 'github_instance_files'
  | 'github_settings'
  /**
   * Legacy: written by CLIs before the split above. Sessions carrying it are
   * treated as having completed all three successors — see `hasCompleted`.
   * Never written by current code.
   */
  | 'github_config'
  | 'app_sibling'

/**
 * Steps a legacy checkpoint stands in for, so a session written by an older
 * CLI is not replayed by a newer one.
 */
const LEGACY_STEP_ALIASES: Partial<Record<CompletedStep, CompletedStep[]>> = {
  github_config: ['github_branches', 'github_instance_files', 'github_settings'],
}

/**
 * Has `step` already been done? Use this rather than
 * `session.completedSteps.includes(step)` so legacy checkpoints keep working.
 */
export function hasCompleted(session: InitSession, step: CompletedStep): boolean {
  if (session.completedSteps.includes(step)) return true
  return session.completedSteps.some((done) => LEGACY_STEP_ALIASES[done]?.includes(step) ?? false)
}

export interface InitSession {
  version: 1
  config: Partial<BiffoConfig>
  awsAccountId: string
  awsRegion: string
  completedSteps: CompletedStep[]
  outputs: {
    cloneUrl?: string
    oidcRoleArn?: string
    tfStateBucket?: string
    /**
     * The nested session for the root application sibling `biffo init` creates
     * (issue #306). Held here rather than in ~/.biffo/sibling-sessions so that
     * resuming an interrupted `init` resumes the sibling at the same
     * granularity as everything else: the sibling's own steps are checkpointed
     * inside it, so a re-run does not try to re-create a repo that already
     * exists.
     */
    appSibling?: SiblingSession
  }
}

function sessionsDir(): string {
  return process.env['BIFFO_SESSIONS_DIR'] ?? join(homedir(), '.biffo', 'sessions')
}

function sessionPath(projectName: string): string {
  return join(sessionsDir(), `${projectName}.json`)
}

export function loadSession(projectName: string): InitSession | null {
  const path = sessionPath(projectName)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InitSession
  } catch {
    return null
  }
}

export function findLatestSession(): InitSession | null {
  const dir = sessionsDir()
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) return null
  // Return the most recently modified session.
  const sorted = files
    .map((f) => {
      const fullPath = join(dir, f)
      const mtime = existsSync(fullPath) ? statSync(fullPath).mtimeMs : -1
      return { f, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
  try {
    return JSON.parse(readFileSync(join(dir, sorted[0]!.f), 'utf8')) as InitSession
  } catch {
    return null
  }
}

/**
 * Persist `session`, **monotonically**: a step recorded on disk is never
 * un-recorded, and an output recorded on disk is never dropped.
 *
 * Issue #316: a resume that started from a fresh in-memory session overwrote a
 * five-step session file with a four-step one, losing `github_config` even
 * though that work had demonstrably happened in the repo. The next run then
 * re-attempted it against git state that had already moved on. A save must
 * only ever be able to move `completedSteps` forwards; a run that genuinely
 * wants to start over calls `deleteSession` first (that is what `--fresh` does).
 */
export function saveSession(session: InitSession): void {
  const dir = sessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const name = session.config.project?.name ?? 'unknown'

  const prior = loadSession(name)
  if (prior) {
    for (const step of prior.completedSteps) {
      if (!session.completedSteps.includes(step)) session.completedSteps.push(step)
    }
    session.outputs = { ...prior.outputs, ...definedOnly(session.outputs) }
  }

  writeFileSync(sessionPath(name), JSON.stringify(session, null, 2))
}

/** Spreading `{ a: undefined }` over a prior value erases it; this stops that. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function markStepComplete(session: InitSession, step: CompletedStep): void {
  if (!session.completedSteps.includes(step)) {
    session.completedSteps.push(step)
  }
  saveSession(session)
}

export function deleteSession(projectName: string): void {
  const path = sessionPath(projectName)
  if (existsSync(path)) rmSync(path)
}

// ─── Project config store ─────────────────────────────────────────────────────
// Persists the resolved BiffoConfig after a successful biffo init so that
// biffo deploy can find it without requiring a local biffo.config.json.

function projectsDir(): string {
  return process.env['BIFFO_PROJECTS_DIR'] ?? join(homedir(), '.biffo', 'projects')
}

export function saveProjectConfig(config: BiffoConfig): void {
  const dir = projectsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${config.project.name}.json`), JSON.stringify(config, null, 2))
}

export function loadProjectConfig(name: string): BiffoConfig | null {
  const path = join(projectsDir(), `${name}.json`)
  if (!existsSync(path)) return null
  try {
    const result = BiffoConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function deleteProjectConfig(name: string): void {
  const path = join(projectsDir(), `${name}.json`)
  if (existsSync(path)) rmSync(path)
}

export function listProjectConfigs(): BiffoConfig[] {
  const dir = projectsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const result = BiffoConfigSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')))
        return result.success ? [result.data] : []
      } catch {
        return []
      }
    })
}
