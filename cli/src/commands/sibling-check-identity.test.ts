import { describe, expect, it, vi } from 'vitest'
import {
  runCheckIdentity,
  type CheckIdentityDeps,
  type CheckIdentityParams,
} from './sibling-check-identity.js'

const LIVE = 'eu-west-1_LIVEPOOL'
const CORE_ORG = 'acme'
const CORE_REPO = 'my-core'
const CORE_PROJECT = 'my-core'
const STATE_BUCKET = 'my-core-terraform-state-123456789012'

const REGISTRY = JSON.stringify({
  sibling_origins: [
    { name: 'crm', bucket_regional_domain: 'crm-dev-site-123456789012.s3.eu-west-1.amazonaws.com' },
  ],
})
const MARKER = JSON.stringify({ name: 'crm', core_project: CORE_PROJECT, path_prefix: 'crm' })

/**
 * A fake GitHub surface: one registered sibling `crm` provisioning `dev`, whose
 * repo carries a matching marker. `getEnvVariable` is a spy so callers can set
 * its return and assert whether it was consulted.
 */
function fakeGithub(opts: {
  envVar?: string | null
  siblingRepoExists?: boolean
}): CheckIdentityDeps['github'] {
  const siblingRepoExists = opts.siblingRepoExists ?? true
  return {
    async getFileContent(_org: string, repo: string, path: string) {
      if (repo === CORE_REPO && path === 'infra/environments/dev/siblings.auto.tfvars.json') {
        return REGISTRY
      }
      if (repo === 'crm' && path === 'biffo.sibling.json') return MARKER
      return undefined
    },
    async repoExists(_org: string, repo: string) {
      return repo === 'crm' && siblingRepoExists
    },
    async listOpenPullRequests() {
      return []
    },
    getEnvVariable: vi.fn(async () => opts.envVar ?? null),
  }
}

function fakeAws(deployedEnvs: Record<string, { pool?: string; portal?: string }>): {
  aws: CheckIdentityDeps['aws']
} {
  return {
    aws: {
      async readTerraformOutputs(_bucket: string, key: string) {
        const env = key.split('/')[0]!
        const state = deployedEnvs[env]
        if (!state) throw new Error(`NoSuchKey: ${key}`)
        const out: Record<string, string> = {}
        if (state.pool) out['cognito_user_pool_id'] = state.pool
        if (state.portal) out['portal_url'] = state.portal
        return out
      },
    },
  }
}

function params(environments: string[]): CheckIdentityParams {
  return {
    coreOrg: CORE_ORG,
    coreRepo: CORE_REPO,
    coreProjectName: CORE_PROJECT,
    stateBucket: STATE_BUCKET,
    environments,
  }
}

describe('runCheckIdentity', () => {
  it('returns ok with no findings when the document and sibling match the live pool', async () => {
    const deps: CheckIdentityDeps = {
      ...fakeAws({ dev: { pool: LIVE, portal: 'https://dev.example.com' } }),
      github: fakeGithub({ envVar: LIVE }),
      fetchIdentityDoc: async () => ({ userPoolId: LIVE }),
    }

    const result = await runCheckIdentity(deps, params(['dev']))

    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('returns not-ok with a sibling-backend-stale finding when the baked-in var drifted', async () => {
    const deps: CheckIdentityDeps = {
      ...fakeAws({ dev: { pool: LIVE, portal: 'https://dev.example.com' } }),
      github: fakeGithub({ envVar: 'eu-west-1_OLDPOOL' }),
      fetchIdentityDoc: async () => ({ userPoolId: LIVE }),
    }

    const result = await runCheckIdentity(deps, params(['dev']))

    expect(result.ok).toBe(false)
    expect(result.findings).toEqual([
      {
        environment: 'dev',
        subject: 'crm',
        kind: 'sibling-backend-stale',
        expected: LIVE,
        actual: 'eu-west-1_OLDPOOL',
      },
    ])
  })

  it('skips an environment the core is not deployed to, rather than failing it', async () => {
    const deps: CheckIdentityDeps = {
      ...fakeAws({ dev: { pool: LIVE, portal: 'https://dev.example.com' } }),
      github: fakeGithub({ envVar: LIVE }),
      fetchIdentityDoc: async () => ({ userPoolId: LIVE }),
    }

    // staging has no state → skipped; dev is fine.
    const result = await runCheckIdentity(deps, params(['dev', 'staging']))

    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.skipped).toEqual([
      {
        environment: 'staging',
        reason: 'no Terraform state (core not deployed to this environment)',
      },
    ])
  })

  it('skips an environment whose outputs lack the pool id / portal url', async () => {
    const deps: CheckIdentityDeps = {
      ...fakeAws({ dev: { portal: 'https://dev.example.com' } }), // no cognito_user_pool_id
      github: fakeGithub({ envVar: LIVE }),
      fetchIdentityDoc: async () => ({ userPoolId: LIVE }),
    }

    const result = await runCheckIdentity(deps, params(['dev']))

    expect(result.ok).toBe(true)
    expect(result.skipped[0]?.environment).toBe('dev')
  })

  it('does not consult a sibling whose repo was deleted (repoState gone)', async () => {
    const github = fakeGithub({ envVar: 'eu-west-1_OLDPOOL', siblingRepoExists: false })
    const deps: CheckIdentityDeps = {
      ...fakeAws({ dev: { pool: LIVE, portal: 'https://dev.example.com' } }),
      github,
      fetchIdentityDoc: async () => ({ userPoolId: LIVE }),
    }

    const result = await runCheckIdentity(deps, params(['dev']))

    // The gone sibling contributes nothing — no finding despite a stale var value.
    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(github.getEnvVariable).not.toHaveBeenCalled()
  })

  it('flags an unreachable published document while sibling stays consistent', async () => {
    const deps: CheckIdentityDeps = {
      ...fakeAws({ dev: { pool: LIVE, portal: 'https://dev.example.com' } }),
      github: fakeGithub({ envVar: LIVE }),
      fetchIdentityDoc: async () => null,
    }

    const result = await runCheckIdentity(deps, params(['dev']))

    expect(result.ok).toBe(false)
    expect(result.findings).toEqual([
      {
        environment: 'dev',
        subject: 'published-document',
        kind: 'published-doc-unreachable',
        expected: LIVE,
        actual: null,
      },
    ])
  })
})
