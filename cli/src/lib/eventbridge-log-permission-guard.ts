/**
 * Guard: an `aws_cloudwatch_event_target` that points at a CloudWatch Logs log
 * group must be backed by an `aws_cloudwatch_log_resource_policy` that grants
 * `events.amazonaws.com` write access to that group (issue #1356).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `modules/cloud/aws/events/main.tf` created a log group, an ENABLED catch-all
 * rule and a target pointing at the group, and omitted the resource policy
 * EventBridge needs in order to write there (#1355, now fixed in that file —
 * see `events_from_eventbridge` in the same module). The result: the rule
 * reported ENABLED, `put-events` returned `FailedEntryCount 0`, and the log
 * group produced **zero log streams for the entire life of the environment**.
 * `terraform apply` succeeded throughout — nothing about the group, the rule
 * or the target references the permission that makes any of it work, because
 * a CloudWatch Logs resource policy is account-and-region scoped rather than
 * attached to the log group it grants access to (#1364: a seam whose two
 * halves are authoritative in different artifacts, and no suite reads both —
 * the "actor" is the EventBridge rule/target, the "target" is the log group,
 * and the permission joining them lives on neither).
 *
 * `terraform validate`, `terraform plan/apply` and checkov all pass on the
 * broken shape: the config is valid HCL, every resource creates, and checkov
 * has no rule for "this target cannot write to its destination" (checkov
 * checks over-permission, this is the opposite failure). The only signal is
 * behavioural, at runtime, on a path nobody watches — which is why this reads
 * Terraform source directly rather than depending on a live AWS account or a
 * `terraform plan` JSON export; the point is to catch the gap at authoring
 * time, before either exists.
 *
 * ── What this checks ─────────────────────────────────────────────────────
 *
 * For every `aws_cloudwatch_event_target` block whose `arn` resolves to an
 * `aws_cloudwatch_log_group.<name>.arn` reference, assert some
 * `aws_cloudwatch_log_resource_policy` block in the same file set both names
 * that log group's ARN and grants `events.amazonaws.com`. A target pointing
 * anywhere else (Lambda, SQS — each has its own permission resource type,
 * e.g. `aws_lambda_permission`/`aws_sqs_queue_policy`, both out of scope here)
 * is not this guard's business and is silently excluded, not flagged.
 *
 * ── Unresolvable input FAILS, it never silently passes (#1363, #1374) ──────
 *
 * A check that finds nothing because it could not see its input is the
 * estate's most-repeated defect shape (#1374 blinded an adjacent guard this
 * exact way: a comment stripper ate the real call sites and "0 found, 0
 * violations" read as clean). Three backstops enforce the opposite here:
 *
 * 1. **No `.tf` files at all under `root`** fails outright
 *    (`auditEventBridgeLogPermissions` throws) — a guard that reports "0
 *    violations" because it was pointed at an empty or wrong directory is
 *    indistinguishable from a real pass unless this is a hard error.
 * 2. **Raw-text vs parsed-block blindness**: the raw text is scanned for
 *    literal `resource "aws_cloudwatch_event_target"` / `resource
 *    "aws_cloudwatch_log_resource_policy"` occurrences, independently of the
 *    block extractor. If the raw count is positive but the extractor parsed
 *    zero blocks of that type, that is the extractor breaking, not the
 *    estate having none — `eventTargetBlind` / `logPolicyBlind` fail the
 *    audit.
 * 3. **Unterminated blocks are recorded as unresolved, never dropped** — a
 *    `resource "..." "..." {` with no matching `}` (a real editing mistake,
 *    or evidence the brace scanner walked off the end of a heredoc) is
 *    reported as `unresolved: true` and fails the audit rather than being
 *    skipped as if the block never existed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.worktrees', 'dist'])

const EVENT_TARGET_TYPE = 'aws_cloudwatch_event_target'
const LOG_RESOURCE_POLICY_TYPE = 'aws_cloudwatch_log_resource_policy'

/** `aws_cloudwatch_log_group.<name>.arn`, optionally count-indexed
 * (`aws_cloudwatch_log_group.<name>[0].arn`) — the reference shape an
 * `event_target`'s `arn` or a resource policy's `Resource` field uses to name
 * a log group. */
const LOG_GROUP_ARN_REF = /aws_cloudwatch_log_group\.([\w-]+)(?:\[[^\]]*\])?\.arn/g

const EVENTBRIDGE_PRINCIPAL = 'events.amazonaws.com'

/** `Service = "<value>"` or `Service = [<comma-separated quoted values>]`
 * inside a policy-document body — the two shapes the AWS provider accepts for
 * an IAM `Principal.Service`. Only the quoted values are collected; nothing
 * outside a `Service = ` assignment counts. */
const SERVICE_PRINCIPAL_ASSIGNMENT = /Service\s*=\s*(\[[^\]]*\]|"[^"]*")/g

/** Every literal value assigned to `Service` inside a policy-document body,
 * as exact strings — never a substring match. CodeQL correctly flagged the
 * original implementation here (`js/incomplete-url-substring-sanitization`,
 * `.includes(EVENTBRIDGE_PRINCIPAL)`): a raw substring check reads
 * `events.amazonaws.com.attacker.example` (a real string an attacker
 * controls, the false principal ATTACHED AFTER the real one) and
 * `notevents.amazonaws.com` (attached BEFORE) as granting EventBridge, and
 * would also read the literal string sitting in an unrelated comment or
 * description field as a grant — which is precisely the failure shape this
 * guard exists to catch (a permission that reads as present but is not),
 * reproduced inside the guard's own principal check. Matching only the exact
 * quoted value assigned to `Service` closes both: a policy naming the wrong
 * host, or merely mentioning the right one, is correctly treated as NOT
 * granting it. */
export function servicePrincipalsIn(body: string): string[] {
  const values: string[] = []
  SERVICE_PRINCIPAL_ASSIGNMENT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SERVICE_PRINCIPAL_ASSIGNMENT.exec(body)) !== null) {
    const raw = m[1] as string
    for (const sm of raw.matchAll(/"([^"]*)"/g)) {
      values.push(sm[1] as string)
    }
  }
  return values
}

/** Does this policy-document body grant `principal` — matched as the EXACT
 * value of a `Service` principal, not a substring anywhere in the body? */
export function grantsPrincipal(body: string, principal: string): boolean {
  return servicePrincipalsIn(body).includes(principal)
}

export interface ResourceBlock {
  file: string
  line: number
  type: string
  name: string
  /** Raw text between the block's `{` and its matching `}`, or `null` when
   * the block never closed (unterminated — see `unresolved` on the callers
   * that surface this). */
  body: string | null
}

export interface EventTargetLogRef {
  file: string
  line: number
  targetName: string
  /** The log group resource name the target's `arn` resolves to. */
  logGroupName: string
}

export interface EventBridgeLogPermissionViolation {
  file: string
  line: number
  targetName: string
  logGroupName: string
  reason: string
}

export interface EventBridgeLogPermissionReport {
  filesScanned: number
  eventTargetBlocksFound: number
  logResourcePolicyBlocksFound: number
  /** Event targets whose `arn` resolves to a log group — the population this
   * guard actually judges. */
  logTargets: EventTargetLogRef[]
  unterminatedBlocks: ResourceBlock[]
  violations: EventBridgeLogPermissionViolation[]
  eventTargetBlind: boolean
  logPolicyBlind: boolean
  ok: boolean
  summary: string
}

function lineNumber(text: string, index: number): number {
  let count = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') count += 1
  }
  return count
}

/** Index of the `}` balancing the `{` at `openIndex`, or `null` if the block
 * never closes before EOF. Plain brace counting, same posture as
 * `balancedParenSpan` in `core-direct-paths-audit.ts` — this repo's `.tf`
 * files keep heredocs out of the resource types this guard reads (verified
 * against `origin/dev` 2026-08-09: `aws_cloudwatch_event_target`,
 * `aws_cloudwatch_log_group` and `aws_cloudwatch_log_resource_policy` blocks
 * contain none), so a full HCL parser buys nothing a heredoc-aware scanner
 * would not already need to justify. */
function balancedBraceSpan(text: string, openIndex: number): number | null {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

/** Every `resource "<resourceType>" "<name>" { ... }` block in `text`.
 * Unterminated blocks (no matching `}`) are still returned, with `body: null`
 * — callers must not treat that as "no block found". */
export function findResourceBlocks(
  text: string,
  file: string,
  resourceType: string,
): ResourceBlock[] {
  const blocks: ResourceBlock[] = []
  const pattern = new RegExp(`resource\\s+"${resourceType}"\\s+"([\\w-]+)"\\s*\\{`, 'g')
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    // Group 1 is mandatory in this pattern (not `(...)?`), so a match always
    // populates it.
    const name = m[1] as string
    const line = lineNumber(text, m.index)
    const openIndex = m.index + m[0].length - 1
    const closeIndex = balancedBraceSpan(text, openIndex)
    if (closeIndex === null) {
      blocks.push({ file, line, type: resourceType, name, body: null })
      continue
    }
    blocks.push({
      file,
      line,
      type: resourceType,
      name,
      body: text.slice(openIndex + 1, closeIndex),
    })
  }
  return blocks
}

/** Raw, unstripped count of `resource "<resourceType>"` occurrences — the
 * blindness backstop's other half, unaffected by any bug in the block
 * scanner above because it never goes through it. */
export function countRawResourceDeclarations(text: string, resourceType: string): number {
  const needle = `resource "${resourceType}"`
  return text.split(needle).length - 1
}

function walkTerraformFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        walk(p)
        continue
      }
      if (entry.endsWith('.tf')) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** The log group resource name an `aws_cloudwatch_event_target` block's `arn`
 * resolves to, or `null` when it points somewhere else (Lambda, SQS, a raw
 * ARN string) — out of this guard's scope by definition. Matches anywhere in
 * the block body, not just an `arn = ` line start, so it is not fooled by
 * formatting; it specifically requires the reference to appear as the value
 * assigned to `arn` (not merely present in the block, e.g. in a comment) by
 * anchoring on `arn\s*=`. */
function resolveEventTargetLogGroup(body: string): string | null {
  const m = /arn\s*=\s*aws_cloudwatch_log_group\.([\w-]+)(?:\[[^\]]*\])?\.arn/.exec(body)
  return m ? (m[1] as string) : null
}

/** Every `aws_cloudwatch_log_group.<name>.arn` reference appearing anywhere in
 * a resource-policy block body — a policy document can name more than one
 * group across its statements, and this guard only needs to know which
 * groups a policy grants *something* to before checking the principal. */
function logGroupNamesReferencedIn(body: string): Set<string> {
  const names = new Set<string>()
  LOG_GROUP_ARN_REF.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOG_GROUP_ARN_REF.exec(body)) !== null) {
    names.add(m[1] as string)
  }
  return names
}

/**
 * Read every `.tf` file under `root`, extract EventBridge→Logs targets and
 * log-group resource policies, and report which targets have no matching
 * grant. Throws if `root` contains no `.tf` files at all — a guard reporting
 * "0 violations" because it read nothing is indistinguishable from a real
 * pass unless the empty-input case is a hard failure (#1363, #1374; see the
 * module docstring's blindness section).
 */
export function auditEventBridgeLogPermissions(root: string): EventBridgeLogPermissionReport {
  const files = walkTerraformFiles(root)
  if (files.length === 0) {
    throw new Error(
      `auditEventBridgeLogPermissions: no .tf files found under ${root} — the guard cannot ` +
        'verify anything against input it cannot see. This is a hard failure, not "0 ' +
        'violations": fix the path, do not treat an empty scan as a clean pass.',
    )
  }

  const eventTargetBlocks: ResourceBlock[] = []
  const logResourcePolicyBlocks: ResourceBlock[] = []
  let rawEventTargetCount = 0
  let rawLogPolicyCount = 0

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    rawEventTargetCount += countRawResourceDeclarations(text, EVENT_TARGET_TYPE)
    rawLogPolicyCount += countRawResourceDeclarations(text, LOG_RESOURCE_POLICY_TYPE)
    eventTargetBlocks.push(...findResourceBlocks(text, file, EVENT_TARGET_TYPE))
    logResourcePolicyBlocks.push(...findResourceBlocks(text, file, LOG_RESOURCE_POLICY_TYPE))
  }

  const unterminatedBlocks = [...eventTargetBlocks, ...logResourcePolicyBlocks].filter(
    (b) => b.body === null,
  )

  const eventTargetBlind = rawEventTargetCount > 0 && eventTargetBlocks.length === 0
  const logPolicyBlind = rawLogPolicyCount > 0 && logResourcePolicyBlocks.length === 0

  const logTargets: EventTargetLogRef[] = []
  for (const block of eventTargetBlocks) {
    if (block.body === null) continue // unterminated — already recorded above
    const logGroupName = resolveEventTargetLogGroup(block.body)
    if (logGroupName === null) continue // points elsewhere: not this guard's business
    logTargets.push({ file: block.file, line: block.line, targetName: block.name, logGroupName })
  }

  // Every log group name that SOME resource policy grants events.amazonaws.com
  // access to, gathered once so each target is checked against the full set.
  const grantedLogGroups = new Set<string>()
  for (const block of logResourcePolicyBlocks) {
    if (block.body === null) continue
    if (!grantsPrincipal(block.body, EVENTBRIDGE_PRINCIPAL)) continue
    for (const name of logGroupNamesReferencedIn(block.body)) grantedLogGroups.add(name)
  }

  const violations: EventBridgeLogPermissionViolation[] = []
  for (const target of logTargets) {
    if (grantedLogGroups.has(target.logGroupName)) continue
    violations.push({
      file: target.file,
      line: target.line,
      targetName: target.targetName,
      logGroupName: target.logGroupName,
      reason:
        `aws_cloudwatch_event_target.${target.targetName} writes to ` +
        `aws_cloudwatch_log_group.${target.logGroupName}, but no ` +
        `aws_cloudwatch_log_resource_policy grants ${EVENTBRIDGE_PRINCIPAL} access to that ` +
        'group — terraform apply will succeed and the rule will report ENABLED, but ' +
        '`put-events` will accept every event while the log group receives none (#1356).',
    })
  }

  const ok =
    !eventTargetBlind &&
    !logPolicyBlind &&
    unterminatedBlocks.length === 0 &&
    violations.length === 0

  const summary =
    `${files.length} .tf file(s) scanned under ${root}; ${eventTargetBlocks.length} ` +
    `${EVENT_TARGET_TYPE} block(s) found (${logTargets.length} targeting a log group), ` +
    `${logResourcePolicyBlocks.length} ${LOG_RESOURCE_POLICY_TYPE} block(s) found; ` +
    `${violations.length} unpermissioned, ${unterminatedBlocks.length} unterminated.`

  return {
    filesScanned: files.length,
    eventTargetBlocksFound: eventTargetBlocks.length,
    logResourcePolicyBlocksFound: logResourcePolicyBlocks.length,
    logTargets,
    unterminatedBlocks,
    violations,
    eventTargetBlind,
    logPolicyBlind,
    ok,
    summary,
  }
}

/** `auditEventBridgeLogPermissions`, but throwing with full detail on
 * failure — the shape a CI entrypoint or a test's `expect(() =>
 * ...).not.toThrow()` wants. */
export function assertEventBridgeLogPermissions(root: string): EventBridgeLogPermissionReport {
  const report = auditEventBridgeLogPermissions(root)
  if (!report.ok) {
    const lines = [report.summary]
    if (report.eventTargetBlind) {
      lines.push(
        `  BLIND (${EVENT_TARGET_TYPE}): raw source contains this resource type but the ` +
          'block extractor found none — the extractor broke, this is not evidence there are ' +
          'no event targets (#1374 was exactly this shape on an adjacent guard).',
      )
    }
    if (report.logPolicyBlind) {
      lines.push(
        `  BLIND (${LOG_RESOURCE_POLICY_TYPE}): raw source contains this resource type but ` +
          'the block extractor found none — the extractor broke, this is not evidence there ' +
          'are no log resource policies.',
      )
    }
    for (const b of report.unterminatedBlocks) {
      lines.push(
        `  UNTERMINATED ${b.file}:${b.line}  resource "${b.type}" "${b.name}" never closes — ` +
          'cannot verify what it grants or targets.',
      )
    }
    for (const v of report.violations) {
      lines.push(`  UNPERMISSIONED ${v.file}:${v.line}  ${v.reason}`)
    }
    throw new Error(lines.join('\n'))
  }
  return report
}
