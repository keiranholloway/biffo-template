/**
 * Registering a user-facing plugin's CDN origins (ADR-0018 §1/§2).
 *
 * A user-facing plugin is hosted as an authenticated sibling: its Lambda Function
 * URL is routed at `<base>/<name>/api/*` and its frontend at `<base>/<name>/*` on
 * the shared CloudFront. Both are registered as **static tfvars** (the same model
 * `biffo sibling create` uses for `siblings.auto.tfvars.json`), because the Function
 * URL host and the frontend bucket domain are only known *after* the plugin's own
 * Terraform has applied:
 *
 *   apply 1  →  `biffo plugin install` generates the module block; apply creates
 *              the Lambda + Function URL + frontend bucket.
 *   register →  read the module outputs, upsert them here into the two tfvars.
 *   apply 2  →  the cdn module gains the `<name>/api/*` and `<name>/*` behaviours.
 *
 * The frontend origin is written into `siblings.auto.tfvars.json` — it *is* an
 * ordinary sibling S3 origin (ADR-0018 reuses ADR-0007's mechanism), so it shares
 * the `sibling_origins` list and the `upsertSiblingOrigin` primitive. The api
 * ingress gets its own `plugin-apis.auto.tfvars.json` (`plugin_api_origins`).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { serializeRegistry, upsertSiblingOrigin, type SiblingOrigin } from './root-sibling.js'

export const PLUGIN_API_TFVARS = 'plugin-apis.auto.tfvars.json'
export const SIBLINGS_TFVARS = 'siblings.auto.tfvars.json'

/** One `plugin_api_origins` entry — the plugin Lambda's Function URL host. */
export interface PluginApiOrigin {
  name: string
  function_url_domain: string
}

/** Add or replace one api-origin entry, keyed by name (like upsertSiblingOrigin). */
export function upsertPluginApiOrigin(
  existing: PluginApiOrigin[],
  entry: PluginApiOrigin,
): PluginApiOrigin[] {
  return [...existing.filter((p) => p.name !== entry.name), entry]
}

/** Serialize `plugin-apis.auto.tfvars.json` exactly as the writer must produce it. */
export function serializePluginApiRegistry(origins: PluginApiOrigin[]): string {
  return JSON.stringify({ plugin_api_origins: origins }, null, 2) + '\n'
}

function readArray<T>(path: string, key: string): T[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const arr = parsed[key]
    return Array.isArray(arr) ? (arr as T[]) : []
  } catch {
    return []
  }
}

export interface UserFacingPluginRegistration {
  name: string
  functionUrlDomain: string
  bucketRegionalDomain: string
}

/**
 * Register a user-facing plugin's api ingress and frontend origins into an
 * environment's tfvars. Idempotent (upsert by name), preserving any other
 * registered plugins/siblings. Returns the repo-relative paths written.
 */
export function registerUserFacingPlugin(
  cwd: string,
  environment: string,
  reg: UserFacingPluginRegistration,
): string[] {
  const envDir = join(cwd, 'infra', 'environments', environment)
  const apiPath = join(envDir, PLUGIN_API_TFVARS)
  const siblingPath = join(envDir, SIBLINGS_TFVARS)

  const apis = upsertPluginApiOrigin(readArray<PluginApiOrigin>(apiPath, 'plugin_api_origins'), {
    name: reg.name,
    function_url_domain: reg.functionUrlDomain,
  })
  writeFileSync(apiPath, serializePluginApiRegistry(apis))

  const siblings = upsertSiblingOrigin(readArray<SiblingOrigin>(siblingPath, 'sibling_origins'), {
    name: reg.name,
    bucket_regional_domain: reg.bucketRegionalDomain,
  })
  writeFileSync(siblingPath, serializeRegistry(siblings))

  return [
    `infra/environments/${environment}/${PLUGIN_API_TFVARS}`,
    `infra/environments/${environment}/${SIBLINGS_TFVARS}`,
  ]
}

/**
 * Remove a user-facing plugin's origins from an environment's tfvars (uninstall).
 * Leaves the files in place (possibly with empty lists) so a re-register is a
 * clean upsert, and returns the paths written.
 */
export function unregisterUserFacingPlugin(
  cwd: string,
  environment: string,
  name: string,
): string[] {
  const envDir = join(cwd, 'infra', 'environments', environment)
  const apiPath = join(envDir, PLUGIN_API_TFVARS)
  const siblingPath = join(envDir, SIBLINGS_TFVARS)
  const written: string[] = []

  if (existsSync(apiPath)) {
    const apis = readArray<PluginApiOrigin>(apiPath, 'plugin_api_origins').filter(
      (p) => p.name !== name,
    )
    writeFileSync(apiPath, serializePluginApiRegistry(apis))
    written.push(`infra/environments/${environment}/${PLUGIN_API_TFVARS}`)
  }
  if (existsSync(siblingPath)) {
    const siblings = readArray<SiblingOrigin>(siblingPath, 'sibling_origins').filter(
      (s) => s.name !== name,
    )
    writeFileSync(siblingPath, serializeRegistry(siblings))
    written.push(`infra/environments/${environment}/${SIBLINGS_TFVARS}`)
  }
  return written
}
