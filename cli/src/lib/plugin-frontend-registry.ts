/**
 * Writes/removes a plugin's entry in the installing sibling's DASHBOARD
 * plugin registry — `apps/frontend/src/lib/plugins.ts`, which exports
 * `INSTALLED_PLUGINS: PluginManifest[]` and is read by the sibling's dynamic
 * `/dashboard/[plugin]/` route (biffo-platform-app#73, ADR-0018 §2 /
 * ADR-0021 §2's `user_frontend` surface). biffo-template#2041: before this,
 * `biffo plugin install` staged `services/`, `modules/plugins/` and a
 * migration for a plugin's `user_frontend` block, but never wrote anything
 * into the sibling that would actually serve it — an installer had to
 * hand-edit `plugins.ts` themselves, with nothing telling them to.
 *
 * ## The entry shape (biffo-template#2047)
 *
 * The sibling's own `PluginManifest` type — the ONE real instance of this
 * file in the estate, `biffo-platform-app` via its PR #73 — is
 * `{ slug: string; title: string; frontendUrl: string }`. This module writes
 * exactly that shape now. It used to write `{ name, version, description,
 * requiredGroup }`, which does not satisfy that type under `tsc --strict`
 * (`TS2353`) and can never be found by the sibling's own
 * `getPlugin(slug) => INSTALLED_PLUGINS.find(p => p.slug === slug)` lookup,
 * because none of the written entries carried a `slug` field at all — see
 * #2047 for the full repro against the real file.
 *
 * `slug` is the plugin's manifest `name` (already a kebab-case slug —
 * `plugin-manifest.ts`'s `name` regex). `title` has no dedicated manifest
 * field (`biffo.plugin.json` has `name`/`description`, nothing presentational),
 * so it is derived from the slug via `titleFromSlug` — "ideation-engine"
 * becomes "Ideation Engine", matching biffo-platform-app's real hand-authored
 * entries exactly. `frontendUrl` is the shared plugin host's `user_frontend`
 * mount path (ADR-0021 §2): `/api/v1/plugins/<slug>/ui`, same-origin, so no
 * per-plugin domain or CDN wiring is needed.
 *
 * ## Why a managed region, not a whole-file overwrite
 *
 * `apps/frontend/src/lib/plugins.ts` lives under `apps/`, which is
 * user-owned (`core-manifest.json`) — it is the SIBLING's own file, not a
 * template-owned path `biffo core upgrade` regenerates wholesale the way
 * `plugin-terraform-wiring.ts` regenerates `plugins.generated.tf`. A sibling
 * may hand-author imports, other exports, or comments around the registry
 * array. So this module owns only the array *contents* between two sentinel
 * comments — the same "write generated data into the checkout instead of
 * asking for a hand edit" instinct `sibling-create.ts` already applies to
 * `siblings.auto.tfvars.json`, at the granularity a hand-authored `.ts` file
 * (rather than a whole JSON file) requires.
 *
 * ## The contract a sibling's `plugins.ts` must satisfy
 *
 * ```ts
 * export const INSTALLED_PLUGINS: PluginManifest[] = [
 *   // BIFFO-PLUGIN-REGISTRY:START — managed by `biffo plugin install`/`uninstall`. Do not hand-edit.
 *   // BIFFO-PLUGIN-REGISTRY:END
 * ]
 * ```
 *
 * Both markers must be present, START before END. `biffo plugin install`
 * fails CLOSED — throws, writes nothing anywhere — when the file is absent,
 * or present without that region: a sibling that has not adopted the
 * dynamic-route pattern gets a loud, actionable error instead of a silently
 * skipped write. A plugin manifest with no `user_frontend` block never
 * touches this file at all (checked by the caller before either function
 * here is invoked).
 *
 * ## Why entries are handled as opaque text, not re-serialized JSON (#2047)
 *
 * The managed region is not exclusively populated by this module in
 * practice: a sibling adopting the pattern migrates its *existing*,
 * hand-authored entries into the region first (see #2047's repro — two
 * entries whose `frontendUrl` is a bare identifier referencing an imported
 * constant, not a string literal, which cannot round-trip through
 * `JSON.stringify`/`JSON.parse` at all). The previous implementation parsed
 * every entry in the region into a fixed-field struct and re-serialized the
 * whole region from that struct on every write — so an entry in any shape
 * this module didn't itself recognise (a hand-authored one, or simply an
 * older/newer version of this module's own shape) silently vanished on the
 * very first write, with no warning.
 *
 * Instead, an entry is kept as its raw literal text — everything between its
 * own `{` and `}`, exactly as written — plus whatever `slug` can be read out
 * of it. `upsertPluginRegistryEntry`/`removePluginRegistryEntry` only ever
 * touch the one entry whose extracted `slug` matches; every other entry's
 * raw text is written back byte-for-byte, whatever shape or quoting it uses.
 * An entry with no extractable `slug` (a malformed hand-edit) is preserved
 * but can never be matched by name — the safe default is to never guess
 * which un-keyed entry a write was meant to replace.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PLUGIN_REGISTRY_RELATIVE_PATH = 'apps/frontend/src/lib/plugins.ts'

export const REGISTRY_START_MARKER =
  '// BIFFO-PLUGIN-REGISTRY:START — managed by `biffo plugin install`/`uninstall`. Do not hand-edit.'
export const REGISTRY_END_MARKER = '// BIFFO-PLUGIN-REGISTRY:END'

/**
 * The projection of a plugin manifest the dashboard needs — the sibling's own
 * `PluginManifest` type (`biffo-platform-app`'s `apps/frontend/src/lib/plugins.ts`,
 * PR #73), not a shape invented by this module. See module docstring (#2047).
 */
export interface DashboardPluginEntry {
  slug: string
  title: string
  frontendUrl: string
}

/**
 * Human-readable dashboard title derived from a plugin's kebab-case slug —
 * the manifest declares no separate display-name field. "ideation-engine"
 * becomes "Ideation Engine", matching biffo-platform-app's real,
 * hand-authored `plugins.ts` entries exactly (#2047's repro fixture).
 */
export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The shared plugin host's `user_frontend` mount path (ADR-0021 §2) — served
 * same-origin behind the existing `/api/v1/plugins/*` route family, so no
 * per-plugin domain, CDN behaviour, or config value is needed to compute it.
 *
 * The sibling's own frontend-to-BFF guard (`test_frontend_bff_paths.py`, in
 * `_skeletons/sibling-template/services/api/tests/`) fails any `/api/v1/...`
 * literal its BFF does not register, and this shape is not one — the plugin host
 * serves it. The guard therefore exempts exactly this family, as
 * `PLUGIN_HOST_UI_PATH`, in this registry file only (#2114). Change the shape
 * here and that constant must change with it; `plugin-registry-bff-guard.test.ts`
 * runs the real guard over this function's output and fails if they disagree.
 */
export function frontendUrlForSlug(slug: string): string {
  return `/api/v1/plugins/${slug}/ui`
}

function registryPath(cwd: string): string {
  return join(cwd, PLUGIN_REGISTRY_RELATIVE_PATH)
}

/** True when the target checkout has adopted the dashboard dynamic-route pattern at all. */
export function pluginRegistryExists(cwd: string): boolean {
  return existsSync(registryPath(cwd))
}

function missingRegistryError(cwd: string, pluginSlug: string): Error {
  return new Error(
    `${PLUGIN_REGISTRY_RELATIVE_PATH} does not exist in ${cwd} — this sibling checkout has not ` +
      `adopted the dashboard dynamic-route pattern (ADR-0021 §2), so plugin "${pluginSlug}"'s ` +
      '`user_frontend` block has nowhere to register. Add the file with a managed ' +
      '`INSTALLED_PLUGINS` array (see plugin-frontend-registry.ts for the exact marker ' +
      'contract) before installing a user-facing plugin here, or install a plugin with no ' +
      '`user_frontend` block instead.',
  )
}

function malformedRegistryError(cwd: string, pluginSlug: string): Error {
  return new Error(
    `${PLUGIN_REGISTRY_RELATIVE_PATH} in ${cwd} does not carry the managed ` +
      `"${REGISTRY_START_MARKER}" / "${REGISTRY_END_MARKER}" region that plugin "${pluginSlug}"'s ` +
      'install needs to write into. Add that managed region around the INSTALLED_PLUGINS array ' +
      "contents (see plugin-frontend-registry.ts's module docstring) rather than hand-editing " +
      'the array.',
  )
}

interface ManagedRegion {
  /** Everything up to and including the start marker. */
  before: string
  /** Everything from the end marker onward. */
  after: string
}

function findManagedRegion(source: string): { region: ManagedRegion; body: string } | null {
  const startIdx = source.indexOf(REGISTRY_START_MARKER)
  if (startIdx === -1) return null
  const bodyStart = startIdx + REGISTRY_START_MARKER.length
  const endIdx = source.indexOf(REGISTRY_END_MARKER, bodyStart)
  if (endIdx === -1) return null
  return {
    region: { before: source.slice(0, bodyStart), after: source.slice(endIdx) },
    body: source.slice(bodyStart, endIdx),
  }
}

/** Matches `slug: "value"` or `slug: 'value'` — the only field this module ever keys on. */
const SLUG_FIELD_PATTERN = /\bslug\s*:\s*(['"])([a-zA-Z0-9_-]+)\1/

function extractSlug(entryRaw: string): string | null {
  const match = SLUG_FIELD_PATTERN.exec(entryRaw)
  return match ? match[2]! : null
}

interface RegistryEntry {
  /**
   * This entry's object-literal contents, exactly as written between its own
   * `{` and `}` — e.g. ` slug: 'x', title: 'X', frontendUrl: X_URL ` for a
   * hand-authored entry referencing an imported constant. Preserved
   * byte-for-byte for any entry this write does not target, so a
   * hand-authored value that could never round-trip through JSON (a bare
   * identifier, a different quote style, extra fields) is never rewritten.
   */
  raw: string
  /** The `slug` read out of this entry, or `null` if none could be found. */
  slug: string | null
}

/**
 * Splits the managed region's body into individual array-element entries by
 * walking it and brace-matching each `{...}` object literal (tracking string
 * literals so a `}` inside a quoted value never miscounts). Deliberately NOT
 * a TS/JS parse — the region only ever holds plain object literals, and this
 * is dependency-free. Anything between entries (commas, whitespace) is not
 * preserved; only each entry's own literal text and extracted `slug` matter,
 * since output is always re-joined with normalized separators (#2047).
 */
function splitEntries(body: string): RegistryEntry[] {
  const entries: RegistryEntry[] = []
  const n = body.length
  let i = 0
  while (i < n) {
    const ch = body[i]
    if (ch !== '{') {
      i++
      continue
    }
    const start = i + 1
    let depth = 1
    let j = start
    let quote: string | null = null
    while (j < n && depth > 0) {
      const c = body[j]
      if (quote) {
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '{') {
        depth++
      } else if (c === '}') {
        depth--
      }
      j++
    }
    const raw = body.slice(start, j - 1)
    entries.push({ raw, slug: extractSlug(raw) })
    i = j
  }
  return entries
}

function serializeEntryRaw(entry: DashboardPluginEntry): string {
  return (
    `\n    slug: ${JSON.stringify(entry.slug)},\n` +
    `    title: ${JSON.stringify(entry.title)},\n` +
    `    frontendUrl: ${JSON.stringify(entry.frontendUrl)},\n  `
  )
}

/**
 * Checked up front, before anything is copied into the checkout — same
 * posture as the retired-frontend-shape and missing-config guards in
 * `plugin-install.ts`: a refusal must leave the checkout untouched, so the
 * registry's shape is validated before the first byte is written anywhere.
 * Throws the same errors `upsertPluginRegistryEntry` would throw at write
 * time; calling this first only moves the failure earlier.
 */
export function assertPluginRegistryReady(cwd: string, pluginSlug: string): void {
  readManagedEntries(cwd, pluginSlug)
}

function readManagedEntries(
  cwd: string,
  pluginSlug: string,
): { source: string; region: ManagedRegion; entries: RegistryEntry[] } {
  const path = registryPath(cwd)
  if (!existsSync(path)) throw missingRegistryError(cwd, pluginSlug)
  const source = readFileSync(path, 'utf8')
  const found = findManagedRegion(source)
  if (!found) throw malformedRegistryError(cwd, pluginSlug)
  return { source, region: found.region, entries: splitEntries(found.body) }
}

function writeManagedEntries(cwd: string, region: ManagedRegion, entries: RegistryEntry[]): void {
  const body = entries.length > 0 ? '\n' + entries.map((e) => `  {${e.raw}},\n`).join('') : '\n'
  writeFileSync(registryPath(cwd), region.before + body + region.after, 'utf8')
}

/**
 * Create-or-update this plugin's entry, keyed by `slug`. Idempotent — running
 * install twice for the same plugin (e.g. a version bump) replaces the
 * existing entry rather than duplicating it. Every other entry in the region
 * — including one this module does not recognise the shape of — is preserved
 * verbatim (#2047). Fails closed (throws, writes nothing) when the registry
 * file is missing or malformed — see module docstring.
 */
export function upsertPluginRegistryEntry(cwd: string, entry: DashboardPluginEntry): void {
  const { region, entries } = readManagedEntries(cwd, entry.slug)
  const preserved = entries.filter((e) => e.slug !== entry.slug)
  const next: RegistryEntry = { raw: serializeEntryRaw(entry), slug: entry.slug }
  writeManagedEntries(cwd, region, [...preserved, next])
}

/**
 * Remove this plugin's entry, if present. Every other entry — including one
 * this module does not recognise the shape of — is preserved verbatim
 * (#2047). A plugin already installed with a `user_frontend` block
 * guarantees the registry existed and was well-formed at install time
 * (install fails closed otherwise), so a missing/malformed registry at
 * uninstall time is a genuinely unexpected state — this still fails closed
 * rather than silently leaving the entry behind, the same posture as
 * install.
 */
export function removePluginRegistryEntry(cwd: string, pluginSlug: string): void {
  const { region, entries } = readManagedEntries(cwd, pluginSlug)
  const next = entries.filter((e) => e.slug !== pluginSlug)
  writeManagedEntries(cwd, region, next)
}
