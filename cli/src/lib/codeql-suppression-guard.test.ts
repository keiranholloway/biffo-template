import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findCodeqlSuppressionComments,
  sweepCodeqlSuppressionComments,
} from './codeql-suppression-guard.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Fail-first: this is the exact line that shipped in this repo and did not
 * suppress alert #21 (#1491) — the guard is proved against real history
 * before it is pointed at the tree, the same discipline as
 * `pipe-trap-guard.test.ts`.
 */
describe('findCodeqlSuppressionComments', () => {
  it('flags the shape that shipped as a no-op suppression', () => {
    expect(
      findCodeqlSuppressionComments('// codeql[js/file-system-race]\nwriteFileSync(path, data)\n'),
    ).toEqual([1])
  })

  it('flags the trailing-explanation form too', () => {
    expect(
      findCodeqlSuppressionComments(
        '  // codeql[js/file-system-race] — see the block comment above\n  writeFileSync(path, data)\n',
      ),
    ).toEqual([1])
  })

  it('flags a Python-style comment carrying the same shape', () => {
    expect(findCodeqlSuppressionComments('# codeql[py/full-ssrf]\nrequests.get(url)\n')).toEqual([
      1,
    ])
  })

  it('is silent on ordinary code with no such comment', () => {
    expect(
      findCodeqlSuppressionComments('writeFileSync(path, data)\n// a normal comment\n'),
    ).toEqual([])
  })
})

describe('the repo carries none of the dead convention', () => {
  it('has no codeql[...] suppression comment anywhere in cli/src', () => {
    const hits = sweepCodeqlSuppressionComments(join(repoRoot, 'cli', 'src'))
    expect(hits).toEqual([])
  })
})
