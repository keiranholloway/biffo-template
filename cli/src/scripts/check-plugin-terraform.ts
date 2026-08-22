/**
 * CI entrypoint for the plugin-Terraform guard (issue #194): fail when any
 * plugin manifest in this repo declares `event_subscriptions` but ships no
 * `terraform/` directory.
 *
 * Run from CI via `pnpm --filter @biffo/cli check:plugin-terraform`.
 *
 * Scope note: this walks the whole repo from the git root, which is what makes
 * it cover `_skeletons/plugin-template/`. That directory is a member of no
 * workspace and no other CI job — the skeleton's own `README.md` says as much —
 * so a guard scoped to workspace packages would not have run against the very
 * artifact this defect landed in. Walking the tree is the point.
 */
import { execa } from '../lib/exec.js'
import { checkPluginTerraform, formatViolations } from '../lib/plugin-terraform-guard.js'

export async function runPluginTerraformCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const violations = checkPluginTerraform(root)

  if (violations.length > 0) {
    console.error('✗ plugin Terraform guard: event subscriptions with no infrastructure\n')
    console.error(formatViolations(violations))
    process.exit(1)
  }

  console.log('✓ plugin Terraform guard: OK')
}
