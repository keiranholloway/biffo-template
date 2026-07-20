import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSession,
  findLatestSession,
  hasCompleted,
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

  it('findLatestSession returns the most recently saved session', async () => {
    saveSession(makeSession('old-app'))
    // Ensure the second session lands on a later mtime than the first.
    await new Promise((resolve) => setTimeout(resolve, 15))
    saveSession(makeSession('new-app'))
    const found = findLatestSession()
    expect(found?.config.project?.name).toBe('new-app')
  })
})

// Issue #316, defect B2. A `biffo init --config` resume built a fresh in-memory
// session and saved it over a five-step session file, leaving four steps on
// disk: `github_config` was un-recorded despite its work being visibly complete
// in the repo (right commit on dev, all three branches, protection configured).
// The next run then re-attempted it against git state that had moved on and
// died with GitRPC::BadObjectState.
//
// These pin the rule that makes that impossible: a save can only ever move
// `completedSteps` forwards.
describe('saveSession is monotonic (issue #316)', () => {
  it('never un-records a step that is already on disk', () => {
    const onDisk = makeSession('my-app')
    onDisk.completedSteps = [
      'verify_credentials',
      'create_repo',
      'oidc_trust',
      'terraform_backend',
      'github_settings',
    ]
    saveSession(onDisk)

    // A second run of the same project that started from scratch in memory —
    // exactly what --config used to do.
    const behind = makeSession('my-app')
    behind.completedSteps = ['verify_credentials', 'create_repo']
    saveSession(behind)

    expect(loadSession('my-app')?.completedSteps).toEqual(
      expect.arrayContaining([
        'verify_credentials',
        'create_repo',
        'oidc_trust',
        'terraform_backend',
        'github_settings',
      ]),
    )
  })

  it('merges the recovered steps back into the in-memory session too', () => {
    const onDisk = makeSession('my-app')
    onDisk.completedSteps = ['verify_credentials', 'oidc_trust']
    saveSession(onDisk)

    const behind = makeSession('my-app')
    behind.completedSteps = ['verify_credentials']
    saveSession(behind)

    // Not just the file: the live object must agree, or this run still redoes
    // the work the file says is done.
    expect(behind.completedSteps).toContain('oidc_trust')
  })

  it('never drops an output recorded on disk', () => {
    const onDisk = makeSession('my-app')
    onDisk.outputs = { cloneUrl: 'https://github.com/acme/my-app.git', oidcRoleArn: 'arn:role' }
    saveSession(onDisk)

    const behind = makeSession('my-app')
    behind.outputs = { tfStateBucket: 'my-app-terraform-state-123456789012' }
    saveSession(behind)

    expect(loadSession('my-app')?.outputs).toEqual({
      cloneUrl: 'https://github.com/acme/my-app.git',
      oidcRoleArn: 'arn:role',
      tfStateBucket: 'my-app-terraform-state-123456789012',
    })
  })

  it('lets a newer value win over an older one for the same output', () => {
    const onDisk = makeSession('my-app')
    onDisk.outputs = { oidcRoleArn: 'arn:old' }
    saveSession(onDisk)

    const next = makeSession('my-app')
    next.outputs = { oidcRoleArn: 'arn:new' }
    saveSession(next)

    expect(loadSession('my-app')?.outputs.oidcRoleArn).toBe('arn:new')
  })

  it('gives --fresh a way out: deleteSession, then save, starts genuinely empty', () => {
    const onDisk = makeSession('my-app')
    onDisk.completedSteps = ['verify_credentials', 'create_repo']
    saveSession(onDisk)

    deleteSession('my-app')
    saveSession(makeSession('my-app'))

    expect(loadSession('my-app')?.completedSteps).toEqual([])
  })

  it('markStepComplete on a stale object still preserves the disk state', () => {
    const onDisk = makeSession('my-app')
    onDisk.completedSteps = ['verify_credentials', 'create_repo', 'oidc_trust']
    saveSession(onDisk)

    const stale = makeSession('my-app')
    markStepComplete(stale, 'terraform_backend')

    expect(loadSession('my-app')?.completedSteps).toEqual(
      expect.arrayContaining([
        'verify_credentials',
        'create_repo',
        'oidc_trust',
        'terraform_backend',
      ]),
    )
  })
})

describe('hasCompleted', () => {
  it('reports a step recorded verbatim', () => {
    const session = makeSession('my-app')
    session.completedSteps = ['github_branches']
    expect(hasCompleted(session, 'github_branches')).toBe(true)
    expect(hasCompleted(session, 'github_settings')).toBe(false)
  })

  // Step 5 was one checkpoint (`github_config`) before #316 split it into three.
  // A session written by an older CLI must not cause a newer one to replay
  // work that is already done — including the git writes that fail loudly when
  // replayed against moved-on state.
  it('treats a legacy github_config checkpoint as all three successors', () => {
    const session = makeSession('my-app')
    session.completedSteps = ['github_config']
    expect(hasCompleted(session, 'github_branches')).toBe(true)
    expect(hasCompleted(session, 'github_instance_files')).toBe(true)
    expect(hasCompleted(session, 'github_settings')).toBe(true)
  })

  it('does not treat a legacy checkpoint as unrelated steps', () => {
    const session = makeSession('my-app')
    session.completedSteps = ['github_config']
    expect(hasCompleted(session, 'app_sibling')).toBe(false)
  })
})
