import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NON_INTERACTIVE_FLAG,
  NonInteractiveError,
  assertInteractive,
  isNonInteractive,
  nonInteractiveMessage,
  promptOr,
  registerNonInteractive,
} from './interactive.js'

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

describe('isNonInteractive', () => {
  it('is off by default — prompts still happen for a plain invocation', () => {
    expect(isNonInteractive(['node', 'biffo', 'teardown'], {})).toBe(false)
  })

  it('detects the flag before the subcommand', () => {
    expect(isNonInteractive(['node', 'biffo', NON_INTERACTIVE_FLAG, 'deploy', 'dev'], {})).toBe(
      true,
    )
  })

  it('detects the flag after the subcommand', () => {
    expect(isNonInteractive(['node', 'biffo', 'deploy', 'dev', NON_INTERACTIVE_FLAG], {})).toBe(
      true,
    )
  })

  it.each(['1', 'true', 'yes'])('honours BIFFO_NON_INTERACTIVE=%s', (value) => {
    expect(isNonInteractive([], { BIFFO_NON_INTERACTIVE: value })).toBe(true)
  })

  it.each(['', '0', 'false'])('treats BIFFO_NON_INTERACTIVE=%s as off', (value) => {
    expect(isNonInteractive([], { BIFFO_NON_INTERACTIVE: value })).toBe(false)
  })
})

describe('nonInteractiveMessage', () => {
  it('names both the question and the flag that answers it', () => {
    const message = nonInteractiveMessage('Which project?', 'Pass --project <name>.')
    expect(message).toContain('Which project?')
    expect(message).toContain(NON_INTERACTIVE_FLAG)
    expect(message).toContain('Pass --project <name>.')
  })
})

describe('assertInteractive / promptOr', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    promptMock.mockReset()
  })

  afterEach(() => {
    process.argv = originalArgv
    delete process.env['BIFFO_NON_INTERACTIVE']
  })

  it('passes through when interactive', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev']
    expect(() => assertInteractive('q', 'r')).not.toThrow()

    promptMock.mockResolvedValue({ answer: 'yes' })
    await expect(promptOr({ question: 'q', remedy: 'r' }, [{ name: 'answer' }])).resolves.toEqual({
      answer: 'yes',
    })
    expect(promptMock).toHaveBeenCalledOnce()
  })

  it('throws instead of prompting when non-interactive', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev', NON_INTERACTIVE_FLAG]

    await expect(
      promptOr({ question: 'q', remedy: 'Pass --foo.' }, [{ name: 'a' }]),
    ).rejects.toThrow(NonInteractiveError)
    // The whole point: a script gets an error, not a hanging prompt.
    expect(promptMock).not.toHaveBeenCalled()
  })
})

describe('registerNonInteractive', () => {
  it('adds the flag to the root program and every nested subcommand', () => {
    const program = new Command('biffo')
    const parent = new Command('plugin')
    parent.addCommand(new Command('install'))
    program.addCommand(parent)
    program.addCommand(new Command('deploy'))

    registerNonInteractive(program)

    const hasFlag = (c: Command) => c.options.some((o) => o.long === NON_INTERACTIVE_FLAG)
    expect(hasFlag(program)).toBe(true)
    expect(hasFlag(parent)).toBe(true)
    expect(hasFlag(parent.commands[0] as Command)).toBe(true)
    expect(hasFlag(program.commands[1] as Command)).toBe(true)
  })

  it('is idempotent — Commander throws on a duplicate option', () => {
    const program = new Command('biffo')
    registerNonInteractive(program)
    expect(() => registerNonInteractive(program)).not.toThrow()
    expect(program.options.filter((o) => o.long === NON_INTERACTIVE_FLAG)).toHaveLength(1)
  })
})
