import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSiblingSession,
  loadSiblingSession,
  markSiblingStepComplete,
  saveSiblingSession,
  type SiblingSession,
} from './sibling-session.js'
import { makeTmpDir } from '../test-utils/tmp.js'

function makeSession(name: string): SiblingSession {
  return {
    version: 1,
    config: {
      project: { name, description: '', routes: [] },
      source_control: { provider: 'github', config: { org: 'acme', repo: name } },
      cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
      environments: ['dev'],
      core: { project_name: 'core-app', path_prefix: name },
    } as SiblingSession['config'],
    awsAccountId: '123456789012',
    awsRegion: 'eu-west-1',
    completedSteps: [],
    outputs: {},
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = makeTmpDir('biffo-sibling-session')
  process.env['BIFFO_SIBLING_SESSIONS_DIR'] = tmpDir
})

afterEach(() => {
  delete process.env['BIFFO_SIBLING_SESSIONS_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('sibling session persistence', () => {
  it('round-trips a saved session', () => {
    const session = makeSession('reports')
    session.completedSteps = ['verify_credentials']
    saveSiblingSession(session)
    expect(loadSiblingSession('reports')?.completedSteps).toEqual(['verify_credentials'])
  })

  it('returns null for a sibling with no saved session', () => {
    expect(loadSiblingSession('missing')).toBeNull()
  })
})

// The sibling half of issue #316's monotonicity rule. `biffo init` drives
// `runSiblingCreate` for the root app sibling, so the same regression — a run
// whose in-memory session is behind disk overwriting the disk copy — is
// reachable here too. Fixing only lib/session.ts would repeat exactly the
// one-instance-fixed-pattern-missed mistake that caused #315.
describe('saveSiblingSession is monotonic (issue #316)', () => {
  it('never un-records a step that is already on disk', () => {
    const onDisk = makeSession('reports')
    onDisk.completedSteps = ['verify_credentials', 'create_repo', 'push_skeleton', 'oidc_trust']
    saveSiblingSession(onDisk)

    const behind = makeSession('reports')
    behind.completedSteps = ['verify_credentials']
    saveSiblingSession(behind)

    expect(loadSiblingSession('reports')?.completedSteps).toEqual(
      expect.arrayContaining(['verify_credentials', 'create_repo', 'push_skeleton', 'oidc_trust']),
    )
    // …and the live object agrees, so this run does not redo the work either.
    expect(behind.completedSteps).toContain('push_skeleton')
  })

  it('never drops an output recorded on disk', () => {
    const onDisk = makeSession('reports')
    onDisk.outputs = { cloneUrl: 'https://github.com/acme/reports.git' }
    saveSiblingSession(onDisk)

    const behind = makeSession('reports')
    behind.outputs = { tfStateBucket: 'reports-terraform-state-123456789012' }
    saveSiblingSession(behind)

    expect(loadSiblingSession('reports')?.outputs).toEqual({
      cloneUrl: 'https://github.com/acme/reports.git',
      tfStateBucket: 'reports-terraform-state-123456789012',
    })
  })

  it('markSiblingStepComplete on a stale object preserves the disk state', () => {
    const onDisk = makeSession('reports')
    onDisk.completedSteps = ['verify_credentials', 'resolve_core_identity', 'create_repo']
    saveSiblingSession(onDisk)

    const stale = makeSession('reports')
    markSiblingStepComplete(stale, 'push_skeleton')

    expect(loadSiblingSession('reports')?.completedSteps).toEqual(
      expect.arrayContaining([
        'verify_credentials',
        'resolve_core_identity',
        'create_repo',
        'push_skeleton',
      ]),
    )
  })

  it('gives --fresh a way out: delete, then save, starts genuinely empty', () => {
    const onDisk = makeSession('reports')
    onDisk.completedSteps = ['verify_credentials', 'create_repo']
    saveSiblingSession(onDisk)

    deleteSiblingSession('reports')
    saveSiblingSession(makeSession('reports'))

    expect(loadSiblingSession('reports')?.completedSteps).toEqual([])
  })
})
