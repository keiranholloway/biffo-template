import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureWorkspaceSources,
  readDependencyNames,
  readProjectName,
  readTomlStringArray,
  workspaceMemberNames,
} from './plugin-workspace-sources.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'biffo-uv-sources-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(rel: string, content: string): string {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}

describe('readTomlStringArray', () => {
  it('reads single- and multi-line arrays and ignores absent keys', () => {
    const text =
      'members = ["services/*", "packages/python-sdk"]\ndependencies = [\n  "a>=1",\n  "b",\n]\n'
    expect(readTomlStringArray(text, 'members')).toEqual(['services/*', 'packages/python-sdk'])
    expect(readTomlStringArray(text, 'dependencies')).toEqual(['a>=1', 'b'])
    expect(readTomlStringArray(text, 'nope')).toEqual([])
  })

  it('skips comments inside the array — even ones with an apostrophe or brackets', () => {
    // The real ideation pyproject: a comment with "SDK's" (stray ') between the
    // first dep and biffo-plugin-sdk once dropped everything after it.
    const text =
      'dependencies = [\n' +
      '  "pydantic>=2.10.4",\n' +
      "  # The founder-gated Lambda: the SDK's require_group gate (user-serving)\n" +
      '  # + SigV4 [botocore]; biffo-plugin-sdk 1.1.0 is on PyPI, resolves normally.\n' +
      '  "biffo-plugin-sdk[user-serving,sigv4]>=1.1,<2.0",\n' +
      '  "fastapi>=0.1",\n' +
      ']\n'
    expect(readTomlStringArray(text, 'dependencies')).toEqual([
      'pydantic>=2.10.4',
      'biffo-plugin-sdk[user-serving,sigv4]>=1.1,<2.0',
      'fastapi>=0.1',
    ])
  })

  it('returns [] on an unterminated array rather than misparsing', () => {
    expect(readTomlStringArray('dependencies = [\n  "a",\n', 'dependencies')).toEqual([])
  })
})

describe('readProjectName', () => {
  it('reads the [project] name and is not fooled by a name under another table', () => {
    const text =
      '[tool.hatch]\nname = "wrong"\n\n[project]\nname = "biffo-plugin-sdk"\nversion = "1.1.0"\n'
    expect(readProjectName(text)).toBe('biffo-plugin-sdk')
  })
  it('returns null when there is no [project] name', () => {
    expect(readProjectName('[tool.uv.workspace]\nmembers = []\n')).toBeNull()
  })
})

describe('readDependencyNames', () => {
  it('strips extras and version specifiers', () => {
    const text =
      'dependencies = [\n  "biffo-plugin-sdk[user-serving,sigv4]>=1.1,<2.0",\n  "fastapi>=0.1",\n]\n'
    expect(readDependencyNames(text)).toEqual(['biffo-plugin-sdk', 'fastapi'])
  })
})

describe('workspaceMemberNames', () => {
  it('resolves member globs + literal paths to their [project] names', () => {
    write(
      'pyproject.toml',
      '[tool.uv.workspace]\nmembers = ["services/*", "services/_plugins/*", "packages/python-sdk"]\nexclude = ["services/_plugins"]\n',
    )
    write('packages/python-sdk/pyproject.toml', '[project]\nname = "biffo-plugin-sdk"\n')
    write('services/api/pyproject.toml', '[project]\nname = "biffo-api"\n')
    write(
      'services/_plugins/orchestrator/pyproject.toml',
      '[project]\nname = "biffo-orchestrator"\n',
    )
    // services/_plugins itself is excluded and has no [project] — must not appear
    write('services/_plugins/pyproject.toml', '[tool.uv]\n')

    const names = workspaceMemberNames(root)
    expect(names).toEqual(new Set(['biffo-plugin-sdk', 'biffo-api', 'biffo-orchestrator']))
  })

  it('is empty when there is no root pyproject', () => {
    expect(workspaceMemberNames(root)).toEqual(new Set())
  })
})

describe('ensureWorkspaceSources', () => {
  const members = new Set(['biffo-plugin-sdk'])

  it('adds a workspace source for a dep the instance provides, appending a new table', () => {
    const pp = write(
      'services/ideation/pyproject.toml',
      '[project]\nname = "ideation"\ndependencies = [\n  "biffo-plugin-sdk[user-serving]>=1.1,<2.0",\n  "fastapi>=0.1",\n]\n\n[tool.hatch.build.targets.wheel]\npackages = ["src/ideation"]\n',
    )
    const added = ensureWorkspaceSources(pp, members)
    expect(added).toEqual(['biffo-plugin-sdk'])
    const out = readFileSync(pp, 'utf8')
    expect(out).toContain('[tool.uv.sources]')
    expect(out).toContain('biffo-plugin-sdk = { workspace = true }')
    // untouched deps preserved
    expect(out).toContain('packages = ["src/ideation"]')
  })

  it('merges into an existing [tool.uv.sources] table', () => {
    const pp = write(
      'p/pyproject.toml',
      '[project]\nname = "p"\ndependencies = ["biffo-plugin-sdk>=1.1"]\n\n[tool.uv.sources]\nother = { path = "x" }\n',
    )
    ensureWorkspaceSources(pp, members)
    const out = readFileSync(pp, 'utf8')
    expect(out).toContain('other = { path = "x" }')
    expect(out).toContain('biffo-plugin-sdk = { workspace = true }')
    expect(out.match(/\[tool\.uv\.sources\]/g)).toHaveLength(1) // no duplicate table
  })

  it('is idempotent and a no-op when the dep is not a member', () => {
    const pp = write(
      'p/pyproject.toml',
      '[project]\nname = "p"\ndependencies = ["biffo-plugin-sdk>=1.1"]\n\n[tool.uv.sources]\nbiffo-plugin-sdk = { workspace = true }\n',
    )
    expect(ensureWorkspaceSources(pp, members)).toEqual([]) // already sourced
    const pp2 = write('q/pyproject.toml', '[project]\nname = "q"\ndependencies = ["httpx"]\n')
    expect(ensureWorkspaceSources(pp2, members)).toEqual([]) // httpx is not a member
  })
})
