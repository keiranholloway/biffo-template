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
  // Read-modify-write, not an overwrite guard — see the block comment above.
  writeFileSync(pluginPyprojectPath, updated)
  return toAdd
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
export function applyWorkspaceSources(targetDir: string, cwd: string, relTargetDir: string): void {
  const pluginPyproject = join(targetDir, 'pyproject.toml')
  if (!existsSync(pluginPyproject)) return
  const sourced = ensureWorkspaceSources(pluginPyproject, workspaceMemberNames(cwd))
  if (sourced.length > 0) {
    log.info(
      `Sourced ${sourced.join(', ')} from the workspace in ${relTargetDir}/pyproject.toml ` +
        '(the instance provides it as a workspace member).',
    )
  }
}
