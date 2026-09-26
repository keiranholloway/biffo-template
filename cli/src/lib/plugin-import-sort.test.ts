import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from './exec.js'
import { log } from './logger.js'
import { sortScaffoldedImports } from './plugin-import-sort.js'

vi.mock('./exec.js', () => ({ execa: vi.fn() }))
vi.mock('./logger.js', () => ({ log: { warn: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

describe('sortScaffoldedImports', () => {
  it('runs the ruff isort fix over exactly the given files', async () => {
    vi.mocked(execa).mockResolvedValue({} as never)
    await sortScaffoldedImports('/p', ['/p/a.py', '/p/b.py'])
    expect(execa).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining(['ruff', 'check', '--select', 'I', '--fix', '/p/a.py', '/p/b.py']),
      { cwd: '/p' },
    )
  })

  it('does nothing when there are no python files', async () => {
    await sortScaffoldedImports('/p', [])
    expect(execa).not.toHaveBeenCalled()
  })

  it('warns, with the manual command, when uv is missing — never silent', async () => {
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    await sortScaffoldedImports('/p', ['/p/a.py'])
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatch(
      /uv.*not on PATH.*ruff check --select I --fix/,
    )
  })

  it('throws with ruff stderr when the pass fails, rather than reporting a clean scaffold', async () => {
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('x'), { stderr: 'boom ruff' }))
    await expect(sortScaffoldedImports('/p', ['/p/a.py'])).rejects.toThrow(/boom ruff/)
  })
})
