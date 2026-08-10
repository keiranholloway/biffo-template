import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import type { PySource } from './plugin-tool-supply-audit.js'
import {
  auditDeclaredModelIds,
  auditPluginToolSupply,
  assertPluginToolSupply,
  buildSymbolResolver,
  discoverPluginDirs,
  extractCuratedModelFields,
  extractManifestTools,
  extractPredicateEnvVars,
  extractSettingsModelFields,
  extractTerraformEnvKeys,
  extractToolRegistryEntries,
  isSnapshotStale,
  normalizeModelId,
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

// ── Half D: extractSettingsModelFields / extractCuratedModelFields ────────

describe('extractSettingsModelFields', () => {
  it('extracts a model-named string field containing a "/"', () => {
    const result = extractSettingsModelFields('agent_default_model: str = "moonshotai/kimi-k3"\n')
    expect(result).toEqual([{ field: 'agent_default_model', value: 'moonshotai/kimi-k3' }])
  })

  it('extracts more than one model field', () => {
    const result = extractSettingsModelFields(
      [
        'agent_default_model: str = "moonshotai/kimi-k3"',
        'agent_assistant_model: str = "anthropic/claude-sonnet-4"',
      ].join('\n'),
    )
    expect(result).toEqual([
      { field: 'agent_default_model', value: 'moonshotai/kimi-k3' },
      { field: 'agent_assistant_model', value: 'anthropic/claude-sonnet-4' },
    ])
  })

  it('ignores a string field with no "model" in its name — a URL is also a string with a slash', () => {
    const result = extractSettingsModelFields('database_url: str = "postgresql+asyncpg://x/y"\n')
    expect(result).toEqual([])
  })

  it('ignores a model-named field whose value has no "/" (not a provider/slug shape)', () => {
    const result = extractSettingsModelFields('agent_model_enabled: str = "true"\n')
    expect(result).toEqual([])
  })
})

describe('extractCuratedModelFields', () => {
  const FIELD = `
{
    "name": "model",
    "label": "Model",
    "type": "select",
    "required": True,
    "default": "moonshotai/kimi-k3",
    "open": True,
    "options": [
        {"value": "moonshotai/kimi-k3", "label": "Kimi K3 (low-cost default)"},
        {"value": "moonshotai/kimi-k3:online", "label": "Kimi K3 (web-connected)"},
        {"value": "anthropic/claude-opus-4.8", "label": "Claude Opus 4.8 (premium)"},
    ],
},
`

  it('extracts the default and every option value from the real field shape', () => {
    const result = extractCuratedModelFields(FIELD)
    expect(result.rawFieldCount).toBe(1)
    expect(result.fields).toEqual([
      {
        defaultValue: 'moonshotai/kimi-k3',
        optionValues: [
          'moonshotai/kimi-k3',
          'moonshotai/kimi-k3:online',
          'anthropic/claude-opus-4.8',
        ],
      },
    ])
  })

  it('scopes the window to THIS field, not a later "model"-named field', () => {
    const two = `${FIELD}\n{\n    "name": "other_field",\n    "default": "not-a-model",\n},\n`
    const result = extractCuratedModelFields(two)
    expect(result.rawFieldCount).toBe(1)
    expect(result.fields[0]?.optionValues).toContain('anthropic/claude-opus-4.8')
  })

  it('records a field with neither default nor options as empty, not dropped (blindness backstop)', () => {
    const result = extractCuratedModelFields('{\n    "name": "model",\n},\n')
    expect(result.rawFieldCount).toBe(1)
    expect(result.fields).toEqual([{ defaultValue: null, optionValues: [] }])
  })

  it('returns zero fields, zero markers when no "model" field is present', () => {
    const result = extractCuratedModelFields('{\n    "name": "agent_name",\n},\n')
    expect(result.rawFieldCount).toBe(0)
    expect(result.fields).toEqual([])
  })
})

describe('normalizeModelId', () => {
  it('strips a trailing :online — the universal, never-enumerated modifier', () => {
    expect(normalizeModelId('moonshotai/kimi-k3:online')).toBe('moonshotai/kimi-k3')
  })

  it('leaves every other colon suffix alone — those are distinct catalogue entries', () => {
    expect(normalizeModelId('anthropic/claude-opus-4.8:batch')).toBe(
      'anthropic/claude-opus-4.8:batch',
    )
    expect(normalizeModelId('openai/gpt-oss-20b:free')).toBe('openai/gpt-oss-20b:free')
  })

  it('is a no-op on a plain id', () => {
    expect(normalizeModelId('moonshotai/kimi-k3')).toBe('moonshotai/kimi-k3')
  })
})

describe('isSnapshotStale', () => {
  it('is not stale the day it was fetched', () => {
    expect(isSnapshotStale('2026-08-10T00:00:00Z', new Date('2026-08-10T12:00:00Z'))).toBe(false)
  })

  it('is stale past the max-age window', () => {
    expect(isSnapshotStale('2026-01-01T00:00:00Z', new Date('2026-08-10T00:00:00Z'))).toBe(true)
  })

  it('fails closed on an unparseable timestamp — stale, not fresh', () => {
    expect(isSnapshotStale('not-a-date', new Date())).toBe(true)
  })
})

// ── auditDeclaredModelIds ──────────────────────────────────────────────────

function writeCoreApiFixture(
  root: string,
  { configText, schemaText }: { configText: string; schemaText: string },
): void {
  const configDir = join(root, 'services', 'api', 'src', 'api')
  const schemaDir = join(configDir, 'schemas')
  mkdirSync(schemaDir, { recursive: true })
  writeFileSync(join(configDir, 'config.py'), configText)
  writeFileSync(join(schemaDir, 'orchestration.py'), schemaText)
}

const OK_CONFIG = 'agent_default_model: str = "moonshotai/kimi-k3"\n'
const OK_SCHEMA = `
{
    "name": "model",
    "default": "moonshotai/kimi-k3",
    "options": [
        {"value": "moonshotai/kimi-k3", "label": "Kimi K3"},
        {"value": "moonshotai/kimi-k3:online", "label": "Kimi K3 (web-connected)"},
    ],
},
`

describe('auditDeclaredModelIds', () => {
  const knownModelIds = ['moonshotai/kimi-k3', 'anthropic/claude-opus-4.8']
  const snapshotFetchedAt = '2026-08-10T00:00:00Z'
  const now = new Date('2026-08-10T12:00:00Z')

  it('passes when every declared id (and its :online variant) is in the snapshot', () => {
    const root = makeTmpDir('model-id-ok')
    writeCoreApiFixture(root, { configText: OK_CONFIG, schemaText: OK_SCHEMA })

    const report = auditDeclaredModelIds(root, { knownModelIds, snapshotFetchedAt, now })
    expect(report.ok).toBe(true)
    expect(report.findings.every((f) => f.status === 'ok')).toBe(true)
    // 1 settings field + 1 curated default + 2 curated options (kimi-k3, kimi-k3:online) — the
    // :online entry is its own finding, normalized against its base id when checked, not skipped.
    expect(report.findings.length).toBe(4)
  })

  it('CRITICAL — fails on the real reported incident: a well-formed but wrong slug (#822)', () => {
    // The exact shape #822 was filed over: "anthropic/claude-opus-4-8" (dashed)
    // is a plausible-looking provider/slug string that OpenRouter never served
    // — the real id is dotted, "anthropic/claude-opus-4.8". Format validation
    // alone would never catch this; only a real catalogue comparison does.
    const root = makeTmpDir('model-id-bogus')
    const bogusSchema = OK_SCHEMA.replace(
      /"options": \[/,
      '"options": [\n        {"value": "anthropic/claude-opus-4-8", "label": "Claude Opus 4.8 (premium)"},',
    )
    writeCoreApiFixture(root, { configText: OK_CONFIG, schemaText: bogusSchema })

    const report = auditDeclaredModelIds(root, { knownModelIds, snapshotFetchedAt, now })
    expect(report.ok).toBe(false)
    const bad = report.findings.find((f) => f.modelId === 'anthropic/claude-opus-4-8')
    expect(bad?.status).toBe('unknown-model')
    expect(bad?.detail).toMatch(/NOT in the OpenRouter snapshot/)
  })

  it('fails closed when config.py is missing entirely', () => {
    const root = makeTmpDir('model-id-no-config')
    const schemaDir = join(root, 'services', 'api', 'src', 'api', 'schemas')
    mkdirSync(schemaDir, { recursive: true })
    writeFileSync(join(schemaDir, 'orchestration.py'), OK_SCHEMA)

    const report = auditDeclaredModelIds(root, { knownModelIds, snapshotFetchedAt, now })
    expect(report.configMissing).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('SETTINGS EXTRACTOR BLIND: config.py exists but resolves no model field — fails, not "no default"', () => {
    const root = makeTmpDir('model-id-settings-blind')
    writeCoreApiFixture(root, {
      configText: 'database_url: str = "postgresql+asyncpg://x/y"\n',
      schemaText: OK_SCHEMA,
    })

    const report = auditDeclaredModelIds(root, { knownModelIds, snapshotFetchedAt, now })
    expect(report.settingsBlind).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('CURATED-OPTIONS EXTRACTOR BLIND: a "model" field with no default/options resolved — fails', () => {
    const root = makeTmpDir('model-id-curated-blind')
    writeCoreApiFixture(root, {
      configText: OK_CONFIG,
      schemaText: '{\n    "name": "model",\n},\n',
    })

    const report = auditDeclaredModelIds(root, { knownModelIds, snapshotFetchedAt, now })
    expect(report.curatedFieldsBlind).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('fails closed on an empty snapshot rather than passing vacuously', () => {
    const root = makeTmpDir('model-id-empty-snapshot')
    writeCoreApiFixture(root, { configText: OK_CONFIG, schemaText: OK_SCHEMA })

    const report = auditDeclaredModelIds(root, { knownModelIds: [], snapshotFetchedAt, now })
    expect(report.snapshotEmpty).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('fails closed on a stale snapshot rather than trusting it forever', () => {
    const root = makeTmpDir('model-id-stale-snapshot')
    writeCoreApiFixture(root, { configText: OK_CONFIG, schemaText: OK_SCHEMA })

    const report = auditDeclaredModelIds(root, {
      knownModelIds,
      snapshotFetchedAt: '2026-01-01T00:00:00Z',
      now,
    })
    expect(report.snapshotStale).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('a declared :online variant is checked against its base id, not rejected as unknown', () => {
    const root = makeTmpDir('model-id-online-variant')
    const onlineOnlySchema = `
{
    "name": "model",
    "default": "moonshotai/kimi-k3:online",
    "options": [
        {"value": "moonshotai/kimi-k3:online", "label": "Kimi K3 (web-connected)"},
    ],
},
`
    writeCoreApiFixture(root, { configText: OK_CONFIG, schemaText: onlineOnlySchema })

    const report = auditDeclaredModelIds(root, { knownModelIds, snapshotFetchedAt, now })
    expect(report.ok).toBe(true)
  })
})

describe('auditDeclaredModelIds — against this repo’s real services/api', () => {
  it('reports ok:true today against the live OpenRouter snapshot', () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    const report = auditDeclaredModelIds(repoRoot)

    expect(report.configMissing).toBe(false)
    expect(report.orchestrationSchemaMissing).toBe(false)
    expect(report.settingsBlind).toBe(false)
    expect(report.curatedFieldsBlind).toBe(false)
    expect(report.snapshotEmpty).toBe(false)

    const bad = report.findings.filter((f) => f.status !== 'ok')
    expect(bad).toEqual([])
    expect(report.ok).toBe(true)
  })
})
