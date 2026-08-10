/**
 * CI entrypoint for the plugin tool-supply guard (issue #822): fail when a
 * plugin's manifest declares a tool whose `is_available` predicate reads an
 * environment variable that no `environment_variables` block in the plugin's
 * own Terraform ever wires — the shape that left `web_search` silently
 * unavailable in every environment, forever, with the manifest, the runtime
 * registry and `terraform apply` all reporting clean independently.
 *
 * Scoped to `services/_plugins/`, the template-owned plugins this repo ships
 * (`orchestrator`, `agent-runtime` today). A repo with none — most instances,
 * which vendor third-party plugins under a different, user-owned path this
 * guard does not walk — no-ops rather than failing: `services/_plugins/`
 * absent is a legitimate shape, not evidence the check could not run. An
 * EXISTING but empty `services/_plugins/` still fails closed, via
 * `auditPluginToolSupply`'s own `noPluginsFound` backstop (#1363, #1374).
 *
 * This guard shipped with #1409 and had zero callers until #1413 wired it —
 * the estate's first real run happens in this PR's own CI.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { auditPluginToolSupply } from '../lib/plugin-tool-supply-audit.js'

export async function runPluginToolSupplyCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const pluginsRoot = join(root, 'services', '_plugins')

  if (!existsSync(pluginsRoot)) {
    console.log('✓ plugin tool-supply guard: no services/_plugins/ — nothing to audit')
    return
  }

  const report = auditPluginToolSupply(pluginsRoot)
  // Denominator first, unconditionally — a green run that never says how much
  // it looked at is indistinguishable from one that looked at nothing.
  console.log(
    `audited ${report.plugins.length} plugin dir(s), ${report.findings.length} declared ` +
      `tool(s) cross-checked, under ${pluginsRoot}`,
  )

  if (!report.ok) {
    console.error('✗ plugin tool-supply guard: an unsatisfiable tool grant found\n')
    if (report.noPluginsFound) {
      console.error(`  NO PLUGINS FOUND under ${pluginsRoot} — cannot evaluate an empty world.`)
    }
    if (report.registryBlind) {
      console.error(
        '  REGISTRY BLIND: raw source contains ToolDefinition( call site(s) but the extractor ' +
          'resolved none — the extractor broke, this is not evidence a plugin registers nothing.',
      )
    }
    if (report.terraformBlind) {
      console.error(
        '  TERRAFORM BLIND: raw source contains environment_variables but the extractor ' +
          'resolved no keys — the extractor broke, this is not evidence of an empty Lambda.',
      )
    }
    for (const f of report.findings.filter((f) => f.status !== 'ok')) {
      console.error(`  ${f.status.toUpperCase()}  ${f.plugin}/${f.tool}  ${f.detail}`)
    }
    console.error('\nSee biffo-template#822.')
    process.exit(1)
  }

  console.log(`✓ plugin tool-supply guard: ${report.summary}`)
}
