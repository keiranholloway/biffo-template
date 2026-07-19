/**
 * Guard: a plugin that declares `event_subscriptions` must ship a `terraform/`
 * directory (issue #194).
 *
 * A subscription is three things that have to agree: a manifest entry, a
 * handler in code, and the infrastructure that routes the event to the plugin's
 * Lambda. The first two are unit-testable and were tested; the third is a
 * directory, and nothing checked it existed. `biffo plugin install` wraps the
 * Terraform copy in `if (existsSync(tfSourceDir))`, so a plugin missing it
 * installs cleanly and its subscription is inert in every deployment — the
 * failure is silent at every stage.
 *
 * This module is pure so it can be unit-tested; `scripts/check-plugin-terraform.ts`
 * is the CI entrypoint that walks the repo and reports.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** Directories never worth walking when looking for plugin manifests. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', '.venv', '__pycache__'])

export const PLUGIN_MANIFEST_FILE = 'biffo.plugin.json'

export interface PluginTerraformViolation {
  /** Repo-relative path of the offending manifest. */
  manifest: string
  /** Repo-relative path of the `terraform/` directory that should exist. */
  expectedTerraformDir: string
  /** The `source`/`detail_type` pairs that would never fire. */
  subscriptions: string[]
}

/** Recursively find every `biffo.plugin.json` under `root`, repo-relative. */
export function findPluginManifests(root: string): string[] {
  const found: string[] = []

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory — nothing to check
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile() && entry.name === PLUGIN_MANIFEST_FILE) {
        found.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
      }
    }
  }

  walk(root)
  return found.sort()
}

/**
 * Describe a manifest's declared subscriptions, or `null` when it declares
 * none. A malformed or unreadable manifest is *not* this guard's business —
 * manifest schema validation is a separate check — so it is skipped rather
 * than reported here.
 */
function readSubscriptions(absManifestPath: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absManifestPath, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const subs = (parsed as Record<string, unknown>)['event_subscriptions']
  if (!Array.isArray(subs) || subs.length === 0) return null

  return subs.map((sub, i) => {
    if (typeof sub !== 'object' || sub === null) return `#${i}`
    const { source, detail_type: detailType } = sub as Record<string, unknown>
    return `${String(source ?? '?')}/${String(detailType ?? '?')}`
  })
}

/**
 * Check every plugin manifest under `root`. Returns one violation per manifest
 * that declares subscriptions but has no sibling `terraform/` directory.
 */
export function checkPluginTerraform(root: string): PluginTerraformViolation[] {
  const violations: PluginTerraformViolation[] = []

  for (const manifest of findPluginManifests(root)) {
    const absManifest = join(root, manifest)
    const subscriptions = readSubscriptions(absManifest)
    if (subscriptions === null) continue

    const pluginDir = dirname(absManifest)
    if (existsSync(join(pluginDir, 'terraform'))) continue

    const relPluginDir = relative(root, pluginDir).split(sep).join('/')
    violations.push({
      manifest,
      expectedTerraformDir: relPluginDir ? `${relPluginDir}/terraform` : 'terraform',
      subscriptions,
    })
  }

  return violations
}

/** Render violations as the CI failure message. */
export function formatViolations(violations: PluginTerraformViolation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.manifest} declares ${v.subscriptions.length} event subscription(s) ` +
        `(${v.subscriptions.join(', ')}) but ships no ${v.expectedTerraformDir}/.\n` +
        `    Without it there is no Lambda and no EventBridge rule, so those events never ` +
        `reach the plugin — and \`biffo plugin install\` skips the Terraform copy silently.\n` +
        `    Fix: copy modules/plugins/_template/ to ${v.expectedTerraformDir}/ and set ` +
        `handler/event_subscriptions to match the manifest.`,
    )
    .join('\n\n')
}
