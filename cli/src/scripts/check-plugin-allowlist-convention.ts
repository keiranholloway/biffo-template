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
 *
 * ── Scoping this to the template and its instances (#1906, #1908, #1943) ───
 *
 * A satellite repo (sibling app, plugin repo) never carries
 * `modules/plugins/_template` or `modules/cloud/aws/plugin-allowlist` at all
 * — that Terraform is template/instance-only — so their absence is a
 * legitimate "not applicable", not a broken read (#1906). The first fix
 * checked that literally: ALL FOUR of the sources this guard reads missing
 * meant "satellite, skip". #1908 found that heuristic also silently waved
 * through a real template/instance tree missing just ONE of the four (a
 * rename, an accidental delete) — treating that as "not applicable" would
 * have skipped exactly the drift this guard exists to catch, so only the
 * true zero-of-four case was ever treated as a skip.
 *
 * #1943 is the gap neither of those left closed: a real sibling (`biffo
 * sibling create`'s own scaffold, `_skeletons/sibling-template/modules/`)
 * DOES carry its own `modules/cloud/aws/compute/main.tf` — a real Lambda
 * compute module for its own BFF, unrelated to the plugin-hosting one this
 * guard reads — so a sibling is missing only THREE of the four, never all
 * four, and the #1906/#1908 heuristic ran it anyway and threw "cannot read
 * modules/plugins/_template/main.tf" on a perfectly healthy sibling. Counting
 * missing files was always a proxy for "is this even a template/instance
 * tree" — `classifyRepoOwnership` (`core-ownership-guard.ts`) answers that
 * directly, the same discriminator `check-core-ownership.ts` already uses,
 * so this stops guessing from a coincidence of path names a sibling can
 * share by scaffolding and starts asking what the repo actually is.
 */
import { classifyRepoOwnership } from '../lib/core-ownership-guard.js'
import { execa } from '../lib/exec.js'
import { checkAllowlistConvention } from '../lib/plugin-allowlist-convention.js'

export async function runPluginAllowlistConventionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const ownership = classifyRepoOwnership(root)
  if (ownership === 'satellite') {
    console.log(
      '· Plugin-allowlist convention guard: not applicable — this is not a template/instance ' +
        `tree (${root}), so there is no modules/plugins/_template or ` +
        'modules/cloud/aws/plugin-allowlist Terraform to audit. A sibling app may carry its ' +
        "own unrelated modules/cloud/aws/compute for its own BFF; that is not this guard's " +
        'concern. Skipping.',
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
