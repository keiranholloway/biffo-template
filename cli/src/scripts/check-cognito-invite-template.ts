/**
 * CI entrypoint for the Cognito `invite_message_template` content guard
 * (issue #356): fail when a template-owned `invite_message_template` block
 * assigns fewer than all three of `email_subject`, `email_message`,
 * `sms_message`, or omits the `{username}`/`{####}` placeholders Cognito's
 * CreateUserPool requires. `terraform validate` is silent on this — it does
 * not model Cognito's API constraints — so this content-level scan is the
 * only signal available before a fresh deploy's very first apply fails.
 *
 * Scoped to the template-owned `modules/` tree only, matching
 * `findModuleTerraformFiles`'s own scope note (#325/#327): a check over a
 * path an instance owns but cannot receive via `core upgrade` would assert
 * something this repo cannot fix on the instance's behalf.
 *
 * Shipped with #356 and had zero callers until this guard-wiring pass
 * (biffo-template#1363) — nothing has run it as a CI guard until now, though
 * its own `.test.ts` has exercised it against this repo's real `modules/`
 * tree on every `pnpm run test`.
 */
import { execa } from 'execa'
import {
  checkCognitoInviteTemplates,
  findModuleTerraformFiles,
} from '../lib/cognito-invite-template-guard.js'

export async function runCognitoInviteTemplateCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const files = findModuleTerraformFiles(root)

  // Denominator first, unconditionally — a green run that never says how much
  // it looked at is indistinguishable from one that looked at nothing
  // (AGENTS.md's `staging`-branch lesson; biffo-template#1363's whole class).
  console.log(`audited ${files.length} .tf file(s) under modules/ under ${root}`)

  if (files.length === 0) {
    // The template-owned modules/ tree always ships .tf files (networking,
    // compute, auth, ...). Zero here means discovery broke, not that there is
    // nothing to check — fail closed rather than reporting a silent pass.
    console.error(
      '✗ Cognito invite template guard: found 0 .tf files under modules/ — this looks like a ' +
        'broken scan, not a clean repo. Refusing to report success over zero input.',
    )
    process.exit(1)
  }

  const violations = checkCognitoInviteTemplates(root)

  if (violations.length > 0) {
    console.error('✗ Cognito invite template guard: incomplete invite_message_template(s)\n')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.message}`)
    }
    console.error('\nSee biffo-template#356.')
    process.exit(1)
  }

  console.log(`✓ Cognito invite template guard: every invite_message_template block is complete`)
}
