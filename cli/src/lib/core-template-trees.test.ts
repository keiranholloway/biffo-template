import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coreTag, materializeTemplateAtTag, workingTreeMatchesTag } from './core-template-trees.js'
import { makeTmpDir } from '../test-utils/tmp.js'

describe('coreTag', () => {
  it('builds the tag for a semver', () => {
    expect(coreTag('0.2.0')).toBe('core-v0.2.0')
  })
  it('rejects a non-semver', () => {
    expect(() => coreTag('latest')).toThrow()
  })
})

describe('materializeTemplateAtTag — error path (no real git)', () => {
  it('throws an actionable error when the tag is absent even after a fetch', () => {
    const git = vi.fn((args: string[]) => {
      if (args.includes('rev-parse')) throw new Error('unknown revision')
      return '' // fetch succeeds but adds nothing
    })
    expect(() => materializeTemplateAtTag('/repo', '9.9.9', git)).toThrow(
      /No git tag core-v9\.9\.9/,
    )
    // Attempted a fetch before giving up.
    expect(git.mock.calls.some((c) => c[0].includes('fetch'))).toBe(true)
  })
})

describe('materializeTemplateAtTag — success path (real git repo)', () => {
  let repo: string
  const made: Array<() => void> = []

  beforeEach(() => {
    repo = makeTmpDir('biffo-tpl-repo')
    const g = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'test@example.com'])
    g(['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'core.version'), '0.9.0\n')
    // A nested tracked file proves the whole tree is extracted, not just the root.
    mkdirSync(join(repo, 'services', 'api'), { recursive: true })
    writeFileSync(join(repo, 'services', 'api', 'main.py'), 'CORE_0_9_0')
    g(['add', '-A'])
    g(['commit', '-qm', 'v0.9.0'])
    g(['tag', 'core-v0.9.0'])
  })

  afterEach(() => {
    for (const c of made) c()
    made.length = 0
    rmSync(repo, { recursive: true, force: true })
  })

  it('extracts the tagged tree into a fresh temp dir and cleans up', () => {
    const tree = materializeTemplateAtTag(repo, '0.9.0')
    made.push(tree.cleanup)

    expect(existsSync(join(tree.dir, 'services', 'api', 'main.py'))).toBe(true)
    expect(readFileSync(join(tree.dir, 'services', 'api', 'main.py'), 'utf8')).toBe('CORE_0_9_0')
    expect(readFileSync(join(tree.dir, 'core.version'), 'utf8').trim()).toBe('0.9.0')

    tree.cleanup()
    expect(existsSync(tree.dir)).toBe(false)
  })
})

describe('workingTreeMatchesTag — the #471 stale-working-tree gate (real git repo)', () => {
  let repo: string
  let g: (args: string[]) => string

  beforeEach(() => {
    repo = makeTmpDir('biffo-tpl-match')
    g = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'test@example.com'])
    g(['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'ci.yml'), 'name: Release Guards\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'v0.9.0'])
    g(['tag', 'core-v0.9.0'])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('is true when HEAD is the tag commit and the tracked tree is clean', () => {
    expect(workingTreeMatchesTag(repo, '0.9.0')).toBe(true)
  })

  it('is FALSE when the checkout has moved past the tag (the #471 scenario)', () => {
    // Simulate release PRs merged on the remote but not reflected at the tag:
    // HEAD advances beyond core-v0.9.0, so the working tree is NOT that version.
    writeFileSync(join(repo, 'ci.yml'), 'name: Core Version Guard\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'later work'])
    expect(workingTreeMatchesTag(repo, '0.9.0')).toBe(false)
  })

  it('is FALSE when a tracked file is modified in the working tree', () => {
    writeFileSync(join(repo, 'ci.yml'), 'name: tampered\n')
    expect(workingTreeMatchesTag(repo, '0.9.0')).toBe(false)
  })

  it('ignores untracked files — they are not part of the tracked tree', () => {
    writeFileSync(join(repo, 'scratch.local'), 'ignore me')
    expect(workingTreeMatchesTag(repo, '0.9.0')).toBe(true)
  })

  it('is FALSE (not a throw) when the tag does not exist', () => {
    expect(workingTreeMatchesTag(repo, '1.2.3')).toBe(false)
  })
})
