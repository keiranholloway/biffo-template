import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NON_INTERACTIVE_FLAG, NonInteractiveError } from '../lib/interactive.js'
import { confirmTeardown } from './teardown.js'

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
