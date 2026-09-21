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
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PLUGIN_REGISTRY_RELATIVE_PATH = 'apps/frontend/src/lib/plugins.ts'

export const REGISTRY_START_MARKER =
  '// BIFFO-PLUGIN-REGISTRY:START — managed by `biffo plugin install`/`uninstall`. Do not hand-edit.'
export const REGISTRY_END_MARKER = '// BIFFO-PLUGIN-REGISTRY:END'

/** The projection of a plugin manifest the dashboard needs — not the full manifest. */
export interface DashboardPluginEntry {
  name: string
  version: string
  description: string
  requiredGroup: string
}

function registryPath(cwd: string): string {
  return join(cwd, PLUGIN_REGISTRY_RELATIVE_PATH)
}

/** True when the target checkout has adopted the dashboard dynamic-route pattern at all. */
export function pluginRegistryExists(cwd: string): boolean {
  return existsSync(registryPath(cwd))
}

function missingRegistryError(cwd: string, pluginName: string): Error {
  return new Error(
    `${PLUGIN_REGISTRY_RELATIVE_PATH} does not exist in ${cwd} — this sibling checkout has not ` +
      `adopted the dashboard dynamic-route pattern (ADR-0021 §2), so plugin "${pluginName}"'s ` +
      '`user_frontend` block has nowhere to register. Add the file with a managed ' +
      '`INSTALLED_PLUGINS` array (see plugin-frontend-registry.ts for the exact marker ' +
      'contract) before installing a user-facing plugin here, or install a plugin with no ' +
      '`user_frontend` block instead.',
  )
}

function malformedRegistryError(cwd: string, pluginName: string): Error {
  return new Error(
    `${PLUGIN_REGISTRY_RELATIVE_PATH} in ${cwd} does not carry the managed ` +
      `"${REGISTRY_START_MARKER}" / "${REGISTRY_END_MARKER}" region that plugin "${pluginName}"'s ` +
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

function serializeEntry(entry: DashboardPluginEntry): string {
  return (
    '  {\n' +
    `    name: ${JSON.stringify(entry.name)},\n` +
    `    version: ${JSON.stringify(entry.version)},\n` +
    `    description: ${JSON.stringify(entry.description)},\n` +
    `    requiredGroup: ${JSON.stringify(entry.requiredGroup)},\n` +
    '  },\n'
  )
}

/**
 * Parses the managed region's entries back out. Deliberately NOT a TS/JS
 * parse: the region only ever contains this module's own `serializeEntry`
 * output, so a small fixed-shape regex is sufficient and keeps this
 * dependency-free. It is intentionally tolerant of the field order
 * `serializeEntry` always uses; a hand-edit inside the managed region that
 * does not match this shape is exactly the contract violation the marker
 * comment warns against, and such an entry is silently dropped on the next
 * write — never a reason to leave the region unmanaged.
 */
function parseManagedEntries(regionBody: string): DashboardPluginEntry[] {
  const entries: DashboardPluginEntry[] = []
  const entryPattern =
    /\{\s*name:\s*"((?:[^"\\]|\\.)*)",\s*version:\s*"((?:[^"\\]|\\.)*)",\s*description:\s*"((?:[^"\\]|\\.)*)",\s*requiredGroup:\s*"((?:[^"\\]|\\.)*)",?\s*\}/g
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(regionBody)) !== null) {
    entries.push({
      name: JSON.parse(`"${match[1]}"`) as string,
      version: JSON.parse(`"${match[2]}"`) as string,
      description: JSON.parse(`"${match[3]}"`) as string,
      requiredGroup: JSON.parse(`"${match[4]}"`) as string,
    })
  }
  return entries
}

/**
 * Checked up front, before anything is copied into the checkout — same
 * posture as the retired-frontend-shape and missing-config guards in
 * `plugin-install.ts`: a refusal must leave the checkout untouched, so the
 * registry's shape is validated before the first byte is written anywhere.
 * Throws the same errors `upsertPluginRegistryEntry` would throw at write
 * time; calling this first only moves the failure earlier.
 */
export function assertPluginRegistryReady(cwd: string, pluginName: string): void {
  readManagedEntries(cwd, pluginName)
}

function readManagedEntries(
  cwd: string,
  pluginName: string,
): { source: string; region: ManagedRegion; entries: DashboardPluginEntry[] } {
  const path = registryPath(cwd)
  if (!existsSync(path)) throw missingRegistryError(cwd, pluginName)
  const source = readFileSync(path, 'utf8')
  const found = findManagedRegion(source)
  if (!found) throw malformedRegistryError(cwd, pluginName)
  return { source, region: found.region, entries: parseManagedEntries(found.body) }
}

function writeManagedEntries(
  cwd: string,
  region: ManagedRegion,
  entries: DashboardPluginEntry[],
): void {
  const body = entries.length > 0 ? '\n' + entries.map(serializeEntry).join('') : '\n'
  writeFileSync(registryPath(cwd), region.before + body + region.after, 'utf8')
}

/**
 * Create-or-update this plugin's entry, keyed by `name`. Idempotent — running
 * install twice for the same plugin (e.g. a version bump) replaces the
 * existing entry rather than duplicating it. Fails closed (throws, writes
 * nothing) when the registry file is missing or malformed — see module
 * docstring.
 */
export function upsertPluginRegistryEntry(cwd: string, entry: DashboardPluginEntry): void {
  const { region, entries } = readManagedEntries(cwd, entry.name)
  const next = [...entries.filter((e) => e.name !== entry.name), entry]
  writeManagedEntries(cwd, region, next)
}

/**
 * Remove this plugin's entry, if present. A plugin already installed with a
 * `user_frontend` block guarantees the registry existed and was well-formed
 * at install time (install fails closed otherwise), so a missing/malformed
 * registry at uninstall time is a genuinely unexpected state — this still
 * fails closed rather than silently leaving the entry behind, the same
 * posture as install.
 */
export function removePluginRegistryEntry(cwd: string, pluginName: string): void {
  const { region, entries } = readManagedEntries(cwd, pluginName)
  const next = entries.filter((e) => e.name !== pluginName)
  writeManagedEntries(cwd, region, next)
}
