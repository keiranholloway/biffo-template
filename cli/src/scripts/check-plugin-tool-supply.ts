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
 *
 * ── Second check: declared model ids (#822's other half) ───────────────────
 *
 * #1409 shipped only the tool half; its PR body named the model-id half
 * explicitly out of scope ("inherently a live network call ... not a static
 * cross-artifact read"). `auditDeclaredModelIds` closes that gap without a
 * live call — see `plugin-tool-supply-audit.ts`'s "Half D" section and
 * `openrouter-model-snapshot.ts` for the design and its trade-off. Scoped to
 * `services/api/`, present in the template and every instance (ADR-0002);
 * absent in a plugin-only repo, which no-ops the same way the tool check
 * no-ops on a repo with no `services/_plugins/`.
 *
 * Both checks run and report before either can end the process, so a single
 * CI run always shows both denominators rather than stopping at the first
 * failure and leaving the second unknown.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { auditDeclaredModelIds, auditPluginToolSupply } from '../lib/plugin-tool-supply-audit.js'

export async function runPluginToolSupplyCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  let allOk = true

  // ── Tool supply (#1409/#1413) ───────────────────────────────────────────
  const pluginsRoot = join(root, 'services', '_plugins')
  if (!existsSync(pluginsRoot)) {
    console.log('✓ plugin tool-supply guard: no services/_plugins/ — nothing to audit')
  } else {
    const report = auditPluginToolSupply(pluginsRoot)
    // Denominator first, unconditionally — a green run that never says how much
    // it looked at is indistinguishable from one that looked at nothing.
    console.log(
      `audited ${report.plugins.length} plugin dir(s), ${report.findings.length} declared ` +
        `tool(s) cross-checked, under ${pluginsRoot}`,
    )

    if (!report.ok) {
      allOk = false
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
    } else {
      console.log(`✓ plugin tool-supply guard: ${report.summary}`)
    }
  }

  // ── Declared model ids (#822's other half) ──────────────────────────────
  const servicesApiRoot = join(root, 'services', 'api')
  if (!existsSync(servicesApiRoot)) {
    console.log('✓ plugin model-id guard: no services/api/ — nothing to audit')
  } else {
    const modelReport = auditDeclaredModelIds(root)
    console.log(`audited ${modelReport.findings.length} declared model id(s)`)

    if (!modelReport.ok) {
      allOk = false
      console.error('✗ plugin model-id guard: a declared model id does not match the provider\n')
      if (modelReport.configMissing) {
        console.error(`  MISSING ${modelReport.configPath}`)
      }
      if (modelReport.orchestrationSchemaMissing) {
        console.error(`  MISSING ${modelReport.orchestrationSchemaPath}`)
      }
      if (modelReport.settingsBlind) {
        console.error(
          `  SETTINGS EXTRACTOR BLIND: ${modelReport.configPath} exists but no model-named ` +
            'string field resolved — the extractor broke, this is not evidence there is no default.',
        )
      }
      if (modelReport.curatedFieldsBlind) {
        console.error(
          `  CURATED-OPTIONS EXTRACTOR BLIND: ${modelReport.orchestrationSchemaPath} has a ` +
            '"name": "model" field but no default/options resolved from it.',
        )
      }
      if (modelReport.snapshotEmpty) {
        console.error('  SNAPSHOT EMPTY: the committed OpenRouter snapshot has zero ids.')
      }
      if (modelReport.snapshotStale) {
        console.error(
          `  SNAPSHOT STALE: fetched ${modelReport.snapshotFetchedAt}, older than the ` +
            'refresh window — run refresh-openrouter-model-snapshot.ts and commit the result.',
        )
      }
      for (const f of modelReport.findings.filter((f) => f.status !== 'ok')) {
        console.error(`  ${f.status.toUpperCase()}  ${f.source}  ${f.detail}`)
      }
    } else {
      console.log(`✓ plugin model-id guard: ${modelReport.summary}`)
    }
  }

  if (!allOk) {
    console.error('\nSee biffo-template#822.')
    process.exit(1)
  }
}
