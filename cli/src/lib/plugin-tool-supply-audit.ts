/**
 * Does a plugin's declared tool actually have somewhere to get what it needs? (#822)
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * A plugin's `biffo.plugin.json` declares the tools it uses (`tools[].name`,
 * ADR-0014 §7). The runtime that executes it registers each name against a
 * `ToolDefinition` with an `is_available` predicate — a credential check, in
 * every case that exists today (`agent_runtime.tools.WEB_SEARCH`'s
 * `web_search_configured`). That predicate reads one or more environment
 * variables, and the ONLY place those variables are ever set is the plugin's
 * own Terraform (`environment_variables` on its Lambda). **Nothing compares
 * the three.** A manifest can declare a tool, the runtime can register it,
 * and the Terraform can simply never wire the credential the predicate reads
 * — at which point `is_available()` returns `false` on every invocation, for
 * ever, in every environment, and the only symptom is a worker quietly
 * losing a capability it was told it had (issue #822's `web_search` incident:
 * the runtime's own design is correct — "unconfigured means not offered, not
 * broken" — the missing piece was ever finding out).
 *
 * This is a `class:fail-open` instance of #1364: three artifacts, three
 * different files, three different owners in effect (the plugin author who
 * writes the manifest, the runtime author who writes the registry, the infra
 * author who writes the Terraform), and no single test that has ever read
 * all three. `core-direct-paths-audit.ts` (#1377) is the house precedent this
 * follows: read every half from its OWN authoritative source, never a
 * hand-maintained mirror, and make an unresolvable input FAIL rather than
 * silently pass (#1363, #1374).
 *
 * ── Why identifiers, not literals, have to be resolved ──────────────────────
 *
 * None of the three artifacts write the tool name or the env var name as a
 * literal at the point this guard would naively look for one:
 *
 *   - `ToolDefinition(name=WEB_SEARCH_NAME, ..., is_available=web_search_configured)`
 *     — the tool's name is a module constant, not an inline string, and
 *     `is_available` is a bare function reference.
 *   - `web_search_configured()` reads `os.environ.get(_KEY_ENV, "")`, where
 *     `_KEY_ENV = "BRAVE_SEARCH_API_KEY"` is itself a constant defined
 *     elsewhere in the same module.
 *
 * A regex hunting for `os.environ.get("BRAVE_SEARCH_API_KEY")` would find
 * nothing in this codebase and report a clean pass on total blindness. This
 * module resolves both indirections: it builds a symbol table of
 * `NAME = "literal"` assignments across every `.py` file in a plugin
 * directory, then substitutes through it wherever `ToolDefinition(name=...)`
 * or an `os.environ.get(...)`-family call names a bare identifier instead of
 * a string.
 *
 * ── Unresolvable input FAILS, it never silently passes (#1363, #1374) ──────
 *
 * Four independent backstops, because the class this guard closes is
 * specifically "both halves are green and the capability is dead":
 *
 * 1. **No plugins found at all.** An empty or missing `pluginsRoot` is not
 *    "nothing to check" — it is "the check could not run" — and
 *    `auditPluginToolSupply` fails on it rather than reporting a vacuous
 *    `ok: true`.
 * 2. **Registry blindness.** If a plugin's Python source contains one or more
 *    `ToolDefinition(` call sites (a raw, unparsed count) but the extractor
 *    resolved zero entries, that is the extractor breaking, not the plugin
 *    registering nothing — flagged and failed, mirroring
 *    `core-direct-paths-audit.ts`'s `coreBlind`.
 * 3. **Terraform blindness.** Same shape for `environment_variables`: present
 *    in the raw text but zero keys extracted is a broken extractor, not an
 *    empty Lambda.
 * 4. **Per-item unresolved.** A declared tool with no matching registry
 *    entry, a registry entry whose `is_available` predicate can't be found
 *    anywhere in the plugin's source, or a predicate whose env-var argument
 *    is a bare identifier absent from the symbol table, is recorded as
 *    `unresolved-*` and counted as a failure — never dropped from the
 *    denominator (AGENTS.md §2's `staging`-branch lesson, restated for this
 *    guard).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  OPENROUTER_MODEL_IDS,
  OPENROUTER_MODEL_SNAPSHOT_FETCHED_AT,
} from './openrouter-model-snapshot.js'

// ── Shared small helpers ────────────────────────────────────────────────────

function listDirs(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries
    .filter((e) => {
      try {
        return statSync(join(root, e)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

function walkFiles(
  root: string,
  accept: (entry: string) => boolean,
  skipDir: (entry: string) => boolean,
): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (skipDir(entry)) continue
        walk(p)
        continue
      }
      if (accept(entry)) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** Every `.py` file under a plugin directory, test modules and caches excluded —
 * mirrors `core-direct-paths-audit.ts`'s `coreSourceFiles` exclusions. */
export function pluginPythonFiles(pluginDir: string): string[] {
  return walkFiles(
    pluginDir,
    (entry) => entry.endsWith('.py') && !entry.startsWith('test_') && !entry.endsWith('_test.py'),
    (entry) => entry === 'tests' || entry === '__pycache__' || entry === 'terraform',
  )
}

/** Every `.tf` file directly under `<pluginDir>/terraform/` — Terraform is not
 * recursed beyond that one directory because every plugin here keeps its whole
 * module flat (verified against `orchestrator/terraform/` and
 * `agent-runtime/terraform/`, both single-directory). */
export function pluginTerraformFiles(pluginDir: string): string[] {
  const tfDir = join(pluginDir, 'terraform')
  let entries: string[]
  try {
    entries = readdirSync(tfDir)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.endsWith('.tf'))
    .map((e) => join(tfDir, e))
    .sort()
}

// ── Half A: what the manifest declares ──────────────────────────────────────

export interface ManifestToolExtraction {
  tools: string[]
  parseError: string | null
}

/** `tools[].name` from a `biffo.plugin.json` body. A `tools` array entry that
 * is neither a bare string nor an object with a string `name` is a parse
 * failure, not a skip — see the module docstring's backstop 4. An absent
 * `tools` key legitimately means "declares no tools" (`declared_tools()`'s
 * own default-deny posture, `agent_runtime/tools.py`), so that alone is not
 * an error. */
export function extractManifestTools(manifestText: string): ManifestToolExtraction {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch (exc) {
    return { tools: [], parseError: `invalid JSON: ${(exc as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { tools: [], parseError: 'manifest is not a JSON object' }
  }
  const raw = (parsed as Record<string, unknown>).tools
  if (raw === undefined) return { tools: [], parseError: null }
  if (!Array.isArray(raw))
    return { tools: [], parseError: '"tools" is present but is not an array' }

  const tools: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      tools.push(entry.trim())
      continue
    }
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).name === 'string' &&
      ((entry as Record<string, unknown>).name as string).trim()
    ) {
      tools.push(((entry as Record<string, unknown>).name as string).trim())
      continue
    }
    return {
      tools: [],
      parseError: `a "tools" entry has no resolvable string name: ${JSON.stringify(entry)}`,
    }
  }
  return { tools, parseError: null }
}

// ── Symbol resolution across a plugin's Python source ───────────────────────

export interface PySource {
  file: string
  text: string
}

/** `NAME = "literal"` (optionally type-annotated, optionally trailed by a
 * comment) at the start of a line. Deliberately anchored to line-start so a
 * docstring merely mentioning `NAME = "..."` in prose is unlikely to match —
 * this is a heuristic, not a parser, matched to how this codebase actually
 * writes constants (verified against `agent_runtime/search.py`,
 * `openrouter.py` and `tools.py`). */
const ASSIGNMENT =
  /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][\w.[\], ]*)?\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gm

function unquote(literal: string): string {
  return literal.slice(1, -1)
}

function isStringLiteral(token: string): boolean {
  return /^"(?:[^"\\]|\\.)*"$/.test(token) || /^'(?:[^'\\]|\\.)*'$/.test(token)
}

/** Resolves a bare identifier to the literal string it was assigned, scoped
 * PER FILE FIRST, falling back to a cross-file table only when the file that
 * referenced the name does not itself define it.
 *
 * This two-tier order exists because of a real, load-bearing naming
 * collision in this codebase: `agent_runtime/search.py` and
 * `agent_runtime/openrouter.py` each define their OWN private
 * `_KEY_ENV`/`_KEY_PARAMETER_ENV` constants — same identifiers, deliberately
 * different values (Brave's vs OpenRouter's credential env var names), never
 * imported between the two modules (the leading underscore is Python's own
 * "module-private" convention). A single merged table resolves whichever
 * definition happened to be read first, silently attributing OpenRouter's
 * env vars to the Brave predicate — this was caught by this guard's own
 * self-test against `services/_plugins` before it ever shipped, and is
 * exactly the kind of miscount #1364-shaped guards must not introduce while
 * fixing one.
 *
 * The cross-file fallback still matters: `tools.py` never assigns
 * `WEB_SEARCH_NAME`, only imports it (`from .search import WEB_SEARCH_NAME`),
 * so resolving a `ToolDefinition(name=WEB_SEARCH_NAME, ...)` kwarg needs
 * `search.py`'s table. If the SAME name resolves to two DIFFERENT values in
 * two different files and the referencing file doesn't define it locally,
 * that is genuinely ambiguous — resolved as unresolved (`null`), never
 * guessed. */
export class SymbolResolver {
  constructor(
    private readonly perFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
    private readonly merged: ReadonlyMap<string, string | null>,
  ) {}

  resolve(token: string, file: string): string | null {
    const trimmed = token.trim()
    if (isStringLiteral(trimmed)) return unquote(trimmed)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return null
    const local = this.perFile.get(file)
    if (local?.has(trimmed)) return local.get(trimmed) as string
    const cross = this.merged.get(trimmed)
    return typeof cross === 'string' ? cross : null
  }
}

export function buildSymbolResolver(sources: readonly PySource[]): SymbolResolver {
  const perFile = new Map<string, Map<string, string>>()
  const merged = new Map<string, string | null>()
  for (const { file, text } of sources) {
    const table = new Map<string, string>()
    ASSIGNMENT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ASSIGNMENT.exec(text)) !== null) {
      // Both capture groups are mandatory (not `(...)?`) in ASSIGNMENT, so a
      // successful match always populates them — `as string` states that,
      // it does not assume it.
      const [ident, literal] = [m[1] as string, m[2] as string]
      // First assignment in a file wins for that file's own table — every
      // constant this guard resolves is written exactly once at module scope
      // in this codebase; a genuine reassignment would make the source
      // itself ambiguous.
      if (!table.has(ident)) table.set(ident, unquote(literal))
    }
    perFile.set(file, table)
    for (const [name, value] of table) {
      if (!merged.has(name)) merged.set(name, value)
      else if (merged.get(name) !== value) merged.set(name, null) // conflicting definitions: ambiguous
    }
  }
  return new SymbolResolver(perFile, merged)
}

// ── Half B: what the runtime registers, and what it needs to run ───────────

export interface RegistryToolEntry {
  /** Resolved tool name, or `null` if the `name=` kwarg named an identifier
   * absent from the symbol table. */
  name: string | null
  /** The `is_available` predicate's identifier (last dotted segment), or
   * `null` when the kwarg is absent — meaning unconditionally available,
   * the registry's own default (`_always_available`, `tools.py`). */
  predicate: string | null
  unresolvedReason: string | null
}

export interface RegistryExtraction {
  entries: RegistryToolEntry[]
  /** Raw `ToolDefinition(` occurrence count, unparsed — the blindness backstop. */
  rawToolDefinitionCount: number
}

function balancedSpanFrom(
  text: string,
  openIndex: number,
  openCh: string,
  closeCh: string,
): number | null {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === openCh) depth += 1
    else if (text[i] === closeCh) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

const NAME_KWARG = /\bname\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*)\s*,/
const IS_AVAILABLE_KWARG = /\bis_available\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,?/

/** Every `ToolDefinition(...)` call site across a plugin's Python source
 * files, with `name=` and `is_available=` resolved through `resolver` —
 * file-local first, so a name defined in the SAME file as the call site
 * always wins over a same-named constant elsewhere (see `SymbolResolver`). */
export function extractToolRegistryEntries(
  sources: readonly PySource[],
  resolver: SymbolResolver,
): RegistryExtraction {
  const entries: RegistryToolEntry[] = []
  let rawToolDefinitionCount = 0
  for (const { file, text } of sources) {
    const callSite = /ToolDefinition\s*\(/g
    let m: RegExpExecArray | null
    while ((m = callSite.exec(text)) !== null) {
      rawToolDefinitionCount += 1
      const openIdx = m.index + m[0].length - 1
      const closeIdx = balancedSpanFrom(text, openIdx, '(', ')')
      if (closeIdx === null) continue
      const inner = text.slice(openIdx + 1, closeIdx)

      const nameMatch = NAME_KWARG.exec(inner)
      if (!nameMatch) {
        entries.push({
          name: null,
          predicate: null,
          unresolvedReason: `ToolDefinition(...) call in ${file} has no resolvable \`name=\` kwarg`,
        })
        continue
      }
      // NAME_KWARG's single capture group is mandatory too.
      const resolvedName = resolver.resolve(nameMatch[1] as string, file)
      if (resolvedName === null) {
        entries.push({
          name: null,
          predicate: null,
          unresolvedReason: `name=${nameMatch[1]} in ${file} is an identifier absent from (or ambiguous in) the symbol table`,
        })
        continue
      }

      const availMatch = IS_AVAILABLE_KWARG.exec(inner)
      if (!availMatch) {
        // No is_available kwarg at all: the registry's own default is
        // "_always_available" (tools.py) — unconditionally available, nothing
        // to cross-check against Terraform.
        entries.push({ name: resolvedName, predicate: null, unresolvedReason: null })
        continue
      }
      const dotted = availMatch[1] as string // mandatory capture group
      const predicate = dotted.includes('.') ? (dotted.split('.').pop() as string) : dotted
      entries.push({ name: resolvedName, predicate, unresolvedReason: null })
    }
  }
  return { entries, rawToolDefinitionCount }
}

const ENV_READ =
  /\bos\.(?:environ\.get|getenv)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*)|\bos\.environ\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*)\s*\]/g

export interface PredicateEnvVars {
  /** `false` when `def <predicate>(` was never found in ANY of the plugin's
   * source files — a stronger failure than "found the function, could not
   * resolve one of its env var tokens". */
  predicateFound: boolean
  /** Resolved env var names the predicate's body reads. */
  envVars: string[]
  /** Tokens the predicate's body read from `os.environ`/`os.getenv` that
   * were bare identifiers absent from (or ambiguous in) the symbol table —
   * unresolved, never silently dropped. */
  unresolvedTokens: string[]
}

/** The env vars a predicate function's body reads via `os.environ.get(...)`,
 * `os.environ[...]`, or `os.getenv(...)`, resolving bare-identifier
 * arguments through `resolver` exactly as `extractToolRegistryEntries` does
 * for `ToolDefinition(name=...)` — the same indirection, the same fix,
 * file-local-first for the same reason (`_KEY_ENV` means something different
 * in `search.py` than in `openrouter.py`). `def <predicate>(` is searched for
 * across every source file in order; the body is taken from the match to the
 * next top-level (unindented) `def `/`class ` or end of that file. Nested
 * functions inside it are included, which is intentionally generous —
 * missing a real env read is worse than over-including one from a genuinely
 * nested helper. */
export function extractPredicateEnvVars(
  sources: readonly PySource[],
  predicate: string,
  resolver: SymbolResolver,
): PredicateEnvVars {
  const defPattern = new RegExp(`^def\\s+${predicate}\\s*\\(`, 'm')
  let found: { file: string; body: string } | null = null
  for (const { file, text } of sources) {
    const defMatch = defPattern.exec(text)
    if (!defMatch) continue
    const bodyStart = defMatch.index + defMatch[0].length
    const rest = text.slice(bodyStart)
    const nextTopLevel = /^(?:def |class )/m.exec(rest)
    found = { file, body: nextTopLevel ? rest.slice(0, nextTopLevel.index) : rest }
    break
  }
  if (!found) return { predicateFound: false, envVars: [], unresolvedTokens: [] }

  const envVars = new Set<string>()
  const unresolvedTokens = new Set<string>()
  ENV_READ.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ENV_READ.exec(found.body)) !== null) {
    // ENV_READ's two alternatives each own one capture group; whichever
    // branch matched populated exactly one of them, so this is never both
    // undefined once the regex has matched at all.
    const token = (m[1] ?? m[2]) as string
    const resolved = resolver.resolve(token, found.file)
    if (resolved === null) unresolvedTokens.add(token)
    else envVars.add(resolved)
  }
  return {
    predicateFound: true,
    envVars: [...envVars].sort(),
    unresolvedTokens: [...unresolvedTokens].sort(),
  }
}

// ── Half C: what Terraform actually wires ───────────────────────────────────

export interface TerraformEnvExtraction {
  keys: string[]
  /** Number of `environment_variables = ` markers whose value expression could
   * not be located at all — the terraform-side blindness signal. */
  rawMarkerCount: number
  resolvedBlockCount: number
}

/** Every key set inside an `environment_variables = { ... }` or
 * `environment_variables = merge({ ... }, ...)` expression — depth-tracked
 * across BOTH `{}` and `()` jointly (real shape: `merge(` opens a paren, its
 * first argument opens a brace, both must close before the expression ends),
 * mirroring `core-direct-paths-audit.ts`'s balanced-span approach for
 * `APIRouter(...)`. */
export function extractTerraformEnvKeys(tfText: string): TerraformEnvExtraction {
  const keys = new Set<string>()
  let resolvedBlockCount = 0
  let rawMarkerCount = 0
  const marker = /environment_variables\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = marker.exec(tfText)) !== null) {
    rawMarkerCount += 1
    // The value expression is either a bracket directly (`{ ... }`) or a
    // function call whose FIRST bracket is what nests the keys (`merge(\n {
    // ... }, ...)`, the real shape every plugin here uses) — so scan past an
    // optional bare identifier (`merge`, dotted attrs are not used here) to
    // find the first `{` or `(`, but never past the end of this statement's
    // own line: a value with no bracket on its first line at all
    // (`environment_variables = var.some_map`) is exactly the "nothing to
    // extract" shape the blindness backstop below must catch, not something
    // to go hunting for further down the file.
    let openIdx = m.index + m[0].length
    while (openIdx < tfText.length) {
      const ch = tfText.charAt(openIdx) // '' past the end; never undefined
      if (ch === '{' || ch === '(') break
      if (ch === '\n' || !/[\s.A-Za-z0-9_]/.test(ch)) {
        openIdx = -1
        break
      }
      openIdx += 1
    }
    if (openIdx === -1 || openIdx >= tfText.length) continue
    const openCh = tfText.charAt(openIdx)
    const closeCh = openCh === '{' ? '}' : ')'
    const endIdx = balancedSpanFrom(tfText, openIdx, openCh, closeCh)
    if (endIdx === null) continue
    resolvedBlockCount += 1
    const inner = tfText.slice(openIdx, endIdx + 1)
    const keyPattern = /^\s*([A-Z][A-Z0-9_]*)\s*=/gm
    let km: RegExpExecArray | null
    while ((km = keyPattern.exec(inner)) !== null) {
      keys.add(km[1] as string) // mandatory capture group
    }
  }
  return { keys: [...keys].sort(), rawMarkerCount, resolvedBlockCount }
}

// ── Half D: what model ids are declared, checked against a provider snapshot ─
//
// The other half of #822 (the model-id half — see the module docstring atop
// this file, which pre-dates this section and describes only the tool-supply
// half #1409 shipped): "validate model ids against the provider's live model
// list." The incident's second half — `ideation`'s analyst running on
// `anthropic/claude-opus-4-8`, a slug OpenRouter has never served, one
// character off from the real `anthropic/claude-opus-4.8` — is NOT a plugin
// manifest declaration the way a tool is. `agent-runtime` never picks a
// model; it reads whatever `definition_snapshot.model` names at run time
// (`agent_runtime/plugin.py`), which is operator-authored data in Core's
// database, not a static file this guard can read. What IS static, and what
// this repo's own incident sits inside, is the CURATED catalogue an author
// picks from and the platform-wide DEFAULT a run falls back to — both live in
// `services/api/`, not `services/_plugins/`:
//
//   - `services/api/src/api/config.py` — `Settings` fields whose name
//     signals a model id (`agent_default_model`, `agent_assistant_model`)
//     and whose value is a plain string default.
//   - `services/api/src/api/schemas/orchestration.py` — the "agent" action
//     type's `model` config field: a `default` value and a curated `select`
//     `options` list. `open: True` marks it a suggestion list rather than an
//     enforced allowlist (an author may run any OpenRouter model, and an
//     agent already saved with an off-list model is never rejected on a
//     later save — see that field's own comment), but a WRONG id sitting in
//     the suggestion list itself is exactly this guard's business: it is
//     offered to every author as a working choice.
//
// Checked against a committed snapshot of OpenRouter's real catalogue
// (`openrouter-model-snapshot.ts` — see that file for why a snapshot rather
// than a live call), never live network from here. Same fail-closed-on-zero
// posture as Halves A–C: a source file present but yielding nothing
// extractable is a broken extractor, not "nothing to check" (`settingsBlind`,
// `curatedFieldsBlind`); a stale or empty snapshot fails closed rather than
// being trusted forever (`snapshotStale`, `snapshotEmpty`).

const SETTINGS_STR_FIELD = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*str\s*=\s*"([^"]*)"/gm

export interface SettingsModelField {
  field: string
  value: string
}

/** Every `Settings` field whose OWN NAME signals a model id (contains
 * "model") and whose plain string default contains a "/" — the
 * `provider/slug` shape every model id in this codebase takes. Scoped to
 * fields named for a model, rather than every string field with a slash,
 * because `config.py` holds plenty of those that are not model ids
 * (`database_url`, `agent_runtime_function_name`, ...). */
export function extractSettingsModelFields(text: string): SettingsModelField[] {
  const out: SettingsModelField[] = []
  SETTINGS_STR_FIELD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SETTINGS_STR_FIELD.exec(text)) !== null) {
    const [field, value] = [m[1] as string, m[2] as string]
    if (field.toLowerCase().includes('model') && value.includes('/')) {
      out.push({ field, value })
    }
  }
  return out
}

const MODEL_FIELD_NAME_MARKER = /"name"\s*:\s*"model"/g
const FIELD_DEFAULT = /"default"\s*:\s*"([^"]*)"/
const FIELD_OPTIONS_START = /"options"\s*:\s*\[/
const OPTION_VALUE = /"value"\s*:\s*"([^"]*)"/g

export interface CuratedModelField {
  defaultValue: string | null
  optionValues: string[]
}

export interface CuratedModelFieldExtraction {
  /** Number of `"name": "model"` markers found, unparsed — the blindness
   * signal, same shape as `rawToolDefinitionCount`/`rawMarkerCount` above. */
  rawFieldCount: number
  fields: CuratedModelField[]
}

/** Every `{"name": "model", ..., "default": "...", "options": [{"value":
 * "...", ...}, ...]}` config-field object in an `orchestration.py`-shaped
 * source — the curated `select` an author picks a model from. Scoping: from
 * each `"name": "model"` marker, the window searched for `"default"` and
 * `"options"` ends at the NEXT `"name"` key (or end of text) — since every
 * field in this schema's list is its own `{"name": ..., ...}` object with
 * "name" as its first key, that boundary is the enclosing object's own end
 * without needing a full JSON/Python parse (mirrors this file's existing
 * balanced-span approach in Half C, applied to a textual window instead of a
 * bracket pair). */
export function extractCuratedModelFields(text: string): CuratedModelFieldExtraction {
  const fields: CuratedModelField[] = []
  let rawFieldCount = 0
  MODEL_FIELD_NAME_MARKER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MODEL_FIELD_NAME_MARKER.exec(text)) !== null) {
    rawFieldCount += 1
    const start = m.index + m[0].length
    const nextNameIdx = text.indexOf('"name"', start)
    const windowEnd = nextNameIdx === -1 ? text.length : nextNameIdx
    const window = text.slice(start, windowEnd)

    const defaultMatch = FIELD_DEFAULT.exec(window)
    const defaultValue = defaultMatch ? (defaultMatch[1] as string) : null

    const optionsMatch = FIELD_OPTIONS_START.exec(window)
    const optionValues: string[] = []
    if (optionsMatch) {
      const openIdx = start + optionsMatch.index + optionsMatch[0].length - 1
      const closeIdx = balancedSpanFrom(text, openIdx, '[', ']')
      if (closeIdx !== null) {
        const inner = text.slice(openIdx, closeIdx + 1)
        OPTION_VALUE.lastIndex = 0
        let om: RegExpExecArray | null
        while ((om = OPTION_VALUE.exec(inner)) !== null) {
          optionValues.push(om[1] as string)
        }
      }
    }
    fields.push({ defaultValue, optionValues })
  }
  return { rawFieldCount, fields }
}

/** How stale, in days, a committed snapshot may be before the guard refuses
 * to trust it. Forces a periodic `refresh-openrouter-model-snapshot.ts` run
 * rather than letting the committed list age out silently — the same
 * fail-open shape #822 is filed under, one level further out: a snapshot
 * nobody ever revisits is a declaration checked by nobody, same as the tool
 * grant this guard's Halves A–C exist for. */
export const MODEL_SNAPSHOT_MAX_AGE_DAYS = 45

export function isSnapshotStale(fetchedAt: string, now: Date): boolean {
  const fetchedMs = new Date(fetchedAt).getTime()
  if (Number.isNaN(fetchedMs)) return true // unparseable timestamp: fail closed, not open
  const ageMs = now.getTime() - fetchedMs
  return ageMs > MODEL_SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
}

/** Strips OpenRouter's universal `:online` request-time modifier before a
 * catalogue lookup. `:online` can be appended to ANY model slug to request
 * the web-search-grounded variant and is never itself an enumerated
 * catalogue entry — confirmed against a real fetch of
 * `GET https://openrouter.ai/api/v1/models` on 2026-08-10: zero of 400 ids
 * carried it. Every OTHER colon suffix this codebase's snapshot holds
 * (`:free`, `:batch`, `:thinking`, ...) names a genuinely distinct catalogue
 * entry with its own id and pricing, and is matched literally — stripping
 * those too would make an audit of a `:batch`-only slug read as "ok" against
 * the un-suffixed id, which is a real but different thing. */
export function normalizeModelId(id: string): string {
  return id.endsWith(':online') ? id.slice(0, -':online'.length) : id
}

const CONFIG_PY_PATH = join('services', 'api', 'src', 'api', 'config.py')
const ORCHESTRATION_SCHEMA_PATH = join(
  'services',
  'api',
  'src',
  'api',
  'schemas',
  'orchestration.py',
)

export interface ModelIdFinding {
  source: string
  modelId: string
  normalizedModelId: string
  status: 'ok' | 'unknown-model'
  detail: string
}

export interface ModelIdAuditReport {
  configPath: string
  orchestrationSchemaPath: string
  configMissing: boolean
  orchestrationSchemaMissing: boolean
  settingsBlind: boolean
  curatedFieldsBlind: boolean
  snapshotFetchedAt: string
  snapshotModelCount: number
  snapshotEmpty: boolean
  snapshotStale: boolean
  findings: ModelIdFinding[]
  ok: boolean
  summary: string
}

export interface ModelIdAuditOptions {
  /** Defaults to the committed `OPENROUTER_MODEL_IDS` snapshot — overridden
   * in tests so they never depend on, or need updating for, the live
   * catalogue's contents. */
  knownModelIds?: readonly string[]
  snapshotFetchedAt?: string
  now?: Date
}

/** Reads `config.py` and `schemas/orchestration.py` under `repoRoot`,
 * extracts every statically-declared model id, and checks each (after
 * stripping a trailing `:online`) against the known-id snapshot. Fails
 * closed — never silently passes — on: either source file missing, either
 * extractor finding its marker but resolving nothing (blind), an empty
 * snapshot, a stale snapshot, or any declared id absent from the snapshot. */
export function auditDeclaredModelIds(
  repoRoot: string,
  options: ModelIdAuditOptions = {},
): ModelIdAuditReport {
  const knownModelIds = options.knownModelIds ?? OPENROUTER_MODEL_IDS
  const snapshotFetchedAt = options.snapshotFetchedAt ?? OPENROUTER_MODEL_SNAPSHOT_FETCHED_AT
  const now = options.now ?? new Date()

  const configPath = join(repoRoot, CONFIG_PY_PATH)
  const orchestrationPath = join(repoRoot, ORCHESTRATION_SCHEMA_PATH)
  const configMissing = !existsSync(configPath)
  const orchestrationSchemaMissing = !existsSync(orchestrationPath)

  const knownSet = new Set(knownModelIds)
  const snapshotEmpty = knownModelIds.length === 0
  const snapshotStale = isSnapshotStale(snapshotFetchedAt, now)

  const findings: ModelIdFinding[] = []
  const record = (source: string, rawValue: string): void => {
    const normalized = normalizeModelId(rawValue)
    const ok = knownSet.has(normalized)
    findings.push({
      source,
      modelId: rawValue,
      normalizedModelId: normalized,
      status: ok ? 'ok' : 'unknown-model',
      detail: ok
        ? `"${rawValue}" is in the OpenRouter snapshot (${knownModelIds.length} id(s), fetched ${snapshotFetchedAt})`
        : `"${rawValue}" (normalized "${normalized}") is NOT in the OpenRouter snapshot (${knownModelIds.length} id(s), fetched ${snapshotFetchedAt}) — either the slug is wrong or the snapshot needs a refresh`,
    })
  }

  let settingsBlind = false
  if (!configMissing) {
    const settingsFields = extractSettingsModelFields(readFileSync(configPath, 'utf8'))
    if (settingsFields.length === 0) settingsBlind = true
    for (const { field, value } of settingsFields) record(`${CONFIG_PY_PATH}#${field}`, value)
  }

  let curatedFieldsBlind = false
  if (!orchestrationSchemaMissing) {
    const curated = extractCuratedModelFields(readFileSync(orchestrationPath, 'utf8'))
    if (
      curated.rawFieldCount > 0 &&
      curated.fields.every((f) => f.defaultValue === null && f.optionValues.length === 0)
    ) {
      curatedFieldsBlind = true
    }
    curated.fields.forEach((field, i) => {
      if (field.defaultValue !== null) {
        record(`${ORCHESTRATION_SCHEMA_PATH}#model[${i}].default`, field.defaultValue)
      }
      field.optionValues.forEach((v, j) => {
        record(`${ORCHESTRATION_SCHEMA_PATH}#model[${i}].options[${j}]`, v)
      })
    })
  }

  const badFindings = findings.filter((f) => f.status !== 'ok')
  const ok =
    !configMissing &&
    !orchestrationSchemaMissing &&
    !settingsBlind &&
    !curatedFieldsBlind &&
    !snapshotEmpty &&
    !snapshotStale &&
    badFindings.length === 0

  const summaryParts = [
    `${findings.length} declared model id(s) checked against ${knownModelIds.length} known OpenRouter id(s) (snapshot fetched ${snapshotFetchedAt})`,
    `${badFindings.length} not ok`,
  ]
  if (configMissing) summaryParts.push(`MISSING ${CONFIG_PY_PATH}`)
  if (orchestrationSchemaMissing) summaryParts.push(`MISSING ${ORCHESTRATION_SCHEMA_PATH}`)
  if (settingsBlind) summaryParts.push('SETTINGS EXTRACTOR BLIND')
  if (curatedFieldsBlind) summaryParts.push('CURATED-OPTIONS EXTRACTOR BLIND')
  if (snapshotEmpty) summaryParts.push('SNAPSHOT EMPTY')
  if (snapshotStale)
    summaryParts.push(
      `SNAPSHOT STALE (older than ${MODEL_SNAPSHOT_MAX_AGE_DAYS}d — run refresh-openrouter-model-snapshot.ts)`,
    )

  return {
    configPath: CONFIG_PY_PATH,
    orchestrationSchemaPath: ORCHESTRATION_SCHEMA_PATH,
    configMissing,
    orchestrationSchemaMissing,
    settingsBlind,
    curatedFieldsBlind,
    snapshotFetchedAt,
    snapshotModelCount: knownModelIds.length,
    snapshotEmpty,
    snapshotStale,
    findings,
    ok,
    summary: summaryParts.join('; '),
  }
}

// ── The whole audit ──────────────────────────────────────────────────────────

export interface PluginToolSupplyFinding {
  plugin: string
  tool: string
  predicate: string | null
  requiredEnvVars: string[]
  missingEnvVars: string[]
  status:
    'ok' | 'missing-env' | 'unresolved-registry' | 'unresolved-predicate' | 'unresolved-env-token'
  detail: string
}

export interface PluginToolSupplyReport {
  pluginsRoot: string
  plugins: string[]
  findings: PluginToolSupplyFinding[]
  registryBlind: boolean
  terraformBlind: boolean
  noPluginsFound: boolean
  noToolsDeclaredAnywhere: boolean
  ok: boolean
  summary: string
}

/** Plugin directories directly under `pluginsRoot` that carry a
 * `biffo.plugin.json` — the same discovery convention `plugin_host.discover`
 * uses on the Python side (one directory per plugin, manifest at its root). */
export function discoverPluginDirs(pluginsRoot: string): string[] {
  return listDirs(pluginsRoot).filter((name) => {
    try {
      return statSync(join(pluginsRoot, name, 'biffo.plugin.json')).isFile()
    } catch {
      return false
    }
  })
}

export function auditPluginToolSupply(pluginsRoot: string): PluginToolSupplyReport {
  const pluginNames = discoverPluginDirs(pluginsRoot)
  const findings: PluginToolSupplyFinding[] = []
  let registryBlind = false
  let terraformBlind = false
  let totalDeclaredTools = 0

  for (const name of pluginNames) {
    const pluginDir = join(pluginsRoot, name)
    const manifestText = readFileSync(join(pluginDir, 'biffo.plugin.json'), 'utf8')
    const manifest = extractManifestTools(manifestText)
    if (manifest.parseError) {
      findings.push({
        plugin: name,
        tool: '(manifest)',
        predicate: null,
        requiredEnvVars: [],
        missingEnvVars: [],
        status: 'unresolved-registry',
        detail: `manifest could not be read: ${manifest.parseError}`,
      })
      continue
    }
    if (manifest.tools.length === 0) continue
    totalDeclaredTools += manifest.tools.length

    const pySources: PySource[] = pluginPythonFiles(pluginDir).map((f) => ({
      file: f,
      text: readFileSync(f, 'utf8'),
    }))
    const resolver = buildSymbolResolver(pySources)
    const registry = extractToolRegistryEntries(pySources, resolver)
    if (registry.rawToolDefinitionCount > 0 && registry.entries.length === 0) registryBlind = true

    const tfFiles = pluginTerraformFiles(pluginDir)
    const tfText = tfFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
    const terraform = extractTerraformEnvKeys(tfText)
    if (terraform.rawMarkerCount > 0 && terraform.resolvedBlockCount === 0) terraformBlind = true

    for (const toolName of manifest.tools) {
      const entry = registry.entries.find((e) => e.name === toolName)
      if (!entry) {
        findings.push({
          plugin: name,
          tool: toolName,
          predicate: null,
          requiredEnvVars: [],
          missingEnvVars: [],
          status: 'unresolved-registry',
          detail: `manifest declares "${toolName}" but no ToolDefinition in ${pluginDir} resolves to that name`,
        })
        continue
      }
      if (entry.predicate === null) {
        findings.push({
          plugin: name,
          tool: toolName,
          predicate: null,
          requiredEnvVars: [],
          missingEnvVars: [],
          status: 'ok',
          detail: 'registered with no is_available gate (unconditionally available)',
        })
        continue
      }

      const envResult = extractPredicateEnvVars(pySources, entry.predicate, resolver)
      if (!envResult.predicateFound) {
        findings.push({
          plugin: name,
          tool: toolName,
          predicate: entry.predicate,
          requiredEnvVars: [],
          missingEnvVars: [],
          status: 'unresolved-predicate',
          detail: `is_available=${entry.predicate} but no "def ${entry.predicate}(" was found anywhere under ${pluginDir}`,
        })
        continue
      }
      if (envResult.unresolvedTokens.length > 0) {
        findings.push({
          plugin: name,
          tool: toolName,
          predicate: entry.predicate,
          requiredEnvVars: envResult.envVars,
          missingEnvVars: [],
          status: 'unresolved-env-token',
          detail: `${entry.predicate}() reads os.environ token(s) ${JSON.stringify(envResult.unresolvedTokens)} that are identifiers absent from the symbol table`,
        })
        continue
      }
      if (envResult.envVars.length === 0) {
        // The predicate exists and resolved cleanly but reads no env var at
        // all — not this class's failure mode (nothing for Terraform to
        // supply), so it passes, but it is worth surfacing as its own status
        // rather than folding it into "ok with a gate that checks nothing".
        findings.push({
          plugin: name,
          tool: toolName,
          predicate: entry.predicate,
          requiredEnvVars: [],
          missingEnvVars: [],
          status: 'ok',
          detail: `${entry.predicate}() gates availability but reads no os.environ variable this guard can cross-check`,
        })
        continue
      }

      // OR, not AND: every predicate this codebase writes resolves a
      // credential through a fallback chain — a direct-value env var for
      // local/test use OR an SSM-parameter-name env var for a real deployment
      // (`web_search_configured()`'s `_KEY_ENV or _KEY_PARAMETER_ENV`,
      // `OpenRouterClient._resolve_api_key`'s identical shape). Terraform
      // deliberately wires only the parameter-name half — the direct-value
      // half exists so a local run or a test never reaches for AWS — so
      // requiring EVERY read var to be wired would fail a plugin that is
      // correctly configured today. The defect this guard exists to catch is
      // "no channel at all", which is "NONE of the vars this predicate can
      // read are ever wired" — one live channel is enough.
      const anyWired = envResult.envVars.some((v) => terraform.keys.includes(v))
      findings.push({
        plugin: name,
        tool: toolName,
        predicate: entry.predicate,
        requiredEnvVars: envResult.envVars,
        missingEnvVars: anyWired ? [] : envResult.envVars,
        status: anyWired ? 'ok' : 'missing-env',
        detail: anyWired
          ? `${entry.predicate}() is satisfiable: at least one of ${JSON.stringify(envResult.envVars)} is wired in Terraform`
          : `${entry.predicate}() reads ${JSON.stringify(envResult.envVars)} — NONE of these are wired by any environment_variables block under ${join(pluginDir, 'terraform')}, so this deployment can never supply it`,
      })
    }
  }

  const noPluginsFound = pluginNames.length === 0
  const noToolsDeclaredAnywhere = !noPluginsFound && totalDeclaredTools === 0
  const badFindings = findings.filter((f) => f.status !== 'ok')

  // Fail-closed-on-zero (#1374): an empty world is never evidence of a clean
  // one — it is evidence the audit could not see anything, which is the
  // failure mode this whole guard exists to catch one seam further in.
  const ok = !noPluginsFound && !registryBlind && !terraformBlind && badFindings.length === 0

  const summaryParts = [
    `${pluginNames.length} plugin dir(s) under ${pluginsRoot}`,
    `${totalDeclaredTools} declared tool(s)`,
    `${findings.length} cross-checked, ${badFindings.length} not ok`,
  ]
  if (noPluginsFound) summaryParts.push('NO PLUGINS FOUND — cannot evaluate an empty world')
  if (registryBlind) summaryParts.push('REGISTRY BLIND')
  if (terraformBlind) summaryParts.push('TERRAFORM BLIND')

  return {
    pluginsRoot,
    plugins: pluginNames,
    findings,
    registryBlind,
    terraformBlind,
    noPluginsFound,
    noToolsDeclaredAnywhere,
    ok,
    summary: summaryParts.join('; '),
  }
}

/** `auditPluginToolSupply`, throwing with the full detail on failure — the
 * shape a CI script or a test wants. Mirrors
 * `core-direct-paths-audit.ts`'s `assertSiblingCoreDirectPaths`. */
export function assertPluginToolSupply(pluginsRoot: string): PluginToolSupplyReport {
  const report = auditPluginToolSupply(pluginsRoot)
  if (!report.ok) {
    const lines = [report.summary]
    for (const f of report.findings.filter((f) => f.status !== 'ok')) {
      lines.push(`  ${f.status.toUpperCase()}  ${f.plugin}/${f.tool}  ${f.detail}`)
    }
    throw new Error(lines.join('\n'))
  }
  return report
}
