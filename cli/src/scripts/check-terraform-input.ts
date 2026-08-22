/**
 * CI entrypoint for the Terraform-non-interactive guard (issue #322): fail
 * when a workflow runs a Terraform subcommand that can prompt for an
 * unresolved variable (`init`, `plan`, `apply`, `destroy`, `import`,
 * `refresh`) without `-input=false`, or runs Terraform at all without
 * setting `TF_INPUT` at workflow level as a backstop. On a GitHub Actions
 * runner there is no stdin to answer a prompt, so the step hangs until the
 * job is killed — observed as a 61-minute silent hang with nothing in the
 * log saying which step stuck or why. `-auto-approve` does not prevent this;
 * it only suppresses the apply confirmation, not variable prompts.
 *
 * Shipped with #322 and had zero callers as a CI *guard* until this
 * guard-wiring pass (biffo-template#1363) — its own `.test.ts` has exercised
 * it against this repo's real workflow tree on every `pnpm run test`, but
 * nothing ran it from `cli/src/commands/` or a named workflow step.
 */
import { execa } from '../lib/exec.js'
import { checkTerraformInput, findWorkflowFiles } from '../lib/terraform-input-guard.js'

export async function runTerraformInputCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const files = findWorkflowFiles(root)

  console.log(`audited ${files.length} workflow file(s) under ${root}`)

  if (files.length === 0) {
    console.error(
      '✗ Terraform-input guard: found 0 workflow files — this looks like a broken scan, not a ' +
        'clean repo. Refusing to report success over zero input.',
    )
    process.exit(1)
  }

  const violations = checkTerraformInput(root)

  if (violations.length > 0) {
    console.error('✗ Terraform-input guard: interactive Terraform invocation(s) found\n')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.message}`)
    }
    console.error('\nSee biffo-template#322.')
    process.exit(1)
  }

  console.log(`✓ Terraform-input guard: every Terraform invocation is non-interactive`)
}
