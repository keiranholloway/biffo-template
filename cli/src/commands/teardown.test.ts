import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NON_INTERACTIVE_FLAG, NonInteractiveError } from '../lib/interactive.js'
import {
  discoverSiblings,
  SiblingResolutionError,
  type ResolvedSibling,
  type SiblingDiscoveryGithub,
} from '../lib/sibling-teardown.js'
import { assertSiblingsAreDestroyable, confirmTeardown, formatSiblingPlan } from './teardown.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

const PROJECT = 'my-project'

describe('confirmTeardown', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    promptMock.mockReset()
    process.argv = ['node', 'biffo', 'teardown']
  })

  afterEach(() => {
    process.argv = originalArgv
    delete process.env['BIFFO_NON_INTERACTIVE']
  })

  // ─── Default safety: unchanged ─────────────────────────────────────────────

  it('still demands the typed project name for a bare teardown', async () => {
    promptMock.mockResolvedValue({ confirm: PROJECT })

    await expect(confirmTeardown(PROJECT, {})).resolves.toBe(true)
    expect(promptMock).toHaveBeenCalledOnce()
  })

  it('aborts when the typed name does not match', async () => {
    promptMock.mockResolvedValue({ confirm: 'not-my-project' })

    await expect(confirmTeardown(PROJECT, {})).resolves.toBe(false)
  })

  it('aborts on an empty typed name', async () => {
    promptMock.mockResolvedValue({ confirm: '' })

    await expect(confirmTeardown(PROJECT, {})).resolves.toBe(false)
  })

  // ─── --confirm <name>: scriptable, but keeps the friction ──────────────────

  it('confirms without prompting when --confirm matches the project', async () => {
    await expect(confirmTeardown(PROJECT, { confirm: PROJECT })).resolves.toBe(true)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('refuses when --confirm names a different project', async () => {
    await expect(confirmTeardown(PROJECT, { confirm: 'some-other-project' })).resolves.toBe(false)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('refuses a near-miss --confirm value rather than falling back to a prompt', async () => {
    await expect(confirmTeardown(PROJECT, { confirm: 'My-Project' })).resolves.toBe(false)
    await expect(confirmTeardown(PROJECT, { confirm: ` ${PROJECT} ` })).resolves.toBe(false)
    expect(promptMock).not.toHaveBeenCalled()
  })

  // ─── --yes: explicit opt-out ───────────────────────────────────────────────

  it('skips the confirmation entirely with --yes', async () => {
    await expect(confirmTeardown(PROJECT, { yes: true })).resolves.toBe(true)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('lets --confirm win over --yes, so a mismatch still aborts', async () => {
    await expect(confirmTeardown(PROJECT, { confirm: 'wrong', yes: true })).resolves.toBe(false)
  })

  // ─── --non-interactive: error, never hang ──────────────────────────────────

  it('throws rather than prompting when non-interactive with no pre-confirmation', async () => {
    process.argv = ['node', 'biffo', 'teardown', NON_INTERACTIVE_FLAG]

    await expect(confirmTeardown(PROJECT, {})).rejects.toThrow(NonInteractiveError)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('names both escape hatches in the error', async () => {
    process.argv = ['node', 'biffo', 'teardown', NON_INTERACTIVE_FLAG]

    await expect(confirmTeardown(PROJECT, {})).rejects.toThrow(
      new RegExp(`--confirm ${PROJECT}[\\s\\S]*--yes`),
    )
  })

  it('accepts --confirm while non-interactive', async () => {
    process.argv = ['node', 'biffo', 'teardown', NON_INTERACTIVE_FLAG]

    await expect(confirmTeardown(PROJECT, { confirm: PROJECT })).resolves.toBe(true)
  })

  it('still refuses a mismatched --confirm while non-interactive', async () => {
    process.argv = ['node', 'biffo', 'teardown', NON_INTERACTIVE_FLAG]

    await expect(confirmTeardown(PROJECT, { confirm: 'wrong' })).resolves.toBe(false)
  })
})

// ─── Sibling discovery (issue #306) ──────────────────────────────────────────

const ACCOUNT = '123456789012'
const CORE_ORG = 'acme'
const CORE_REPO = 'core-app'
const CORE_PROJECT = 'core-app'

function domainFor(project: string, env = 'dev'): string {
  return `${project}-${env}-site-${ACCOUNT}.s3.eu-west-1.amazonaws.com`
}

function registry(...names: Array<[string, string]>): string {
  return JSON.stringify({
    sibling_origins: names.map(([name, project]) => ({
      name,
      bucket_regional_domain: domainFor(project),
    })),
  })
}

function marker(project: string, pathPrefix: string, core = CORE_PROJECT): string {
  return JSON.stringify({ name: project, core_project: core, path_prefix: pathPrefix })
}

const DESTROY_WORKFLOW = '.github/workflows/destroy-infra.yml'

/**
 * A fake GitHub with a file table keyed `<org>/<repo>@<ref>:<path>` (ref
 * omitted means the default branch), plus the set of repos that exist.
 */
function fakeGithub(opts: {
  files?: Record<string, string>
  repos?: string[]
  openPrs?: Array<{ number: number; headRef: string }>
}): SiblingDiscoveryGithub {
  const files = opts.files ?? {}
  const repos = new Set(opts.repos ?? [])
  return {
    repoExists: vi.fn(async (org: string, repo: string) => repos.has(`${org}/${repo}`)),
    getFileContent: vi.fn(async (org: string, repo: string, path: string, ref?: string) => {
      const key = ref ? `${org}/${repo}@${ref}:${path}` : `${org}/${repo}:${path}`
      return files[key]
    }),
    listOpenPullRequests: vi.fn(async () => opts.openPrs ?? []),
  }
}

describe('discoverSiblings', () => {
  it('finds nothing when the core project has no siblings — unchanged behaviour', async () => {
    const github = fakeGithub({ repos: [`${CORE_ORG}/${CORE_REPO}`] })

    await expect(discoverSiblings(github, CORE_ORG, CORE_REPO, CORE_PROJECT)).resolves.toEqual([])
  })

  it('finds a single registered sibling and confirms its repo', async () => {
    const github = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/reports`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/dev/siblings.auto.tfvars.json`]: registry([
          'reports',
          'reports',
        ]),
        [`${CORE_ORG}/reports:biffo.sibling.json`]: marker('reports', 'reports'),
      },
    })

    const siblings = await discoverSiblings(github, CORE_ORG, CORE_REPO, CORE_PROJECT)

    expect(siblings).toHaveLength(1)
    expect(siblings[0]).toMatchObject({
      org: CORE_ORG,
      repo: 'reports',
      pathPrefix: 'reports',
      repoState: 'present',
      registered: true,
    })
  })

  it('finds several siblings, including one whose path prefix differs from its name', async () => {
    const github = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/reports`, `${CORE_ORG}/tabsii-crm`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/dev/siblings.auto.tfvars.json`]: registry(
          ['reports', 'reports'],
          ['crm', 'tabsii-crm'],
        ),
        [`${CORE_ORG}/reports:biffo.sibling.json`]: marker('reports', 'reports'),
        [`${CORE_ORG}/tabsii-crm:biffo.sibling.json`]: marker('tabsii-crm', 'crm'),
      },
    })

    const siblings = await discoverSiblings(github, CORE_ORG, CORE_REPO, CORE_PROJECT)

    expect(siblings.map((s) => s.repo)).toEqual(['tabsii-crm', 'reports'])
    expect(siblings.every((s) => s.repoState === 'present')).toBe(true)
  })

  it('reports a registered sibling whose repo is already gone, without failing', async () => {
    const github = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/prod/siblings.auto.tfvars.json`]: registry([
          'reports',
          'reports',
        ]),
      },
    })

    const siblings = await discoverSiblings(github, CORE_ORG, CORE_REPO, CORE_PROJECT)

    expect(siblings).toHaveLength(1)
    expect(siblings[0]).toMatchObject({ repo: 'reports', repoState: 'gone' })
  })

  it('finds a sibling created but never registered, via its open registration PR', async () => {
    const headRef = 'biffo/register-sibling-reports'
    const github = fakeGithub({
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/reports`],
      openPrs: [
        { number: 7, headRef },
        { number: 8, headRef: 'feat/something-unrelated' },
      ],
      files: {
        [`${CORE_ORG}/${CORE_REPO}@${headRef}:infra/environments/dev/siblings.auto.tfvars.json`]:
          registry(['reports', 'reports']),
        [`${CORE_ORG}/reports:biffo.sibling.json`]: marker('reports', 'reports'),
      },
    })

    const siblings = await discoverSiblings(github, CORE_ORG, CORE_REPO, CORE_PROJECT)

    expect(siblings).toHaveLength(1)
    expect(siblings[0]).toMatchObject({
      repo: 'reports',
      repoState: 'present',
      registered: false,
      pendingRegistrationPr: 7,
    })
  })

  it('aborts when a registered sibling name maps to an unrelated repo', async () => {
    const github = fakeGithub({
      // `reports` exists but carries no biffo.sibling.json — someone else's repo.
      repos: [`${CORE_ORG}/${CORE_REPO}`, `${CORE_ORG}/reports`],
      files: {
        [`${CORE_ORG}/${CORE_REPO}:infra/environments/dev/siblings.auto.tfvars.json`]: registry([
          'reports',
          'reports',
        ]),
      },
    })

    await expect(discoverSiblings(github, CORE_ORG, CORE_REPO, CORE_PROJECT)).rejects.toThrow(
      SiblingResolutionError,
    )
  })
})

describe('assertSiblingsAreDestroyable', () => {
  const present: ResolvedSibling = {
    pathPrefix: 'reports',
    projectName: 'reports',
    environments: ['dev'],
    accountId: ACCOUNT,
    registered: true,
    org: CORE_ORG,
    repo: 'reports',
    repoState: 'present',
  }

  it('passes when every live sibling ships a destroy workflow', async () => {
    const github = fakeGithub({
      repos: [`${CORE_ORG}/reports`],
      files: { [`${CORE_ORG}/reports:${DESTROY_WORKFLOW}`]: 'name: Destroy Infrastructure' },
    })

    await expect(assertSiblingsAreDestroyable(github, [present])).resolves.toBeUndefined()
  })

  it('refuses up front when a sibling has no destroy workflow', async () => {
    const github = fakeGithub({ repos: [`${CORE_ORG}/reports`] })

    await expect(assertSiblingsAreDestroyable(github, [present])).rejects.toThrow(
      /Nothing has been deleted/,
    )
  })

  it('ignores siblings whose repo is already gone', async () => {
    const github = fakeGithub({})

    await expect(
      assertSiblingsAreDestroyable(github, [{ ...present, repoState: 'gone' }]),
    ).resolves.toBeUndefined()
  })
})

describe('formatSiblingPlan', () => {
  const sibling: ResolvedSibling = {
    pathPrefix: 'crm',
    projectName: 'tabsii-crm',
    environments: ['dev', 'prod'],
    accountId: ACCOUNT,
    registered: true,
    org: CORE_ORG,
    repo: 'tabsii-crm',
    repoState: 'present',
  }

  it('shows nothing at all when there are no siblings', () => {
    expect(formatSiblingPlan([], false)).toEqual([])
  })

  it('names every repo about to be deleted, plus its IAM role and state bucket', () => {
    const out = formatSiblingPlan([sibling], false).join('\n')

    expect(out).toContain(`${CORE_ORG}/tabsii-crm`)
    expect(out).toContain('/crm')
    expect(out).toContain('biffo-github-actions-tabsii-crm')
    expect(out).toContain(`tabsii-crm-terraform-state-${ACCOUNT}`)
    expect(out).toContain('dev, prod')
  })

  it('is honest that --skip-destroy leaves the infrastructure standing', () => {
    const out = formatSiblingPlan([sibling], true).join('\n')

    expect(out).toContain('infrastructure NOT destroyed (--skip-destroy)')
    // The repo is still deleted, so it must still be named.
    expect(out).toContain(`${CORE_ORG}/tabsii-crm`)
  })

  it('warns that a sibling with no repo cannot have its infrastructure destroyed', () => {
    const out = formatSiblingPlan([{ ...sibling, repoState: 'gone' }], false).join('\n')

    expect(out).toContain('repo already deleted')
    expect(out).toContain('CANNOT be destroyed')
    // Nothing of its is claimed as deletable.
    expect(out).not.toContain('biffo-github-actions-tabsii-crm')
  })

  it('flags a sibling whose registration PR never merged', () => {
    const out = formatSiblingPlan(
      [{ ...sibling, registered: false, pendingRegistrationPr: 7 }],
      false,
    ).join('\n')

    expect(out).toContain('registration PR #7')
  })
})
