/**
 * CI entrypoint for the EventBridge→CloudWatch-Logs permission guard
 * (issue #1356): fail when an `aws_cloudwatch_event_target` writes to a log
 * group that no `aws_cloudwatch_log_resource_policy` grants
 * `events.amazonaws.com` access to. `terraform apply` succeeds and the rule
 * reports ENABLED on the broken shape — this is the only signal available
 * before either exists, see `eventbridge-log-permission-guard.ts`'s module
 * doc comment.
 *
 * Scoped to the whole repo (from the git root), not just `modules/`, so it
 * also covers each plugin's own `terraform/` under `services/_plugins/` and
 * `_skeletons/plugin-template/terraform` — every Terraform tree this repo
 * ships, template-owned or scaffolding, in one pass. This guard shipped with
 * #1408 and had zero callers until #1413 wired it — the estate's first real
 * run happens in this PR's own CI.
 */
import { execa } from 'execa'
import { auditEventBridgeLogPermissions } from '../lib/eventbridge-log-permission-guard.js'

export async function runEventBridgeLogPermissionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  let report: ReturnType<typeof auditEventBridgeLogPermissions>
  try {
    report = auditEventBridgeLogPermissions(root)
  } catch (err) {
    // No .tf files at all under root — a hard failure, not "0 violations"
    // (see the module doc comment's blindness section).
    console.error('✗ EventBridge log permission guard: could not run\n')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // Denominator first, unconditionally — a green run that never says how much
  // it looked at is indistinguishable from one that looked at nothing
  // (AGENTS.md's `staging`-branch lesson; #1413 was filed over exactly this
  // gap in the audit that should have caught these three guards having no
  // caller at all).
  console.log(`audited ${report.filesScanned} .tf file(s) under ${root}`)

  if (!report.ok) {
    console.error('✗ EventBridge log permission guard: unpermissioned target(s) found\n')
    if (report.eventTargetBlind) {
      console.error(
        '  BLIND (aws_cloudwatch_event_target): raw source contains this resource type but ' +
          'the block extractor found none — the extractor broke, this is not evidence there ' +
          'are no event targets (#1374 was exactly this shape on an adjacent guard).',
      )
    }
    if (report.logPolicyBlind) {
      console.error(
        '  BLIND (aws_cloudwatch_log_resource_policy): raw source contains this resource type ' +
          'but the block extractor found none — the extractor broke, this is not evidence ' +
          'there are no log resource policies.',
      )
    }
    for (const b of report.unterminatedBlocks) {
      console.error(
        `  UNTERMINATED ${b.file}:${b.line}  resource "${b.type}" "${b.name}" never closes — ` +
          'cannot verify what it grants or targets.',
      )
    }
    for (const v of report.violations) {
      console.error(`  UNPERMISSIONED ${v.file}:${v.line}  ${v.reason}`)
    }
    console.error('\nSee biffo-template#1356.')
    process.exit(1)
  }

  console.log(`✓ EventBridge log permission guard: ${report.summary}`)
}
