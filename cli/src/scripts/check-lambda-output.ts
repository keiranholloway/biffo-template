/**
 * CI entrypoint for the Lambda-output-leak guard (issue #334): fail when a
 * workflow calls `aws lambda update-function-code` or
 * `update-function-configuration` without suppressing or narrowing its
 * output. Both commands print the full resolved function configuration by
 * default — every env var, plaintext, into the Actions log — and the
 * response is never consumed (a `wait function-updated` always follows), so
 * narrowing costs nothing and closes a real credential leak.
 *
 * Scoped to template-owned workflow trees (`.github/workflows/` and
 * `_skeletons/`), matching `findWorkflowFiles`'s own walk from the repo root
 * — see `lambda-output-guard.ts`'s scope note.
 *
 * Shipped with #334 and had zero callers until this guard-wiring pass
 * (biffo-template#1363) — nothing has run it as a CI guard until now, though
 * its own `.test.ts` has exercised it against this repo's real workflow tree
 * on every `pnpm run test`.
 */
import { execa } from 'execa'
import { checkLambdaOutput } from '../lib/lambda-output-guard.js'
import { findWorkflowFiles } from '../lib/terraform-input-guard.js'

export async function runLambdaOutputCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const files = findWorkflowFiles(root)

  console.log(`audited ${files.length} workflow file(s) under ${root}`)

  if (files.length === 0) {
    // This repo always ships at least .github/workflows/ci.yml. Zero here
    // means discovery broke, not that there is nothing to check.
    console.error(
      '✗ Lambda output guard: found 0 workflow files — this looks like a broken scan, not a ' +
        'clean repo. Refusing to report success over zero input.',
    )
    process.exit(1)
  }

  const violations = checkLambdaOutput(root)

  if (violations.length > 0) {
    console.error('✗ Lambda output guard: unsuppressed aws lambda update-function-* output found\n')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.message}`)
    }
    console.error('\nSee biffo-template#334.')
    process.exit(1)
  }

  console.log(`✓ Lambda output guard: every aws lambda update-function-* call suppresses output`)
}
