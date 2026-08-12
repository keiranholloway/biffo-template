/**
 * CI entrypoint for the ADR-0009 plugin-allowlist naming-convention guard
 * (issue #266 / #1545): fail when `modules/cloud/aws/plugin-allowlist`'s
 * service-principal ARN glob no longer matches the IAM role name
 * `modules/cloud/aws/compute` + `modules/plugins/_template` actually build.
 * `terraform validate` is silent on this — the allowlist never references
 * either naming module, by design (see `plugin-allowlist-convention.ts`'s
 * doc comment) — so a rename in either would leave every plugin call
 * rejected by `require_service_principal` with no signal before a real
 * deploy hits it.
 *
 * tabsii-platform#863 is this exact failure already reaching production:
 * `BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST` there was a hardcoded array that
 * simply omitted the plugin host, so every forwarded plugin call got 403.
 * This guard checks the template's own generated convention rather than a
 * hand-maintained list, but the failure it prevents is the same shape: the
 * allowlist silently falling out of step with who is actually allowed to
 * call in.
 *
 * Shipped with #266, exercised only by its own `.test.ts` until #1519's
 * widened guard enumeration surfaced it as unwired (ratcheted into
 * `guard-wiring-sweep.test.ts`'s `PRE_EXISTING_UNWIRED`) and this pass
 * (#1545) wired it here — the template's own three source modules are the
 * real input, checked on every push, exactly where a rename would otherwise
 * go unnoticed until a plugin's calls started silently 403ing.
 */
import { execa } from 'execa'
import { checkAllowlistConvention } from '../lib/plugin-allowlist-convention.js'

export async function runPluginAllowlistConventionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  let violations: ReturnType<typeof checkAllowlistConvention>
  try {
    violations = checkAllowlistConvention(root)
  } catch (err) {
    console.error('✗ Plugin-allowlist convention guard: could not run\n')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  console.log(`audited the plugin-allowlist naming convention under ${root}`)

  if (violations.length > 0) {
    console.error('✗ Plugin-allowlist convention guard: drift found\n')
    for (const v of violations) {
      console.error(`  ${v.file}\n  ${v.message}`)
    }
    console.error('\nSee biffo-template#266, biffo-template#1545, tabsii-platform#863.')
    process.exit(1)
  }

  console.log(
    '✓ Plugin-allowlist convention guard: the allowlist glob matches the role name the ' +
      'naming modules build, and enabled_plugins still defaults to [] (fail-closed)',
  )
}
