import { describe, expect, it, vi } from 'vitest'
import type { CoreIdentity } from './sibling-session.js'
import {
  cloudfrontDistributionArn,
  coreWiringFromOutputs,
  formatWiringResult,
  wireSiblingsAfterCoreDeploy,
  type CoreWiring,
  type SiblingWiringGithub,
} from './sibling-wiring.js'

const ACCOUNT = '123456789012'
const CORE_ORG = 'acme'
const CORE_REPO = 'core-app'
const CORE_PROJECT = 'core-app'
const DIST_ID = 'E123ABCDEF456'

const CORE_OUTPUTS: Record<string, string> = {
  cognito_user_pool_id: 'eu-west-1_pool',
  cognito_client_id: 'client123',
  api_gateway_url: 'https://api.example.com',
  portal_url: 'https://dev.example.com',
  cloudfront_distribution_id: DIST_ID,
}

const IDENTITY: CoreIdentity = {
  cognitoUserPoolId: 'eu-west-1_pool',
  cognitoClientId: 'client123',
  apiUrl: 'https://api.example.com',
  portalUrl: 'https://dev.example.com',
}

const WIRING: CoreWiring = {
  identity: IDENTITY,
  cdn: {
    distributionId: DIST_ID,
    distributionArn: `arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}`,
  },
}

// ─── cloudfrontDistributionArn ────────────────────────────────────────────────

describe('cloudfrontDistributionArn', () => {
  it('builds the partitionless, regionless CloudFront ARN', () => {
    expect(cloudfrontDistributionArn(ACCOUNT, DIST_ID)).toBe(
      `arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}`,
    )
  })
})

// ─── coreWiringFromOutputs ────────────────────────────────────────────────────

describe('coreWiringFromOutputs', () => {
  it('maps a full set of core outputs into identity + cdn wiring', () => {
    expect(coreWiringFromOutputs(CORE_OUTPUTS, ACCOUNT, 'dev')).toEqual(WIRING)
  })

  it.each([
    'cognito_user_pool_id',
    'cognito_client_id',
    'api_gateway_url',
    'portal_url',
    'cloudfront_distribution_id',
  ])('fails loudly when %s is missing', (key) => {
    const partial = { ...CORE_OUTPUTS }
    delete partial[key]
    expect(() => coreWiringFromOutputs(partial, ACCOUNT, 'dev')).toThrow(key)
  })

  it('treats a whitespace-only output as missing (no silent empty wiring)', () => {
    expect(() =>
      coreWiringFromOutputs({ ...CORE_OUTPUTS, api_gateway_url: '   ' }, ACCOUNT, 'dev'),
    ).toThrow('api_gateway_url')
  })
})

// ─── wireSiblingsAfterCoreDeploy ──────────────────────────────────────────────

interface Recorded {
  envVars: Array<{ org: string; repo: string; env: string; name: string; value: string }>
  secrets: Array<{ org: string; repo: string; name: string; value: string }>
}

function fakeGithub(opts: {
  files?: Record<string, string>
  repos?: string[]
  openPrs?: Array<{ number: number; headRef: string }>
}): { github: SiblingWiringGithub; recorded: Recorded } {
  const files = opts.files ?? {}
  const repos = new Set(opts.repos ?? [])
  const recorded: Recorded = { envVars: [], secrets: [] }
  const github: SiblingWiringGithub = {
    repoExists: vi.fn(async (org: string, repo: string) => repos.has(`${org}/${repo}`)),
    getFileContent: vi.fn(async (org: string, repo: string, path: string, ref?: string) => {
      const key = ref ? `${org}/${repo}@${ref}:${path}` : `${org}/${repo}:${path}`
      return files[key]
    }),
    listOpenPullRequests: vi.fn(async () => opts.openPrs ?? []),
    setEnvVariable: vi.fn(async (org, repo, env, name, value) => {
      recorded.envVars.push({ org, repo, env, name, value })
    }),
    setRepoSecret: vi.fn(async (org, repo, name, value) => {
      recorded.secrets.push({ org, repo, name, value })
    }),
  }
  return { github, recorded }
}

function domainFor(project: string, env = 'dev'): string {
  return `${project}-${env}-site-${ACCOUNT}.s3.eu-west-1.amazonaws.com`
}

function registry(...entries: Array<[string, string, string?]>): string {
  return JSON.stringify({
    sibling_origins: entries.map(([name, project, env]) => ({
      name,
      bucket_regional_domain: domainFor(project, env ?? 'dev'),
    })),
  })
}

function marker(project: string, pathPrefix: string): string {
  return JSON.stringify({ name: project, core_project: CORE_PROJECT, path_prefix: pathPrefix })
}

const TOKEN = 'ghp_faketoken'

describe('wireSiblingsAfterCoreDeploy', () => {
  it('is a no-op when the core has no siblings', async () => {
    const { github, recorded } = fakeGithub({ repos: [`${CORE_ORG}/${CORE_REPO}`] })

    const result = await wireSiblingsAfterCoreDeploy(
      github,
      CORE_ORG,
      CORE_REPO,
      CORE_PROJECT,
      'dev',
      WIRING,
      TOKEN,
    )

    expect(result).toEqual({ wired: [], gone: [], skippedEnv: [] })
    expect(recorded.envVars).toEqual([])
    expect(recorded.secrets).toEqual([])
  })

  it('sets all six values (env vars + token secret) on a registered sibling', async () => {
    const { github, recorded } = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/${CORE_PROJECT}-app`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/dev/siblings.auto.tfvars.json`]: registry([
          'app',
          `${CORE_PROJECT}-app`,
        ]),
        [`${CORE_ORG}/${CORE_PROJECT}-app:biffo.sibling.json`]: marker(`${CORE_PROJECT}-app`, ''),
      },
    })

    const result = await wireSiblingsAfterCoreDeploy(
      github,
      CORE_ORG,
      CORE_REPO,
      CORE_PROJECT,
      'dev',
      WIRING,
      TOKEN,
    )

    expect(result.wired).toEqual([`${CORE_ORG}/${CORE_PROJECT}-app`])

    const names = recorded.envVars.filter((v) => v.env === 'dev').map((v) => v.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'CORE_COGNITO_USER_POOL_ID',
        'CORE_COGNITO_CLIENT_ID',
        'CORE_API_URL',
        'CORE_PORTAL_URL',
        'CORS_ORIGINS_JSON',
        'PARENT_CLOUDFRONT_DISTRIBUTION_ARN',
        'PARENT_CLOUDFRONT_DISTRIBUTION_ID',
      ]),
    )

    const arn = recorded.envVars.find((v) => v.name === 'PARENT_CLOUDFRONT_DISTRIBUTION_ARN')
    expect(arn?.value).toBe(`arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}`)

    expect(recorded.secrets).toEqual([
      {
        org: CORE_ORG,
        repo: `${CORE_PROJECT}-app`,
        name: 'SIBLING_GITHUB_TOKEN',
        value: TOKEN,
      },
    ])
  })

  it('sets the token but skips env vars for a sibling not registered in the deployed env', async () => {
    // Registered only for staging; we are deploying dev.
    const { github, recorded } = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/reports`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/staging/siblings.auto.tfvars.json`]: registry(
          ['reports', 'reports', 'staging'],
        ),
        [`${CORE_ORG}/reports:biffo.sibling.json`]: marker('reports', 'reports'),
      },
    })

    const result = await wireSiblingsAfterCoreDeploy(
      github,
      CORE_ORG,
      CORE_REPO,
      CORE_PROJECT,
      'dev',
      WIRING,
      TOKEN,
    )

    expect(result.skippedEnv).toEqual([`${CORE_ORG}/reports`])
    expect(result.wired).toEqual([])
    expect(recorded.envVars).toEqual([])
    expect(recorded.secrets.map((s) => s.repo)).toEqual(['reports'])
  })

  it('records a registered sibling whose repo is gone, and neither wires nor tokens it', async () => {
    const { github, recorded } = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`], // reports repo deleted
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/dev/siblings.auto.tfvars.json`]: registry([
          'reports',
          'reports',
        ]),
      },
    })

    const result = await wireSiblingsAfterCoreDeploy(
      github,
      CORE_ORG,
      CORE_REPO,
      CORE_PROJECT,
      'dev',
      WIRING,
      TOKEN,
    )

    expect(result.gone).toEqual([`${CORE_ORG}/reports`])
    expect(recorded.envVars).toEqual([])
    expect(recorded.secrets).toEqual([])
  })

  it('propagates a resolution failure rather than silently leaving a sibling unwired', async () => {
    // Repo exists but carries no matching marker — resolveSiblingRepos throws.
    const { github } = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/reports`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/dev/siblings.auto.tfvars.json`]: registry([
          'reports',
          'reports',
        ]),
        // no biffo.sibling.json on reports
      },
    })

    await expect(
      wireSiblingsAfterCoreDeploy(github, CORE_ORG, CORE_REPO, CORE_PROJECT, 'dev', WIRING, TOKEN),
    ).rejects.toThrow(/does not carry a matching biffo\.sibling\.json/)
  })
})

// ─── formatWiringResult ───────────────────────────────────────────────────────

describe('formatWiringResult', () => {
  it('summarises wired, env-skipped, and gone siblings', () => {
    const lines = formatWiringResult('dev', {
      wired: ['acme/core-app-app'],
      skippedEnv: ['acme/reports'],
      gone: ['acme/old'],
    })
    expect(lines.join('\n')).toContain('Wired sibling acme/core-app-app')
    expect(lines.join('\n')).toContain('not registered for dev')
    expect(lines.join('\n')).toContain('repo not found')
  })

  it('returns nothing when there was nothing to do', () => {
    expect(formatWiringResult('dev', { wired: [], skippedEnv: [], gone: [] })).toEqual([])
  })
})
