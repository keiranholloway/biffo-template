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
 * TOML is read/written with narrow regexes rather than a parser dependency: the
 * shapes here (a string array, a `[project]` name, an `[tool.uv.sources]` table)
 * are simple and stable, and appending a section preserves the file's comments —
 * which a round-trip through most TOML libraries would drop.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Extract the quoted strings of a `key = [ ... ]` TOML array (single- or
 * multi-line), matched at line start. Returns [] if the key is absent.
 */
export function readTomlStringArray(text: string, key: string): string[] {
  const open = new RegExp(`^${key}\\s*=\\s*\\[`, 'm').exec(text)
  if (!open) return []
  const start = open.index + open[0].length
  // Find the array's matching close bracket, ignoring brackets inside string
  // literals (a dependency's extras — "pkg[extra]>=1" — contains a literal `]`)
  // and any nested arrays.
  let depth = 1
  let inString = false
  let quote = ''
  let end = -1
  for (let i = start; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (c === quote) inString = false
    } else if (c === '"' || c === "'") {
      inString = true
      quote = c
    } else if (c === '[') {
      depth++
    } else if (c === ']') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return []
  const body = text.slice(start, end)
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!)
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

/** Base package names of a `[project] dependencies = [...]` array (extras and
 * version specifiers stripped): `biffo-plugin-sdk[user-serving]>=1.1` → `biffo-plugin-sdk`. */
export function readDependencyNames(text: string): string[] {
  return readTomlStringArray(text, 'dependencies')
    .map((dep) => /^\s*([A-Za-z0-9._-]+)/.exec(dep)?.[1] ?? '')
    .filter(Boolean)
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

/** Names that already have a `<name> = { workspace = ... }` line in the text. */
function existingWorkspaceSources(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*\{[^}]*\bworkspace\b/gm)].map((m) => m[1]!),
  )
}

/**
 * Add `<dep> = { workspace = true }` to the plugin `pyproject.toml` for every
 * dependency that the instance's workspace provides as a member and that is not
 * already sourced. Idempotent. Returns the names added (empty if none needed).
 */
export function ensureWorkspaceSources(
  pluginPyprojectPath: string,
  memberNames: Set<string>,
): string[] {
  if (!existsSync(pluginPyprojectPath) || memberNames.size === 0) return []
  const text = readFileSync(pluginPyprojectPath, 'utf8')

  const already = existingWorkspaceSources(text)
  const toAdd = readDependencyNames(text).filter((n) => memberNames.has(n) && !already.has(n))
  if (toAdd.length === 0) return []

  const lines = toAdd.map((n) => `${n} = { workspace = true }`)
  const header = /^\[tool\.uv\.sources\]\s*$/m.exec(text)
  let updated: string
  if (header) {
    // Insert right after the existing section header.
    const insertAt = header.index + header[0].length
    updated = `${text.slice(0, insertAt)}\n${lines.join('\n')}${text.slice(insertAt)}`
  } else {
    const sep = text.endsWith('\n') ? '' : '\n'
    updated =
      `${text}${sep}\n` +
      '# Vendored into this instance by `biffo plugin install`: resolve dependencies the\n' +
      "# instance's uv workspace provides as members from the workspace, not PyPI.\n" +
      '[tool.uv.sources]\n' +
      `${lines.join('\n')}\n`
  }
  writeFileSync(pluginPyprojectPath, updated)
  return toAdd
}
