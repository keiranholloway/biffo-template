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
import type { SiblingConfig } from '../config/sibling-schema.js'

// Separate from lib/session.ts's InitSession store (not reused, not merged
// in): a paused `biffo sibling create <name>` run and a paused
// `biffo init` for a project of the same name are unrelated resumable
// sessions and must not collide on one shared file. Unlike biffo init,
// there is no companion "project config" store here — a sibling never
// needs `biffo deploy`/`biffo destroy` run against it after creation, since
// it deploys via its own repo's own `.github/workflows/deploy.yml`
// (ADR-0007) — this file only exists to make `sibling create` itself
// resumable across a run that fails partway through.
export type CompletedSiblingStep =
  | 'verify_credentials'
  | 'resolve_core_identity'
  /**
   * `create_repo` and `push_skeleton` were one checkpoint guarding two side
   * effects until issue #316. `createEmptyRepo` succeeded, `pushSkeleton`
   * threw (#315), nothing was recorded, and the resume re-ran repo creation
   * against a repo that now existed. Each side effect gets its own checkpoint,
   * recorded the moment it succeeds.
   */
  | 'create_repo'
  | 'push_skeleton'
  | 'oidc_trust'
  | 'terraform_backend'
  | 'github_config'
  | 'register_with_core'
  | 'trigger_first_deploy'

export interface CoreIdentity {
  cognitoUserPoolId: string
  cognitoClientId: string
  apiUrl: string
  portalUrl: string
}

export interface SiblingSession {
  version: 1
  config: Partial<SiblingConfig>
  awsAccountId: string
  awsRegion: string
  completedSteps: CompletedSiblingStep[]
  outputs: {
    // Keyed by environment — each environment has its own Cognito pool
    // (infra/environments/<env>/main.tf in the core project), so a sibling
    // provisioning multiple environments needs a separate identity per one.
    coreIdentity?: Record<string, CoreIdentity>
    cloneUrl?: string
    oidcRoleArn?: string
    tfStateBucket?: string
    registrationPrUrl?: string
  }
}

function sessionsDir(): string {
  return process.env['BIFFO_SIBLING_SESSIONS_DIR'] ?? join(homedir(), '.biffo', 'sibling-sessions')
}

function sessionPath(projectName: string): string {
  return join(sessionsDir(), `${projectName}.json`)
}

export function loadSiblingSession(projectName: string): SiblingSession | null {
  const path = sessionPath(projectName)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SiblingSession
  } catch {
    return null
  }
}

export function findLatestSiblingSession(): SiblingSession | null {
  const dir = sessionsDir()
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) return null
  const sorted = files
    .map((f) => {
      const fullPath = join(dir, f)
      const mtime = existsSync(fullPath) ? statSync(fullPath).mtimeMs : -1
      return { f, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
  try {
    return JSON.parse(readFileSync(join(dir, sorted[0]!.f), 'utf8')) as SiblingSession
  } catch {
    return null
  }
}

/**
 * Persist `session` monotonically — see the note on `saveSession` in
 * lib/session.ts (issue #316). A save can only move `completedSteps` forwards;
 * starting over means calling `deleteSiblingSession` first.
 */
export function saveSiblingSession(session: SiblingSession): void {
  const dir = sessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const name = session.config.project?.name ?? 'unknown'

  const prior = loadSiblingSession(name)
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

export function markSiblingStepComplete(session: SiblingSession, step: CompletedSiblingStep): void {
  if (!session.completedSteps.includes(step)) {
    session.completedSteps.push(step)
  }
  saveSiblingSession(session)
}

export function deleteSiblingSession(projectName: string): void {
  const path = sessionPath(projectName)
  if (existsSync(path)) rmSync(path)
}
