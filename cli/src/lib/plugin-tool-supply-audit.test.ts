import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import type { PySource } from './plugin-tool-supply-audit.js'
import {
  auditPluginToolSupply,
  assertPluginToolSupply,
  buildSymbolResolver,
  discoverPluginDirs,
  extractManifestTools,
  extractPredicateEnvVars,
  extractTerraformEnvKeys,
  extractToolRegistryEntries,
} from './plugin-tool-supply-audit.js'

function src(file: string, text: string): PySource[] {
  return [{ file, text }]
}

// ── extractManifestTools ─────────────────────────────────────────────────

describe('extractManifestTools', () => {
  it('extracts names from object-shaped tool entries', () => {
    const result = extractManifestTools(JSON.stringify({ tools: [{ name: 'web_search' }] }))
    expect(result.tools).toEqual(['web_search'])
    expect(result.parseError).toBeNull()
  })

  it('accepts bare-string tool entries too', () => {
    const result = extractManifestTools(JSON.stringify({ tools: ['web_search'] }))
    expect(result.tools).toEqual(['web_search'])
  })

  it('treats an absent tools key as "declares none" — not an error', () => {
    const result = extractManifestTools(JSON.stringify({ name: 'orchestrator' }))
    expect(result.tools).toEqual([])
    expect(result.parseError).toBeNull()
  })

  it('fails on invalid JSON rather than reporting no tools', () => {
    const result = extractManifestTools('{ not json')
    expect(result.parseError).toMatch(/invalid JSON/)
  })

  it('fails when "tools" is present but not an array', () => {
    const result = extractManifestTools(JSON.stringify({ tools: 'web_search' }))
    expect(result.parseError).toMatch(/not an array/)
  })

  it('fails on a tools entry with no resolvable name, rather than skipping it', () => {
    const result = extractManifestTools(JSON.stringify({ tools: [{ description: 'x' }] }))
    expect(result.parseError).toMatch(/no resolvable string name/)
  })
})

// ── buildSymbolResolver / extractToolRegistryEntries ─────────────────────

describe('extractToolRegistryEntries', () => {
  it('resolves name= and is_available= through indirect module constants (the real shape)', () => {
    const sources = src(
      'tools.py',
      `
WEB_SEARCH_NAME = "web_search"

WEB_SEARCH = ToolDefinition(
    name=WEB_SEARCH_NAME,
    description=WEB_SEARCH_DESCRIPTION,
    parameters=WEB_SEARCH_PARAMETERS,
    execute=execute_web_search,
    is_available=web_search_configured,
)
`,
    )
    const resolver = buildSymbolResolver(sources)
    const { entries, rawToolDefinitionCount } = extractToolRegistryEntries(sources, resolver)
    expect(rawToolDefinitionCount).toBe(1)
    expect(entries).toEqual([
      { name: 'web_search', predicate: 'web_search_configured', unresolvedReason: null },
    ])
  })

  it('accepts a direct string literal for name=', () => {
    const sources = src(
      'tools.py',
      `X = ToolDefinition(name="direct_tool", is_available=always_on)`,
    )
    const { entries } = extractToolRegistryEntries(sources, buildSymbolResolver(sources))
    expect(entries[0].name).toBe('direct_tool')
  })

  it('treats a tool with no is_available kwarg as unconditionally available', () => {
    const sources = src(
      'tools.py',
      `NAME = "always_here"\nX = ToolDefinition(name=NAME, description="d")`,
    )
    const { entries } = extractToolRegistryEntries(sources, buildSymbolResolver(sources))
    expect(entries[0]).toEqual({ name: 'always_here', predicate: null, unresolvedReason: null })
  })

  it('marks an unresolvable name= identifier as unresolved, not absent', () => {
    // NOT_DEFINED_ANYWHERE never appears as a `= "literal"` assignment.
    const sources = src(
      'tools.py',
      `X = ToolDefinition(name=NOT_DEFINED_ANYWHERE, is_available=foo)`,
    )
    const { entries } = extractToolRegistryEntries(sources, buildSymbolResolver(sources))
    expect(entries[0].name).toBeNull()
    expect(entries[0].unresolvedReason).toMatch(/absent from \(or ambiguous in\)/)
  })

  it('resolves a dotted is_available reference to its last segment', () => {
    const sources = src(
      'tools.py',
      `NAME = "t"\nX = ToolDefinition(name=NAME, is_available=mod.sub.predicate)`,
    )
    const { entries } = extractToolRegistryEntries(sources, buildSymbolResolver(sources))
    expect(entries[0].predicate).toBe('predicate')
  })

  it('resolves name= against a constant imported from ANOTHER file (cross-file fallback)', () => {
    const sources: PySource[] = [
      { file: 'search.py', text: `WEB_SEARCH_NAME = "web_search"` },
      {
        file: 'tools.py',
        text: `from .search import WEB_SEARCH_NAME\nX = ToolDefinition(name=WEB_SEARCH_NAME, is_available=on)`,
      },
    ]
    const { entries } = extractToolRegistryEntries(sources, buildSymbolResolver(sources))
    expect(entries[0].name).toBe('web_search')
  })
})

// ── extractPredicateEnvVars ──────────────────────────────────────────────

describe('extractPredicateEnvVars', () => {
  const realShapeSearchPy = `
_KEY_ENV = "BRAVE_SEARCH_API_KEY"
_KEY_PARAMETER_ENV = "BRAVE_SEARCH_API_KEY_PARAMETER"


def web_search_configured() -> bool:
    return bool(
        os.environ.get(_KEY_ENV, "").strip() or os.environ.get(_KEY_PARAMETER_ENV, "").strip()
    )


def next_function():
    return os.environ.get("SHOULD_NOT_BE_INCLUDED")
`

  it('resolves both indirected env var names an OR-fallback predicate reads, stopping at the next def', () => {
    const sources = src('search.py', realShapeSearchPy)
    const result = extractPredicateEnvVars(
      sources,
      'web_search_configured',
      buildSymbolResolver(sources),
    )
    expect(result.predicateFound).toBe(true)
    expect(result.envVars).toEqual(['BRAVE_SEARCH_API_KEY', 'BRAVE_SEARCH_API_KEY_PARAMETER'])
    expect(result.envVars).not.toContain('SHOULD_NOT_BE_INCLUDED')
  })

  it('reports predicateFound: false when the function does not exist in ANY source file', () => {
    const sources = src('other.py', 'def something_else(): pass')
    const result = extractPredicateEnvVars(
      sources,
      'missing_predicate',
      buildSymbolResolver(sources),
    )
    expect(result.predicateFound).toBe(false)
    expect(result.envVars).toEqual([])
  })

  it('reports an unresolved token rather than silently dropping it', () => {
    const sources = src(
      'gate.py',
      `def gate():\n    return bool(os.environ.get(SOME_UNDEFINED_CONST))`,
    )
    const result = extractPredicateEnvVars(sources, 'gate', buildSymbolResolver(sources))
    expect(result.predicateFound).toBe(true)
    expect(result.envVars).toEqual([])
    expect(result.unresolvedTokens).toEqual(['SOME_UNDEFINED_CONST'])
  })

  it('also matches os.getenv(...) and os.environ[...] forms', () => {
    const sources = src(
      'gate.py',
      `
K1 = "A_VAR"
K2 = "B_VAR"
def gate():
    return bool(os.getenv(K1) or os.environ[K2])
`,
    )
    const result = extractPredicateEnvVars(sources, 'gate', buildSymbolResolver(sources))
    expect(result.envVars).toEqual(['A_VAR', 'B_VAR'])
  })

  it('REGRESSION: does not let a same-named private constant in ANOTHER file leak in (the real openrouter.py/search.py collision)', () => {
    // openrouter.py and search.py each define their OWN `_KEY_ENV` /
    // `_KEY_PARAMETER_ENV` — same identifiers, different (module-private)
    // meanings, never imported between the two. A merged, file-blind symbol
    // table resolves whichever definition it saw first and silently
    // attributes the wrong plugin's credential to this predicate — caught by
    // this exact test against a global-table version of this guard, which
    // reported OPENROUTER_API_KEY(_PARAMETER) for web_search_configured().
    const sources: PySource[] = [
      {
        file: 'openrouter.py',
        text: `
_KEY_ENV = "OPENROUTER_API_KEY"
_KEY_PARAMETER_ENV = "OPENROUTER_API_KEY_PARAMETER"


def _resolve_openrouter_key():
    return os.environ.get(_KEY_ENV) or os.environ.get(_KEY_PARAMETER_ENV)
`,
      },
      {
        file: 'search.py',
        text: `
_KEY_ENV = "BRAVE_SEARCH_API_KEY"
_KEY_PARAMETER_ENV = "BRAVE_SEARCH_API_KEY_PARAMETER"


def web_search_configured() -> bool:
    return bool(os.environ.get(_KEY_ENV, "").strip() or os.environ.get(_KEY_PARAMETER_ENV, "").strip())
`,
      },
    ]
    const resolver = buildSymbolResolver(sources)
    const result = extractPredicateEnvVars(sources, 'web_search_configured', resolver)
    expect(result.envVars).toEqual(['BRAVE_SEARCH_API_KEY', 'BRAVE_SEARCH_API_KEY_PARAMETER'])
    expect(result.envVars).not.toContain('OPENROUTER_API_KEY')
    expect(result.envVars).not.toContain('OPENROUTER_API_KEY_PARAMETER')
  })
})

// ── extractTerraformEnvKeys ──────────────────────────────────────────────

describe('extractTerraformEnvKeys', () => {
  it('extracts keys from the real merge(...) shape used by every plugin here', () => {
    const tf = `
  environment_variables = merge(
    {
      BIFFO_CORE_API_URL = var.core_api_url
      OPENROUTER_API_KEY_PARAMETER = var.openrouter_api_key_parameter
      BRAVE_SEARCH_API_KEY_PARAMETER = var.brave_search_api_key_parameter
    },
    var.environment_variables,
  )
`
    const result = extractTerraformEnvKeys(tf)
    expect(result.keys).toEqual([
      'BIFFO_CORE_API_URL',
      'BRAVE_SEARCH_API_KEY_PARAMETER',
      'OPENROUTER_API_KEY_PARAMETER',
    ])
    expect(result.resolvedBlockCount).toBe(1)
  })

  it('extracts keys from a plain object-literal shape too', () => {
    const tf = `environment_variables = {\n  FOO = "bar"\n}`
    const result = extractTerraformEnvKeys(tf)
    expect(result.keys).toEqual(['FOO'])
  })

  it('reports blindness (rawMarkerCount > 0, resolvedBlockCount 0) when the value has no bracket to scan', () => {
    const tf = `environment_variables = var.some_map_with_no_visible_literal`
    const result = extractTerraformEnvKeys(tf)
    expect(result.rawMarkerCount).toBe(1)
    expect(result.resolvedBlockCount).toBe(0)
    expect(result.keys).toEqual([])
  })
})

// ── auditPluginToolSupply — end to end against a synthetic plugin tree ──

function writeAgentLikePlugin(
  pluginsRoot: string,
  name: string,
  opts: { tools?: unknown; wireTerraformVar: boolean; terraformVarName?: string },
) {
  const dir = join(pluginsRoot, name)
  mkdirSync(join(dir, 'src', 'pkg'), { recursive: true })
  mkdirSync(join(dir, 'terraform'), { recursive: true })

  writeFileSync(
    join(dir, 'biffo.plugin.json'),
    JSON.stringify({
      name,
      tools: opts.tools ?? [{ name: 'web_search', description: 'search', parameters: {} }],
    }),
  )

  writeFileSync(
    join(dir, 'src', 'pkg', 'search.py'),
    `
_KEY_ENV = "BRAVE_SEARCH_API_KEY"
_KEY_PARAMETER_ENV = "BRAVE_SEARCH_API_KEY_PARAMETER"

WEB_SEARCH_NAME = "web_search"


def web_search_configured() -> bool:
    return bool(
        os.environ.get(_KEY_ENV, "").strip() or os.environ.get(_KEY_PARAMETER_ENV, "").strip()
    )
`,
  )

  writeFileSync(
    join(dir, 'src', 'pkg', 'tools.py'),
    `
from .search import WEB_SEARCH_NAME, web_search_configured

WEB_SEARCH = ToolDefinition(
    name=WEB_SEARCH_NAME,
    description="d",
    parameters={},
    execute=execute_web_search,
    is_available=web_search_configured,
)
`,
  )

  const varName = opts.terraformVarName ?? 'BRAVE_SEARCH_API_KEY_PARAMETER'
  const tf = opts.wireTerraformVar
    ? `
module "function" {
  environment_variables = merge(
    {
      BIFFO_CORE_API_URL = var.core_api_url
      ${varName} = var.brave_search_api_key_parameter
    },
    var.environment_variables,
  )
}
`
    : `
module "function" {
  environment_variables = merge(
    {
      BIFFO_CORE_API_URL = var.core_api_url
    },
    var.environment_variables,
  )
}
`
  writeFileSync(join(dir, 'terraform', 'main.tf'), tf)
}

describe('auditPluginToolSupply — end to end', () => {
  it('passes when the declared tool, its registry entry, and its Terraform wiring all agree', () => {
    const root = makeTmpDir('plugin-tool-supply-ok')
    writeAgentLikePlugin(root, 'agent-runtime', { wireTerraformVar: true })

    const report = auditPluginToolSupply(root)

    expect(report.ok).toBe(true)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({
      plugin: 'agent-runtime',
      tool: 'web_search',
      predicate: 'web_search_configured',
      status: 'ok',
    })
    expect(report.findings[0].requiredEnvVars).toEqual([
      'BRAVE_SEARCH_API_KEY',
      'BRAVE_SEARCH_API_KEY_PARAMETER',
    ])
  })

  it('FAIL-FIRST: reports missing-env when Terraform never wires any channel the predicate reads', () => {
    const root = makeTmpDir('plugin-tool-supply-missing')
    writeAgentLikePlugin(root, 'agent-runtime', { wireTerraformVar: false })

    const report = auditPluginToolSupply(root)

    expect(report.ok).toBe(false)
    expect(report.findings[0].status).toBe('missing-env')
    expect(report.findings[0].missingEnvVars).toEqual([
      'BRAVE_SEARCH_API_KEY',
      'BRAVE_SEARCH_API_KEY_PARAMETER',
    ])
    expect(() => assertPluginToolSupply(root)).toThrow(/MISSING-ENV/)
  })

  it('does not false-positive when Terraform wires only the OR-fallback SSM-parameter half (the real, correct shape)', () => {
    // This is deliberately the SAME shape as the "ok" test above — restated
    // to make explicit that requiring the direct-value env var too would be
    // a false positive: the real code only ever wires the parameter-name half.
    const root = makeTmpDir('plugin-tool-supply-or-fallback')
    writeAgentLikePlugin(root, 'agent-runtime', { wireTerraformVar: true })
    const report = auditPluginToolSupply(root)
    expect(report.findings[0].missingEnvVars).toEqual([])
  })

  it('CRITICAL — fails closed on an empty world rather than passing vacuously (#1374)', () => {
    const root = makeTmpDir('plugin-tool-supply-empty')
    // No plugin directories at all under root: this is exactly the
    // unparseable/no-signal input the guard must never read as "all clean".
    const report = auditPluginToolSupply(root)

    expect(report.noPluginsFound).toBe(true)
    expect(report.ok).toBe(false)
    expect(report.summary).toMatch(/NO PLUGINS FOUND/)
    expect(() => assertPluginToolSupply(root)).toThrow(/NO PLUGINS FOUND/)
  })

  it('fails closed when a plugin dir exists but has zero readable plugins (root points at a file tree with no manifests)', () => {
    const root = makeTmpDir('plugin-tool-supply-no-manifests')
    mkdirSync(join(root, 'not-a-plugin'), { recursive: true })
    writeFileSync(join(root, 'not-a-plugin', 'readme.txt'), 'nothing here')

    expect(discoverPluginDirs(root)).toEqual([])
    expect(auditPluginToolSupply(root).ok).toBe(false)
  })

  it('REGISTRY BLIND: raw ToolDefinition( call sites present but none resolve — fails, does not pass on 0/0', () => {
    const root = makeTmpDir('plugin-tool-supply-registry-blind')
    const dir = join(root, 'broken-plugin')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'terraform'), { recursive: true })
    writeFileSync(
      join(dir, 'biffo.plugin.json'),
      JSON.stringify({
        name: 'broken-plugin',
        tools: [{ name: 'web_search', description: 'd', parameters: {} }],
      }),
    )
    // An UNTERMINATED ToolDefinition( call — the extractor's balanced-paren
    // scan finds no matching close and skips it, but the raw count still saw
    // the call site. This is the blindness shape #1374 named on the sibling
    // guard: 0 extracted must never be read as "nothing to find".
    writeFileSync(
      join(dir, 'src', 'tools.py'),
      'X = ToolDefinition(name="web_search", description="d"\n# never closed',
    )
    writeFileSync(
      join(dir, 'terraform', 'main.tf'),
      'environment_variables = merge({ FOO = "bar" }, var.environment_variables)',
    )

    const report = auditPluginToolSupply(root)
    expect(report.registryBlind).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('a tool with no matching registry entry is unresolved, not silently ignored', () => {
    const root = makeTmpDir('plugin-tool-supply-unresolved-registry')
    writeAgentLikePlugin(root, 'agent-runtime', {
      wireTerraformVar: true,
      tools: [{ name: 'some_other_tool', description: 'd', parameters: {} }],
    })

    const report = auditPluginToolSupply(root)
    expect(report.ok).toBe(false)
    expect(report.findings[0].status).toBe('unresolved-registry')
  })

  it('a plugin declaring no tools contributes nothing and does not fail the audit', () => {
    const root = makeTmpDir('plugin-tool-supply-no-tools')
    const dir = join(root, 'orchestrator')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'biffo.plugin.json'), JSON.stringify({ name: 'orchestrator' }))

    const report = auditPluginToolSupply(root)
    expect(report.findings).toEqual([])
    // One real plugin was found and legitimately declares nothing to check —
    // this is not the empty-world case backstop 1 exists for.
    expect(report.noPluginsFound).toBe(false)
  })
})

// ── Against the real repo — proves the guard runs against live source, not a fixture ──

describe('auditPluginToolSupply — against this repo’s real services/_plugins', () => {
  it('reports ok:true today, and specifically resolves agent-runtime/web_search end to end', () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    const report = auditPluginToolSupply(join(repoRoot, 'services', '_plugins'))

    expect(report.noPluginsFound).toBe(false)
    expect(report.registryBlind).toBe(false)
    expect(report.terraformBlind).toBe(false)

    const webSearch = report.findings.find(
      (f) => f.plugin === 'agent-runtime' && f.tool === 'web_search',
    )
    expect(webSearch).toBeDefined()
    expect(webSearch?.predicate).toBe('web_search_configured')
    expect(webSearch?.requiredEnvVars).toContain('BRAVE_SEARCH_API_KEY_PARAMETER')
    expect(webSearch?.status).toBe('ok')

    expect(report.ok).toBe(true)
  })
})
