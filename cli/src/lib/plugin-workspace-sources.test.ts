import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'
import { findSkeletonRoot } from './plugin-scaffold.js'

import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureWorkspaceSources,
  readDeclaredDependencyNames,
  readProjectName,
  readTomlStringArray,
  workspaceMemberNames,
} from './plugin-workspace-sources.js'

let root: string
beforeEach(() => {
  root = makeTmpDir('biffo-uv-sources')
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

describe('readDeclaredDependencyNames', () => {
  const names = (text: string) => readDeclaredDependencyNames(parseToml(text)).sort()

  it('strips extras and version specifiers', () => {
    expect(
      names(
        '[project]\ndependencies = ["biffo-plugin-sdk[user-serving]>=1.1,<2.0", "fastapi>=0.1", "httpx"]\n',
      ),
    ).toEqual(['biffo-plugin-sdk', 'fastapi', 'httpx'])
  })

  it('reads [project] dependencies, every optional extra and every dependency group', () => {
    expect(
      names(
        '[project]\ndependencies = [\n  "only-project>=1",\n]\n\n' +
          '[project.optional-dependencies]\nserving = [\n  "extra-one[x]>=2",\n]\n\n' +
          '[dependency-groups]\ndev = [\n  "pytest>=8",\n  {include-group = "docs"},\n' +
          "  # the host's [importable] check, not a runtime dep\n" +
          '  "biffo-plugin-host~=0.1.0",\n]\ndocs = ["sphinx"]\n\n[tool.other]\nx = ["not-a-dep"]\n',
      ),
    ).toEqual(['biffo-plugin-host', 'extra-one', 'only-project', 'pytest', 'sphinx'])
  })

  it('reads a top-level inline dependency-groups table', () => {
    expect(names('dependency-groups = { dev = ["biffo-plugin-host"] }\n')).toEqual([
      'biffo-plugin-host',
    ])
  })

  it('is empty when there are no dependencies at all', () => {
    expect(names('[project]\nname = "x"\n')).toEqual([])
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

// biffo-template#2106: uv applies "workspace member needs a tool.uv.sources entry" to dependency GROUPS too. The skeleton declares
// biffo-plugin-host in its `dev` group, and reading only `[project] dependencies` left the next `uv run` failing on it.
describe('dependency groups and optional dependencies (#2106)', () => {
  it('sources a workspace member that is only declared in a dependency group', () => {
    write('pyproject.toml', '[tool.uv.workspace]\nmembers = ["services/*"]\n')
    write('services/_plugin-host/pyproject.toml', '[project]\nname = "biffo-plugin-host"\n')
    const plugin = write(
      'services/acme/pyproject.toml',
      '[project]\nname = "acme"\ndependencies = ["fastapi"]\n\n[dependency-groups]\ndev = [\n  "biffo-plugin-host~=0.1.0",\n]\n',
    )
    expect(ensureWorkspaceSources(plugin, workspaceMemberNames(root))).toEqual([
      'biffo-plugin-host',
    ])
    expect(readFileSync(plugin, 'utf8')).toContain('biffo-plugin-host = { workspace = true }')
    // idempotent
    expect(ensureWorkspaceSources(plugin, workspaceMemberNames(root))).toEqual([])
  })

  // The class, not the case: run it over the pyproject `plugin create` really scaffolds, against the members the platform instance
  // really has. Any workspace-provided dependency the skeleton declares anywhere must come out sourced.
  const skeleton = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')
  it.runIf(skeleton)(
    'sources every workspace-provided dependency the real skeleton pyproject declares',
    () => {
      write(
        'pyproject.toml',
        '[tool.uv.workspace]\nmembers = ["services/*", "packages/python-sdk"]\n',
      )
      write('services/_plugin-host/pyproject.toml', '[project]\nname = "biffo-plugin-host"\n')
      write('packages/python-sdk/pyproject.toml', '[project]\nname = "biffo-plugin-sdk"\n')
      const plugin = write(
        'services/acme/pyproject.toml',
        readFileSync(join(skeleton!, 'pyproject.toml'), 'utf8'),
      )
      const added = ensureWorkspaceSources(plugin, workspaceMemberNames(root))
      expect(added.sort()).toEqual(['biffo-plugin-host', 'biffo-plugin-sdk'])
      const text = readFileSync(plugin, 'utf8')
      for (const n of added) expect(text).toContain(`${n} = { workspace = true }`)
    },
  )
})

// biffo-template#2106, prosecution of #2107 finding 2. The group reader and the sources edit were line regexes, so every valid
// TOML spelling they had not been shown (a comment after a header, a quoted or indented key) silently skipped a group — the very
// `uv` failure the change existed to fix — or wrote an invalid, duplicated `[tool.uv.sources]`. These cases are the CLASS: every
// spelling of the dependency table crossed with every spelling of the sources table, judged by a real TOML parser.
describe('valid TOML spellings (#2106 prosecution finding 2)', () => {
  const MEMBERS = new Set(['biffo-plugin-host', 'biffo-plugin-sdk'])
  const HEAD = '[project]\nname = "acme"\ndependencies = ["fastapi"]\n\n'

  const declarations: Array<[string, string]> = [
    ['plain', '[dependency-groups]\ndev = ["pytest", "biffo-plugin-host~=0.1.0"]\n'],
    [
      'comment after the header',
      '[dependency-groups] # dev tooling\ndev = ["biffo-plugin-host~=0.1.0"]\n',
    ],
    ['spaces inside the header', '[ dependency-groups ]\ndev = ["biffo-plugin-host~=0.1.0"]\n'],
    ['quoted header segment', '["dependency-groups"]\ndev = ["biffo-plugin-host~=0.1.0"]\n'],
    ['double-quoted key', '[dependency-groups]\n"dev" = ["biffo-plugin-host~=0.1.0"]\n'],
    ['single-quoted key', '[dependency-groups]\n\'dev\' = ["biffo-plugin-host~=0.1.0"]\n'],
    ['indented key', '[dependency-groups]\n  dev = [\n    "biffo-plugin-host~=0.1.0",\n  ]\n'],
    ['key with spaces around =', '[dependency-groups]\ndev   =   ["biffo-plugin-host~=0.1.0"]\n'],
    [
      'include-group entry beside a string',
      '[dependency-groups]\ndev = [{include-group = "lint"}, "biffo-plugin-host"]\nlint = ["ruff"]\n',
    ],
    [
      'comments inside and after the array',
      '[dependency-groups]\ndev = [ # tools\n  "pytest", # test runner\n  "biffo-plugin-host~=0.1.0", # [importable] check\n]\n',
    ],
    [
      'optional-dependencies, comment after header',
      '[project.optional-dependencies] # extras\nserve = ["biffo-plugin-host>=0.1"]\n',
    ],
  ]
  const sourcesTables: Array<[string, string, string]> = [
    ['absent', '', ''],
    ['plain', '\n[tool.uv.sources]\nother = { path = "../other" }\n', ''],
    [
      'comment after the header',
      '\n[tool.uv.sources] # workspace deps\nother = { path = "../other" }\n',
      '',
    ],
    ['spaces inside the header', '\n[ tool.uv.sources ]\nother = { path = "../other" }\n', ''],
    ['quoted header segment', '\n[tool."uv".sources]\nother = { path = "../other" }\n', ''],
    ['empty', '\n[tool.uv.sources]\n', ''],
    ['last in file, no trailing newline', '\n[tool.uv.sources]\nother = { path = "../other" }', ''],
  ]

  function sourcesOf(text: string): Record<string, unknown> {
    const tool = parseToml(text).tool as { uv?: { sources?: Record<string, unknown> } } | undefined
    return tool?.uv?.sources ?? {}
  }

  for (const [decl, declText] of declarations) {
    for (const [src, srcText] of sourcesTables) {
      it(`declaration: ${decl} × sources table: ${src}`, () => {
        const pp = write('services/acme/pyproject.toml', HEAD + declText + srcText)
        const added = ensureWorkspaceSources(pp, MEMBERS)
        const out = readFileSync(pp, 'utf8')

        expect(added).toEqual(['biffo-plugin-host'])
        // A real parser accepts it (a duplicate [tool.uv.sources] table, or a duplicate key, does not parse)...
        expect(sourcesOf(out)['biffo-plugin-host']).toEqual({ workspace: true })
        // ...and what was there is still there.
        if (srcText.includes('other')) expect(sourcesOf(out).other).toEqual({ path: '../other' })
        // Exactly one sources table, wherever it was written.
        expect(out.match(/^\s*\[\s*tool\s*\.\s*"?uv"?\s*\.\s*sources\s*\]/gm)).toHaveLength(1)
        // Idempotent.
        expect(ensureWorkspaceSources(pp, MEMBERS)).toEqual([])
        expect(readFileSync(pp, 'utf8')).toBe(out)
      })
    }
  }

  it('leaves an existing NON-workspace source alone: no duplicate key, no rewrite', () => {
    const text =
      HEAD +
      '[dependency-groups]\ndev = ["biffo-plugin-host"]\n\n[tool.uv.sources] # pinned by hand\nbiffo-plugin-host = { path = "../host" }\n'
    const pp = write('services/acme/pyproject.toml', text)
    expect(ensureWorkspaceSources(pp, MEMBERS)).toEqual([])
    expect(readFileSync(pp, 'utf8')).toBe(text)
  })

  it('treats a quoted existing key as the same source', () => {
    const text =
      HEAD +
      '[dependency-groups]\ndev = ["biffo-plugin-host"]\n\n[tool.uv.sources]\n"biffo-plugin-host" = { workspace = true }\n'
    const pp = write('services/acme/pyproject.toml', text)
    expect(ensureWorkspaceSources(pp, MEMBERS)).toEqual([])
    expect(readFileSync(pp, 'utf8')).toBe(text)
  })

  it('is not fooled by header-shaped text inside a multi-line string or an array', () => {
    const text =
      '[project]\nname = "acme"\ndescription = """\n[tool.uv.sources]\nfake = { workspace = true }\n"""\n' +
      'dependencies = [\n  "fastapi",\n]\n\n[dependency-groups]\ndev = [\n  "biffo-plugin-host",\n]\n'
    const pp = write('services/acme/pyproject.toml', text)
    expect(ensureWorkspaceSources(pp, MEMBERS)).toEqual(['biffo-plugin-host'])
    const out = readFileSync(pp, 'utf8')
    expect(sourcesOf(out)).toEqual({ 'biffo-plugin-host': { workspace: true } })
    expect((parseToml(out).project as { description: string }).description).toContain('fake')
  })

  it('refuses, writing nothing, when [tool.uv.sources] exists in a form it cannot extend in place', () => {
    const text =
      HEAD +
      '[dependency-groups]\ndev = ["biffo-plugin-host"]\n\n[tool.uv]\nsources = { other = { path = "../o" } }\n'
    const pp = write('services/acme/pyproject.toml', text)
    expect(() => ensureWorkspaceSources(pp, MEMBERS)).toThrow(
      /tool\.uv\.sources.*biffo-plugin-host/s,
    )
    expect(readFileSync(pp, 'utf8')).toBe(text)
  })

  it('refuses, writing nothing, when appending the table would make the file invalid (an inline `tool`)', () => {
    const text =
      'tool = { uv = { python-preference = "system" } }\n' +
      HEAD +
      '[dependency-groups]\ndev = ["biffo-plugin-host"]\n'
    const pp = write('services/acme/pyproject.toml', text)
    expect(() => ensureWorkspaceSources(pp, MEMBERS)).toThrow(
      /could not add a workspace source for biffo-plugin-host/,
    )
    expect(readFileSync(pp, 'utf8')).toBe(text)
  })

  it('refuses, writing nothing, on a pyproject that is not valid TOML', () => {
    const text = HEAD + '[dependency-groups]\ndev = [\n'
    const pp = write('services/acme/pyproject.toml', text)
    expect(() => ensureWorkspaceSources(pp, MEMBERS)).toThrow(/pyproject\.toml.*not valid TOML/s)
    expect(readFileSync(pp, 'utf8')).toBe(text)
  })

  it('dotted names in a workspace-provided dependency are written as a quoted key', () => {
    const pp = write('services/acme/pyproject.toml', HEAD.replace('["fastapi"]', '["ruamel.yaml"]'))
    expect(ensureWorkspaceSources(pp, new Set(['ruamel.yaml']))).toEqual(['ruamel.yaml'])
    expect(sourcesOf(readFileSync(pp, 'utf8'))).toEqual({ 'ruamel.yaml': { workspace: true } })
  })
})
