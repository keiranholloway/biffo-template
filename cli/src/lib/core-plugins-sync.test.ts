import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * The first-party plugin set is named in two template-owned places (#406,
 * ADR-0014), and they MUST agree:
 *
 *   - infra/environments/dev/plugins.core.tf — the `module "plugin_<name>"`
 *     blocks that actually provision each plugin's Lambda.
 *   - modules/cloud/aws/plugin-allowlist/variables.tf — the `core_plugins`
 *     default that allowlists those Lambdas to call /api/v1/internal/*.
 *
 * If they drift, a plugin is provisioned but not allowlisted (its runtime is
 * denied the Core API) or allowlisted but not provisioned (a dead ARN). Both
 * ship green — nothing else compares them — so this is the guard, in the spirit
 * of #364. Adding a first-party plugin means editing both files; this fails
 * until they match.
 */
function pluginsCoreNames(): string[] {
  const src = readFileSync(join(repoRoot, 'infra/environments/dev/plugins.core.tf'), 'utf8')
  // Each first-party plugin is `plugin_name = "<name>"` inside its module block.
  return [...src.matchAll(/plugin_name\s*=\s*"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!).sort()
}

function allowlistCoreNames(): string[] {
  const src = readFileSync(
    join(repoRoot, 'modules/cloud/aws/plugin-allowlist/variables.tf'),
    'utf8',
  )
  // The `core_plugins` variable's default list.
  const block = /variable\s+"core_plugins"[\s\S]*?default\s*=\s*\[([^\]]*)\]/.exec(src)?.[1]
  if (block === undefined) {
    throw new Error('core-plugins sync guard: no core_plugins default found in plugin-allowlist')
  }
  return [...block.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!).sort()
}

describe('first-party plugin set is consistent across its two template-owned homes', () => {
  it('plugins.core.tf provisions a non-empty set', () => {
    expect(pluginsCoreNames().length).toBeGreaterThan(0)
  })

  it('the allowlist core_plugins default matches the provisioned set', () => {
    expect(allowlistCoreNames()).toEqual(pluginsCoreNames())
  })

  it('is the expected first-party set today (orchestrator, agent-runtime)', () => {
    // A change here is intentional and should move with a real plugin addition.
    expect(pluginsCoreNames()).toEqual(['agent-runtime', 'orchestrator'])
  })
})
