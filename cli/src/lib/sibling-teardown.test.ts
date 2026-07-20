import { describe, expect, it, vi } from 'vitest'
import {
  collectSiblings,
  markerMatches,
  parseRegistry,
  parseSiblingBucketDomain,
  registryPath,
  resolveSiblingRepos,
  SiblingResolutionError,
  type DiscoveredSibling,
  type SiblingRepoLookup,
} from './sibling-teardown.js'

const ACCOUNT = '123456789012'

function domainFor(project: string, env = 'dev', region = 'eu-west-1'): string {
  const bucket = `${project}-${env}-site-${ACCOUNT}`
  return region === 'us-east-1'
    ? `${bucket}.s3.amazonaws.com`
    : `${bucket}.s3.${region}.amazonaws.com`
}

// ─── parseSiblingBucketDomain ────────────────────────────────────────────────

describe('parseSiblingBucketDomain', () => {
  it('recovers project, environment and account from a regional domain', () => {
    expect(parseSiblingBucketDomain(domainFor('reports'))).toEqual({
      projectName: 'reports',
      environment: 'dev',
      accountId: ACCOUNT,
    })
  })

  it('handles the us-east-1 legacy global endpoint form', () => {
    expect(parseSiblingBucketDomain(domainFor('reports', 'prod', 'us-east-1'))).toEqual({
      projectName: 'reports',
      environment: 'prod',
      accountId: ACCOUNT,
    })
  })

  it('keeps dashes that belong to the project name', () => {
    expect(parseSiblingBucketDomain(domainFor('tabsii-crm-app', 'staging'))?.projectName).toBe(
      'tabsii-crm-app',
    )
  })

  it('returns null for anything it cannot decode, rather than guessing', () => {
    expect(parseSiblingBucketDomain('not-a-bucket')).toBeNull()
    expect(parseSiblingBucketDomain('reports.s3.eu-west-1.amazonaws.com')).toBeNull()
    expect(parseSiblingBucketDomain('reports-dev-site-123.s3.amazonaws.com')).toBeNull()
    expect(parseSiblingBucketDomain(`reports-qa-site-${ACCOUNT}.s3.amazonaws.com`)).toBeNull()
  })
})

// ─── parseRegistry ───────────────────────────────────────────────────────────

describe('parseRegistry', () => {
  it('treats an absent or empty registry as no siblings', () => {
    expect(parseRegistry(undefined)).toEqual([])
    expect(parseRegistry('')).toEqual([])
    expect(parseRegistry('{}')).toEqual([])
    expect(parseRegistry('{"sibling_origins": []}')).toEqual([])
  })

  it('returns the registered entries', () => {
    const entries = parseRegistry(
      JSON.stringify({
        sibling_origins: [{ name: 'reports', bucket_regional_domain: domainFor('reports') }],
      }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('reports')
  })

  it('refuses to proceed on an unreadable registry', () => {
    expect(() => parseRegistry('{ not json')).toThrow(SiblingResolutionError)
    expect(() => parseRegistry('{"sibling_origins": "reports"}')).toThrow(SiblingResolutionError)
  })
})

// ─── collectSiblings ─────────────────────────────────────────────────────────

describe('collectSiblings', () => {
  it('reports no siblings when every registry is empty', () => {
    expect(collectSiblings([{ environment: 'dev', entries: [] }])).toEqual([])
  })

  it('folds one sibling registered across several environments into one entry', () => {
    const siblings = collectSiblings([
      {
        environment: 'dev',
        entries: [{ name: 'reports', bucket_regional_domain: domainFor('reports', 'dev') }],
      },
      {
        environment: 'prod',
        entries: [{ name: 'reports', bucket_regional_domain: domainFor('reports', 'prod') }],
      },
    ])

    expect(siblings).toHaveLength(1)
    expect(siblings[0]).toMatchObject({
      pathPrefix: 'reports',
      projectName: 'reports',
      accountId: ACCOUNT,
      registered: true,
    })
    expect(siblings[0]?.environments).toEqual(['dev', 'prod'])
  })

  it('collects several siblings, sorted by path prefix', () => {
    const siblings = collectSiblings([
      {
        environment: 'dev',
        entries: [
          { name: 'reports', bucket_regional_domain: domainFor('reports') },
          { name: 'crm', bucket_regional_domain: domainFor('tabsii-crm') },
          { name: 'billing', bucket_regional_domain: domainFor('billing') },
        ],
      },
    ])

    expect(siblings.map((s) => s.pathPrefix)).toEqual(['billing', 'crm', 'reports'])
    // path prefix and project name are allowed to differ — the project name is
    // what names the IAM role and state bucket, so it must come from the bucket.
    expect(siblings.find((s) => s.pathPrefix === 'crm')?.projectName).toBe('tabsii-crm')
  })

  it('marks a sibling seen only in an open registration PR as unregistered', () => {
    const siblings = collectSiblings([
      { environment: 'dev', entries: [] },
      {
        environment: 'dev',
        entries: [{ name: 'reports', bucket_regional_domain: domainFor('reports') }],
        pendingRegistrationPr: 42,
      },
    ])

    expect(siblings[0]).toMatchObject({ registered: false, pendingRegistrationPr: 42 })
  })

  it('lets a merged entry win over the same sibling seen in an open PR', () => {
    const siblings = collectSiblings([
      {
        environment: 'dev',
        entries: [{ name: 'reports', bucket_regional_domain: domainFor('reports') }],
        pendingRegistrationPr: 42,
      },
      {
        environment: 'dev',
        entries: [{ name: 'reports', bucket_regional_domain: domainFor('reports') }],
      },
    ])

    expect(siblings[0]?.registered).toBe(true)
    expect(siblings[0]?.pendingRegistrationPr).toBeUndefined()
  })

  it('fails rather than skipping an entry whose bucket cannot be decoded', () => {
    expect(() =>
      collectSiblings([
        {
          environment: 'dev',
          entries: [{ name: 'reports', bucket_regional_domain: 'https://example.com' }],
        },
      ]),
    ).toThrow(/Refusing to guess/)
  })

  it('fails on an entry missing its bucket', () => {
    expect(() =>
      collectSiblings([{ environment: 'dev', entries: [{ name: 'reports' } as never] }]),
    ).toThrow(SiblingResolutionError)
  })

  it('fails when one path prefix maps to two different projects', () => {
    expect(() =>
      collectSiblings([
        {
          environment: 'dev',
          entries: [{ name: 'reports', bucket_regional_domain: domainFor('reports', 'dev') }],
        },
        {
          environment: 'prod',
          entries: [{ name: 'reports', bucket_regional_domain: domainFor('other', 'prod') }],
        },
      ]),
    ).toThrow(/two different projects/)
  })
})

// ─── markerMatches ───────────────────────────────────────────────────────────

describe('markerMatches', () => {
  const sibling: DiscoveredSibling = {
    pathPrefix: 'crm',
    projectName: 'tabsii-crm',
    environments: ['dev'],
    accountId: ACCOUNT,
    registered: true,
  }

  it('accepts a marker naming this core and this path prefix', () => {
    expect(
      markerMatches(
        { name: 'tabsii-crm', core_project: 'core-app', path_prefix: 'crm' },
        'core-app',
        sibling,
      ),
    ).toBe(true)
  })

  it('rejects a marker naming a different core project', () => {
    expect(
      markerMatches(
        { name: 'tabsii-crm', core_project: 'someone-elses-app', path_prefix: 'crm' },
        'core-app',
        sibling,
      ),
    ).toBe(false)
  })

  it('rejects a missing marker', () => {
    expect(markerMatches(null, 'core-app', sibling)).toBe(false)
  })
})

// ─── resolveSiblingRepos ─────────────────────────────────────────────────────

function lookup(
  repos: Record<string, { marker?: unknown }>,
): SiblingRepoLookup & { getFileContent: ReturnType<typeof vi.fn> } {
  const getFileContent = vi.fn(async (_org: string, repo: string) => {
    const entry = repos[repo]
    if (!entry || entry.marker === undefined) return undefined
    return JSON.stringify(entry.marker)
  })
  return {
    repoExists: vi.fn(async (_org: string, repo: string) => repo in repos),
    getFileContent,
  }
}

const REPORTS: DiscoveredSibling = {
  pathPrefix: 'reports',
  projectName: 'reports',
  environments: ['dev'],
  accountId: ACCOUNT,
  registered: true,
}

describe('resolveSiblingRepos', () => {
  it('resolves a sibling whose repo carries a matching marker', async () => {
    const github = lookup({
      reports: { marker: { name: 'reports', core_project: 'core-app', path_prefix: 'reports' } },
    })

    const resolved = await resolveSiblingRepos(github, 'acme', 'core-app', [REPORTS])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ org: 'acme', repo: 'reports', repoState: 'present' })
  })

  it('records a registered sibling whose repo is already gone, without failing', async () => {
    const github = lookup({})

    const resolved = await resolveSiblingRepos(github, 'acme', 'core-app', [REPORTS])

    expect(resolved[0]).toMatchObject({ repo: 'reports', repoState: 'gone' })
    expect(github.getFileContent).not.toHaveBeenCalled()
  })

  it('refuses to delete a same-named repo that is not this sibling', async () => {
    const github = lookup({ reports: { marker: undefined } })

    await expect(resolveSiblingRepos(github, 'acme', 'core-app', [REPORTS])).rejects.toThrow(
      /does not carry a matching biffo\.sibling\.json/,
    )
  })

  it("refuses when the marker names someone else's core project", async () => {
    const github = lookup({
      reports: {
        marker: { name: 'reports', core_project: 'other-core', path_prefix: 'reports' },
      },
    })

    await expect(resolveSiblingRepos(github, 'acme', 'core-app', [REPORTS])).rejects.toThrow(
      SiblingResolutionError,
    )
  })

  it('refuses when the marker is unparseable rather than assuming a match', async () => {
    const github: SiblingRepoLookup = {
      repoExists: vi.fn().mockResolvedValue(true),
      getFileContent: vi.fn().mockResolvedValue('{ not json'),
    }

    await expect(resolveSiblingRepos(github, 'acme', 'core-app', [REPORTS])).rejects.toThrow(
      SiblingResolutionError,
    )
  })

  it('resolves an empty list to an empty list', async () => {
    await expect(resolveSiblingRepos(lookup({}), 'acme', 'core-app', [])).resolves.toEqual([])
  })
})

// ─── registryPath ────────────────────────────────────────────────────────────

describe('registryPath', () => {
  it('points at the file the registration PR writes and the CDN reads', () => {
    expect(registryPath('dev')).toBe('infra/environments/dev/siblings.auto.tfvars.json')
  })
})
