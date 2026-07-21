import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BiffoConfig } from '../config/schema.js'
import type { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { NON_INTERACTIVE_FLAG, NonInteractiveError } from '../lib/interactive.js'
import { log } from '../lib/logger.js'
import {
  chooseProject,
  describeProject,
  readRemoteCoreVersion,
  warnIfDispatchRefStale,
} from './deploy.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

function makeConfig(name: string, org: string, repo: string): BiffoConfig {
  return {
    project: { name, description: '' },
    dns: { mode: 'none' },
    source_control: { provider: 'github', config: { org, repo } },
    cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'us-east-1' } },
    environments: ['dev'],
    admin: { email: 'a@example.com', username: 'admin' },
  } as unknown as BiffoConfig
}

const PROJECTS = [
  makeConfig('biffo-platform', 'keiranholloway', 'biffo-platform'),
  makeConfig('tabsii-platform', 'tabsii-com', 'tabsii-platform'),
]

describe('describeProject', () => {
  it('renders name and org/repo', () => {
    expect(describeProject(PROJECTS[0]!)).toBe('biffo-platform (keiranholloway/biffo-platform)')
  })
})

describe('chooseProject', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    promptMock.mockReset()
    process.argv = ['node', 'biffo', 'deploy', 'dev']
  })

  afterEach(() => {
    process.argv = originalArgv
    delete process.env['BIFFO_NON_INTERACTIVE']
  })

  it('prompts and returns the chosen project when interactive', async () => {
    promptMock.mockResolvedValue({ chosen: 'tabsii-platform' })

    await expect(chooseProject(PROJECTS)).resolves.toBe(PROJECTS[1])
    expect(promptMock).toHaveBeenCalledOnce()
  })

  it('errors instead of prompting when non-interactive', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev', '-y', NON_INTERACTIVE_FLAG]

    await expect(chooseProject(PROJECTS)).rejects.toThrow(NonInteractiveError)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('lists every candidate and names --project in the error', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev', NON_INTERACTIVE_FLAG]

    // A script's operator has to be able to fix this from the error text alone.
    const error = await chooseProject(PROJECTS).catch((e: unknown) => e as Error)
    expect(error.message).toContain('--project <name>')
    for (const project of PROJECTS) {
      expect(error.message).toContain(describeProject(project))
    }
  })
})

/**
 * Build a fake GitHubAdapter whose getFileContent serves per-ref file contents.
 * `files[ref][path]` → string (present) or undefined (absent).
 */
function fakeGithub(files: Record<string, Record<string, string | undefined>>): GitHubAdapter {
  return {
    getFileContent: vi.fn(async (_org: string, _repo: string, path: string, ref?: string) => {
      return files[ref ?? 'main']?.[path]
    }),
  } as unknown as GitHubAdapter
}

const coreJson = (v: string) => JSON.stringify({ version: v })

describe('readRemoteCoreVersion', () => {
  it('prefers biffo.core.json over the inherited core.version', async () => {
    const gh = fakeGithub({
      dev: { 'biffo.core.json': coreJson('0.5.0'), 'core.version': '0.4.0\n' },
    })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBe('0.5.0')
  })

  it('falls back to core.version when biffo.core.json is absent', async () => {
    const gh = fakeGithub({ dev: { 'core.version': '0.4.0\n' } })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBe('0.4.0')
  })

  it('returns null when neither file is present', async () => {
    const gh = fakeGithub({ dev: {} })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBeNull()
  })

  it('falls through a malformed biffo.core.json to core.version', async () => {
    const gh = fakeGithub({ dev: { 'biffo.core.json': '{ not json', 'core.version': '0.4.0\n' } })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBe('0.4.0')
  })
})

describe('warnIfDispatchRefStale (issue #328)', () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear()
  })

  it('warns loudly when the fixed dispatch ref is behind the branch being deployed', async () => {
    // A core upgrade landed on dev (0.5.0) but main (0.4.0) was never promoted.
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.4.0') },
      dev: { 'biffo.core.json': coreJson('0.5.0') },
    })

    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')

    expect(log.warn).toHaveBeenCalled()
    const text = vi
      .mocked(log.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
    expect(text).toContain('deploy-global.yml')
    expect(text).toContain("dispatched from 'main'")
    expect(text).toContain('0.4.0')
    expect(text).toContain('0.5.0')
    expect(text).toContain("Promote 'dev' → 'main'")
    expect(text).toContain('#328')
  })

  it('is silent when the dispatch ref is up to date with the deploy branch', async () => {
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.5.0') },
      dev: { 'biffo.core.json': coreJson('0.5.0') },
    })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('is silent when the dispatch ref is AHEAD of the deploy branch', async () => {
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.6.0') },
      dev: { 'biffo.core.json': coreJson('0.5.0') },
    })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('short-circuits (no API calls) when ref equals the deploy branch (prod)', async () => {
    const gh = fakeGithub({ main: { 'biffo.core.json': coreJson('0.5.0') } })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'main')
    expect(log.warn).not.toHaveBeenCalled()
    expect(gh.getFileContent).not.toHaveBeenCalled()
  })

  it('stays silent when a version cannot be read (never fabricates a mismatch)', async () => {
    const gh = fakeGithub({ main: {}, dev: { 'biffo.core.json': coreJson('0.5.0') } })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('never throws when the API call fails — a diagnostic must not abort the deploy', async () => {
    const gh = {
      getFileContent: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as GitHubAdapter
    await expect(
      warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev'),
    ).resolves.toBeUndefined()
    expect(log.warn).not.toHaveBeenCalled()
  })
})
