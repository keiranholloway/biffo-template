import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSession,
  findLatestSession,
  loadSession,
  markStepComplete,
  saveSession,
  type InitSession,
} from './session.js'

function makeSession(name: string): InitSession {
  return {
    version: 1,
    config: {
      project: { name, description: '', domain: 'example.com' },
      source_control: { provider: 'github', config: { org: 'acme', repo: name } },
      cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
      environments: ['dev'],
      admin: { email: 'a@b.com', username: 'a' },
    },
    awsAccountId: '123456789012',
    awsRegion: 'eu-west-1',
    completedSteps: [],
    outputs: {},
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'biffo-test-'))
  process.env['BIFFO_SESSIONS_DIR'] = tmpDir
})

afterEach(() => {
  delete process.env['BIFFO_SESSIONS_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('session persistence', () => {
  it('returns null for a non-existent session', () => {
    expect(loadSession('missing')).toBeNull()
  })

  it('saves and loads a session by project name', () => {
    const session = makeSession('my-app')
    saveSession(session)
    const loaded = loadSession('my-app')
    expect(loaded).not.toBeNull()
    expect(loaded?.config.project?.name).toBe('my-app')
    expect(loaded?.awsRegion).toBe('eu-west-1')
  })

  it('markStepComplete adds the step and persists it', () => {
    const session = makeSession('my-app')
    saveSession(session)
    markStepComplete(session, 'verify_credentials')
    const loaded = loadSession('my-app')
    expect(loaded?.completedSteps).toContain('verify_credentials')
  })

  it('markStepComplete is idempotent — does not duplicate steps', () => {
    const session = makeSession('my-app')
    saveSession(session)
    markStepComplete(session, 'create_repo')
    markStepComplete(session, 'create_repo')
    const loaded = loadSession('my-app')
    expect(loaded?.completedSteps.filter((s) => s === 'create_repo')).toHaveLength(1)
  })

  it('deleteSession removes the file', () => {
    const session = makeSession('my-app')
    saveSession(session)
    deleteSession('my-app')
    expect(loadSession('my-app')).toBeNull()
  })

  it('findLatestSession returns null when no sessions exist', () => {
    expect(findLatestSession()).toBeNull()
  })

  it('findLatestSession returns the saved session', () => {
    const session = makeSession('my-app')
    saveSession(session)
    const found = findLatestSession()
    expect(found?.config.project?.name).toBe('my-app')
  })
})
