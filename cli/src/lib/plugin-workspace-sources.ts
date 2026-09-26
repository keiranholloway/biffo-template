/**
 * Wiring a vendored plugin's dependencies to the instance's uv workspace.
 *
 * When `biffo plugin install` vendors a plugin into an instance, the instance's
 * uv workspace (`[tool.uv.workspace]` in the root `pyproject.toml`) may PROVIDE
 * one of the plugin's dependencies as a workspace member — most commonly
 * `biffo-plugin-sdk` (`packages/python-sdk`). uv then refuses to resolve the
 * plugin unless its `pyproject.toml` declares that dependency's source, e.g.
 * `[tool.uv.sources]` → `biffo-plugin-sdk = { workspace = true }` (the first-party
 * plugins under `services/_plugins/` already do this). Without it, the very first
 * `uv run` — the migration-generation step of the install — fails with:
 *
 *   `biffo-plugin-sdk` is included as a workspace member, but is missing an entry
 *   in `tool.uv.sources`
 *
 * The standalone plugin repo has no such member and resolves the same pin from
 * PyPI, so the source can only be added at vendor time, per instance. This module
 * does exactly that: it reads which package names the instance's workspace
 * provides, and adds a `workspace = true` source to the vendored plugin's
 * `pyproject.toml` for each dependency that matches one.
 *
 * What the plugin DECLARES and what it already SOURCES are read with a real TOML
 * parser (`smol-toml`), never with line regexes: a regex reader only sees the
 * spellings its author thought of, and every valid one it missed (a comment after
 * a table header, a quoted or indented key) silently skipped a dependency group —
 * the exact `uv` failure this module exists to prevent (biffo-template#2106).
 * The EDIT stays textual — inserting lines preserves the file's comments, which a
 * round-trip through a TOML serialiser would drop — but it is located from parsed
 * table headers and verified by re-parsing the result before anything is written,
 * so it cannot emit a duplicate table or key: it either produces TOML that parses
 * with every added source present, or throws and writes nothing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { log } from './logger.js'

/**
 * Extract the quoted strings of a `key = [ ... ]` TOML array (single- or
 * multi-line), matched at line start. Returns [] if the key is absent.
 */
export function readTomlStringArray(text: string, key: string): string[] {
  const open = new RegExp(`^${key}\\s*=\\s*\\[`, 'm').exec(text)
  if (!open) return []
  // Single comment-aware, string-aware scan from just after the opening `[`: it
  // both finds the array's matching close bracket and collects its top-level
  // quoted strings. Comments (`# … the SDK's require_group … [maybe brackets]`)
  // are skipped to end of line — a stray apostrophe or bracket in one must not be
  // read as a string delimiter or nesting — and a `]`/`[` inside a string literal
  // (a dependency's `[extra]`) does not change depth.
  const strings: string[] = []
  let depth = 1
  let i = open.index + open[0].length
  while (i < text.length && depth > 0) {
    const c = text[i]!
    if (c === '#') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
    } else if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1)
      if (close === -1) break // unterminated string — give up rather than misparse
      if (depth === 1) strings.push(text.slice(i + 1, close))
      i = close + 1
    } else {
      if (c === '[') depth++
      else if (c === ']') depth--
      i++
    }
  }
  return depth === 0 ? strings : []
}

/** The `[project] name = "..."` of a pyproject, or null. Scoped to the `[project]`
 * table so a `name =` under another table can't be mistaken for it. */
export function readProjectName(text: string): string | null {
  let inProject = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inProject = trimmed === '[project]'
      continue
    }
    if (inProject) {
      const m = /^name\s*=\s*["']([^"']+)["']/.exec(trimmed)
      if (m) return m[1]!
    }
  }
  return null
}

/** The base name of a PEP 508 requirement string: `biffo-plugin-sdk[user-serving]>=1.1` → `biffo-plugin-sdk`. */
function requirementName(requirement: string): string | null {
  return /^\s*([A-Za-z0-9._-]+)/.exec(requirement)?.[1] ?? null
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every requirement string in a `{ group = [ "req", { include-group = "x" }, ... ] }` table; non-strings are skipped. */
function requirementsIn(groups: unknown): string[] {
  if (!isTable(groups)) return []
  return Object.values(groups)
    .filter(Array.isArray)
    .flat()
    .filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Base package names the pyproject declares anywhere uv applies its "a workspace member needs a `tool.uv.sources` entry" rule:
 * `[project] dependencies`, `[project.optional-dependencies]` and `[dependency-groups]` (PEP 735: `dev`, `test`, …). The plugin
 * skeleton declares `biffo-plugin-host` in its `dev` group (biffo-template#2106), so reading `dependencies` alone sourced
 * `biffo-plugin-sdk` and left the very next `uv run` failing on the host.
 */
export function readDeclaredDependencyNames(doc: Record<string, unknown>): string[] {
  const project = isTable(doc.project) ? doc.project : {}
  const requirements = [
    ...(Array.isArray(project.dependencies) ? project.dependencies : []).filter(
      (dep): dep is string => typeof dep === 'string',
    ),
    ...requirementsIn(project['optional-dependencies']),
    ...requirementsIn(doc['dependency-groups']),
  ]
  return requirements.map(requirementName).filter((name): name is string => name !== null)
}

/** The keys of `[tool.uv.sources]`, however they were spelled — bare, quoted, in a table or inline. */
function existingSourceNames(doc: Record<string, unknown>): Set<string> {
  const tool = isTable(doc.tool) ? doc.tool : {}
  const uv = isTable(tool.uv) ? tool.uv : {}
  return new Set(isTable(uv.sources) ? Object.keys(uv.sources) : [])
}

/** Whether the parsed document has any `tool.uv.sources` value at all (a header, an inline table or dotted keys). */
function hasSourcesTable(doc: Record<string, unknown>): boolean {
  const tool = isTable(doc.tool) ? doc.tool : {}
  const uv = isTable(tool.uv) ? tool.uv : {}
  return uv.sources !== undefined
}

/**
 * Where `[tool.uv.sources]` is written as a `[header]` line: the index just past that line (its trailing comment and newline
 * included), or null when the table is not written as a header of its own (inline, or built from dotted keys).
 *
 * Headers are found by a scan that skips comments and strings (including `"""` / `'''` multi-line ones) and nested arrays
 * and inline tables, so header-shaped text inside a value is never mistaken for one; a header's key path is then read by the
 * TOML parser itself, so quoted segments and spaces (`[ tool . "uv".sources ]`) match however they were written.
 */
function sourcesHeaderLineEnd(text: string): number | null {
  let depth = 0
  let atLineStart = true
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '\n') {
      atLineStart = true
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (c === '#') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
    } else if (c === '"' || c === "'") {
      atLineStart = false
      const triple = text.startsWith(c.repeat(3), i)
      const quote = triple ? c.repeat(3) : c
      i += quote.length
      // A basic string honours `\` escapes; a literal string (') does not.
      while (i < text.length && !text.startsWith(quote, i)) {
        if (c === '"' && text[i] === '\\') i++
        if (!triple && text[i] === '\n') break
        i++
      }
      // A triple-quoted string may end with up to two extra quote characters.
      i += quote.length
    } else if (atLineStart && depth === 0 && c === '[') {
      const isArrayOfTables = text[i + 1] === '['
      const close = isArrayOfTables ? ']]' : ']'
      let j = i + close.length
      while (j < text.length && !text.startsWith(close, j)) {
        if (text[j] === '"' || text[j] === "'") {
          const end = text.indexOf(text[j]!, j + 1)
          j = end === -1 ? text.length : end
        }
        j++
      }
      const header = text.slice(i, j + close.length)
      const nl = text.indexOf('\n', j)
      const lineEnd = nl === -1 ? text.length : nl + 1
      if (!isArrayOfTables && isSourcesHeader(header)) return lineEnd
      i = lineEnd
      atLineStart = true
    } else {
      atLineStart = false
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
      i++
    }
  }
  return null
}

/** Whether a `[ ... ]` header line names the `tool.uv.sources` table. */
function isSourcesHeader(header: string): boolean {
  let node: unknown = parseToml(`${header}\n`)
  for (const segment of ['tool', 'uv', 'sources']) {
    if (!isTable(node) || Object.keys(node).length !== 1 || !(segment in node)) return false
    node = node[segment]
  }
  return isTable(node) && Object.keys(node).length === 0
}

/**
 * The set of package names the instance's uv workspace provides as members —
 * resolving the `[tool.uv.workspace] members` globs (literal paths and a trailing
 * `/*`) to directories and reading each one's `[project] name`.
 */
export function workspaceMemberNames(instanceRoot: string): Set<string> {
  const rootPyproject = join(instanceRoot, 'pyproject.toml')
  if (!existsSync(rootPyproject)) return new Set()
  const text = readFileSync(rootPyproject, 'utf8')
  const members = readTomlStringArray(text, 'members')
  const excluded = new Set(readTomlStringArray(text, 'exclude'))

  const dirs: string[] = []
  for (const member of members) {
    if (member.endsWith('/*')) {
      const base = member.slice(0, -2)
      let entries
      try {
        entries = readdirSync(join(instanceRoot, base), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const rel = `${base}/${entry.name}`
        if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(rel)) dirs.push(rel)
      }
    } else if (!excluded.has(member)) {
      dirs.push(member)
    }
  }

  const names = new Set<string>()
  for (const dir of dirs) {
    const pp = join(instanceRoot, dir, 'pyproject.toml')
    if (!existsSync(pp)) continue
    const name = readProjectName(readFileSync(pp, 'utf8'))
    if (name) names.add(name)
  }
  return names
}

/**
 * Add `<dep> = { workspace = true }` to the plugin `pyproject.toml` for every
 * dependency that the instance's workspace provides as a member and that is not
 * already sourced. Idempotent. Returns the names added (empty if none needed).
 *
 * ## The `existsSync`-then-write here is read-modify-write, not a guard (#1222)
 *
 * CodeQL flags this as `js/file-system-race` alongside two genuine overwrite
 * guards. It is not one. The `existsSync` asks "is there a file to edit at
 * all?" and the function then reads that file, appends to its text and writes
 * the result back. Rewriting a file it just read is the whole job, so `wx` —
 * the fix applied to the two real guards — would make this throw on every call
 * that has anything to do.
 *
 * The residual exposure is a lost update if something else rewrites the same
 * `pyproject.toml` in the window between the read and the write. That is
 * accepted: this runs inside `biffo plugin install`, which is already
 * mutating that plugin's vendored tree wholesale (copying files, running `uv`),
 * so a second concurrent writer to the same path is outside what any locking
 * here could make safe.
 *
 * This finding was open as alert #21 with the `// codeql[js/file-system-race]`
 * comment sitting directly below it and doing nothing — see biffo-template#1491.
 * A code comment does not change CodeQL's own verdict; nothing here reads it.
 * Dismissed by hand ("won't fix") with this reasoning recorded as the
 * dismissal comment instead. If the code changes enough to re-trigger the
 * finding, it reopens as a new alert and needs dismissing again — that is the
 * check working, not a regression.
 */
export function ensureWorkspaceSources(
  pluginPyprojectPath: string,
  memberNames: Set<string>,
): string[] {
  if (!existsSync(pluginPyprojectPath) || memberNames.size === 0) return []
  const text = readFileSync(pluginPyprojectPath, 'utf8')
  const doc = parsePyproject(text, pluginPyprojectPath)

  // Any existing source for a name — workspace or not, however spelled — is the plugin's own decision; never write a second.
  const already = existingSourceNames(doc)
  const declared = new Set(readDeclaredDependencyNames(doc))
  const toAdd = [...declared].filter((n) => memberNames.has(n) && !already.has(n))
  if (toAdd.length === 0) return []

  const lines = toAdd.map(
    (n) => `${/^[A-Za-z0-9_-]+$/.test(n) ? n : JSON.stringify(n)} = { workspace = true }`,
  )
  let updated: string
  if (hasSourcesTable(doc)) {
    const insertAt = sourcesHeaderLineEnd(text)
    if (insertAt === null) {
      throw new Error(
        `${pluginPyprojectPath} defines tool.uv.sources as an inline table or dotted keys, which biffo cannot extend in ` +
          `place without risking a duplicate. Add \`{ workspace = true }\` sources for ${toAdd.join(', ')} by hand ` +
          '(the instance provides them as uv workspace members), then re-run.',
      )
    }
    const sep = text.slice(0, insertAt).endsWith('\n') ? '' : '\n'
    updated = `${text.slice(0, insertAt)}${sep}${lines.join('\n')}\n${text.slice(insertAt)}`
  } else {
    const sep = text.endsWith('\n') ? '' : '\n'
    updated =
      `${text}${sep}\n` +
      '# Vendored into this instance by `biffo plugin install`: resolve dependencies the\n' +
      "# instance's uv workspace provides as members from the workspace, not PyPI.\n" +
      '[tool.uv.sources]\n' +
      `${lines.join('\n')}\n`
  }

  // The edit above is textual, so prove it: the result must parse and carry every source it was meant to add. Anything else —
  // an inline `tool = { uv = … }`, a construct the header scan misjudged — throws with nothing written.
  let written = new Set<string>()
  try {
    written = existingSourceNames(parseToml(updated))
  } catch {
    // The edit produced invalid TOML (e.g. `tool` was an inline table the appended header redefines); `written` stays empty.
  }
  const missing = toAdd.filter((n) => !written.has(n))
  if (missing.length > 0) {
    throw new Error(
      `${pluginPyprojectPath}: could not add a workspace source for ${missing.join(', ')} to tool.uv.sources without ` +
        'producing invalid TOML. Add them by hand (the instance provides them as uv workspace members), then re-run.',
    )
  }
  // Read-modify-write, not an overwrite guard — see the block comment above.
  writeFileSync(pluginPyprojectPath, updated)
  return toAdd
}

function parsePyproject(text: string, path: string): Record<string, unknown> {
  try {
    return parseToml(text)
  } catch (err) {
    throw new Error(
      `${path} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    )
  }
}

/**
 * `ensureWorkspaceSources` plus the log line every call site wants — pulled
 * out because `plugin install`, `plugin upgrade <name>@<minor>` and `plugin
 * upgrade --local` each land a plugin's `pyproject.toml` on disk and then
 * need this exact "if the workspace provided anything, say so" step. Kept as
 * one function so a future change to what gets logged (or how the target
 * pyproject is found) can't fix three of the four call sites and miss the
 * fourth — which is exactly how the registry `plugin upgrade` path went
 * without calling `ensureWorkspaceSources` at all until it was pointed out
 * in review.
 */
export function applyWorkspaceSources(
  targetDir: string,
  cwd: string,
  relTargetDir: string,
): string[] {
  const pluginPyproject = join(targetDir, 'pyproject.toml')
  if (!existsSync(pluginPyproject)) return []
  const sourced = ensureWorkspaceSources(pluginPyproject, workspaceMemberNames(cwd))
  if (sourced.length > 0) {
    log.info(
      `Sourced ${sourced.join(', ')} from the workspace in ${relTargetDir}/pyproject.toml ` +
        '(the instance provides it as a workspace member).',
    )
  }
  return sourced
}
