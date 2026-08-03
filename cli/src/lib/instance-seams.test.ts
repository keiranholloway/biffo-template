import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findNewUndeclaredSeams } from './instance-seams.js'
import { makeTmpDir } from '../test-utils/tmp.js'

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function tsconfig(paths: Record<string, string[]>): string {
  return JSON.stringify({ compilerOptions: { baseUrl: '.', paths } })
}

describe('findNewUndeclaredSeams (#1188)', () => {
  let base: string
  let theirs: string
  let ours: string

  beforeEach(() => {
    base = makeTmpDir('base')
    theirs = makeTmpDir('theirs')
    ours = makeTmpDir('ours')
  })
  afterEach(() => {
    for (const d of [base, theirs, ours]) rmSync(d, { recursive: true, force: true })
  })

  it('reports a new seam the instance has not declared', () => {
    // base has no seams at all (predates the seam)
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    // theirs introduces one
    w(
      theirs,
      'apps/portal/tsconfig.json',
      tsconfig({ '@/instance-login-destinations': ['./src/lib/login-destinations-default.ts'] }),
    )
    // ours never created src/instance-login-destinations.ts

    const result = findNewUndeclaredSeams(base, theirs, ours)
    expect(result).toEqual([
      {
        specifier: '@/instance-login-destinations',
        instanceFile: 'apps/portal/src/instance-login-destinations.ts',
        defaultFile: 'apps/portal/src/lib/login-destinations-default.ts',
      },
    ])
  })

  it('does not report a seam the instance already declares', () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    w(
      theirs,
      'apps/portal/tsconfig.json',
      tsconfig({ '@/instance-login-destinations': ['./src/lib/login-destinations-default.ts'] }),
    )
    // the instance already added its own declaration
    w(ours, 'apps/portal/src/instance-login-destinations.ts', 'export const x = 1\n')

    expect(findNewUndeclaredSeams(base, theirs, ours)).toEqual([])
  })

  it('is unaffected when the upgrade carries no seam changes at all', () => {
    // base and theirs agree on the exact same seam set — nothing new
    const paths = { '@/instance-nav': ['./src/lib/instance-nav-empty.ts'] }
    w(base, 'apps/portal/tsconfig.json', tsconfig(paths))
    w(theirs, 'apps/portal/tsconfig.json', tsconfig(paths))
    // the instance never declared it either — irrelevant, it is not new

    expect(findNewUndeclaredSeams(base, theirs, ours)).toEqual([])
  })

  it('is unaffected when neither tree has any seam at all', () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    w(theirs, 'apps/portal/tsconfig.json', tsconfig({}))
    expect(findNewUndeclaredSeams(base, theirs, ours)).toEqual([])
  })

  it('reports only the new seam among a mix of new and pre-existing', () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({ '@/instance-nav': ['./src/lib/a.ts'] }))
    w(
      theirs,
      'apps/portal/tsconfig.json',
      tsconfig({
        '@/instance-nav': ['./src/lib/a.ts'],
        '@/instance-login-destinations': ['./src/lib/login-destinations-default.ts'],
      }),
    )

    const result = findNewUndeclaredSeams(base, theirs, ours)
    expect(result.map((s) => s.specifier)).toEqual(['@/instance-login-destinations'])
  })

  it('does not throw when a tree has no tsconfig.json at all (pre-portal template checkout)', () => {
    // base has nothing under apps/portal/ whatsoever
    w(theirs, 'apps/portal/tsconfig.json', tsconfig({ '@/instance-nav': ['./src/lib/a.ts'] }))
    expect(findNewUndeclaredSeams(base, theirs, ours)).toEqual([
      {
        specifier: '@/instance-nav',
        instanceFile: 'apps/portal/src/instance-nav.ts',
        defaultFile: 'apps/portal/src/lib/a.ts',
      },
    ])
  })

  it('does not throw on a malformed tsconfig.json', () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    w(theirs, 'apps/portal/tsconfig.json', 'not json at all')
    expect(findNewUndeclaredSeams(base, theirs, ours)).toEqual([])
  })

  it('ignores non-instance path entries', () => {
    w(base, 'apps/portal/tsconfig.json', tsconfig({}))
    w(theirs, 'apps/portal/tsconfig.json', tsconfig({ '@/*': ['./src/*'] }))
    expect(findNewUndeclaredSeams(base, theirs, ours)).toEqual([])
  })
})
