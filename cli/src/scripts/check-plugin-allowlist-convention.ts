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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import {
  ALLOWLIST_MAIN_TF,
  ALLOWLIST_VARIABLES_TF,
  COMPUTE_MAIN_TF,
  PLUGIN_TEMPLATE_MAIN_TF,
  checkAllowlistConvention,
} from '../lib/plugin-allowlist-convention.js'

/** The four template-owned module sources this guard symbolically composes
 * a role name and glob from. A satellite repo (sibling app, plugin repo)
 * never carries `modules/cloud/aws/*` or `modules/plugins/_template` at all
 * — that Terraform is template/instance-only — so their absence here is a
 * legitimate "not applicable", not a broken read (biffo-template#1906).
 *
 * The discriminator is ALL FOUR missing, not ANY of the four (biffo-template
 * #1908): a true satellite carries none of them, but a template/instance
 * tree that has SOME of the four and is missing one — a rename or an
 * accidental delete of just `variables.tf`, say — is exactly the drift this
 * guard exists to catch, and treating that as "not applicable" would skip
 * silently over it instead of failing closed. Only the true zero case is
 * skipped here; a partial set falls through and lets `checkAllowlistConvention`
 * throw its own "cannot read <path>" error below, exactly as it did before
 * this guard learned to distinguish satellites at all. */
const REQUIRED_SOURCES = [
  COMPUTE_MAIN_TF,
  PLUGIN_TEMPLATE_MAIN_TF,
  ALLOWLIST_MAIN_TF,
  ALLOWLIST_VARIABLES_TF,
]

export async function runPluginAllowlistConventionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const missing = REQUIRED_SOURCES.filter((relative) => !existsSync(join(root, relative)))
  if (missing.length === REQUIRED_SOURCES.length) {
    console.log(
      '· Plugin-allowlist convention guard: not applicable — ' +
        `${missing.join(', ')} not found under ${root}. This is not a template/instance tree ` +
        '(a satellite repo never carries the plugin-allowlist Terraform modules). Skipping.',
    )
    return
  }

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
