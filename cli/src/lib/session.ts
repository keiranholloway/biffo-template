import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BiffoConfig } from '../config/schema.js'

export type CompletedStep =
  'verify_credentials' | 'create_repo' | 'oidc_trust' | 'terraform_backend' | 'github_config'

export interface InitSession {
  version: 1
  config: Partial<BiffoConfig>
  awsAccountId: string
  awsRegion: string
  completedSteps: CompletedStep[]
  outputs: {
    cloneUrl?: string
    oidcRoleArn?: string
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
  // Return the most recently modified session
  const sorted = files
    .map((f) => ({ f, mtime: existsSync(join(dir, f)) ? readFileSync(join(dir, f)).length : 0 }))
    .sort((a, b) => b.mtime - a.mtime)
  try {
    return JSON.parse(readFileSync(join(dir, sorted[0]!.f), 'utf8')) as InitSession
  } catch {
    return null
  }
}

export function saveSession(session: InitSession): void {
  const dir = sessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const name = session.config.project?.name ?? 'unknown'
  writeFileSync(sessionPath(name), JSON.stringify(session, null, 2))
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
