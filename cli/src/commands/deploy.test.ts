import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BiffoConfig } from '../config/schema.js'
import { NON_INTERACTIVE_FLAG, NonInteractiveError } from '../lib/interactive.js'
import { chooseProject, describeProject } from './deploy.js'

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
