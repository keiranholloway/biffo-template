import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'
import {
  assertEventBridgeLogPermissions,
  auditEventBridgeLogPermissions,
  countRawResourceDeclarations,
  findResourceBlocks,
  grantsPrincipal,
  servicePrincipalsIn,
} from './eventbridge-log-permission-guard.js'

function writeTf(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf8')
}

// The real fix as it stands in modules/cloud/aws/events/main.tf on
// origin/dev today (#1355) — the guard's own worked positive example.
const FIXED_MODULE = `
resource "aws_cloudwatch_log_group" "events" {
  name              = "/biffo/proj-dev/events"
  retention_in_days = 365
}

resource "aws_cloudwatch_event_rule" "log_all" {
  count          = var.environment != "prod" ? 1 : 0
  name           = "proj-dev-log-all"
  event_pattern  = jsonencode({ source = [{ prefix = "" }] })
}

resource "aws_cloudwatch_event_target" "log_all" {
  count          = var.environment != "prod" ? 1 : 0
  rule           = aws_cloudwatch_event_rule.log_all[0].name
  target_id      = "CloudWatchLogs"
  arn            = aws_cloudwatch_log_group.events.arn
}

resource "aws_cloudwatch_log_resource_policy" "events_from_eventbridge" {
  count       = var.environment != "prod" ? 1 : 0
  policy_name = "proj-dev-events-from-eventbridge"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "\${aws_cloudwatch_log_group.events.arn}:*"
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.log_all[0].arn }
      }
    }]
  })
}
`

// The shipped-broken shape (#1356 as filed): identical target, no policy at
// all — this is literally what modules/cloud/aws/events/main.tf looked like
// before #1355.
const BROKEN_MODULE = `
resource "aws_cloudwatch_log_group" "events" {
  name              = "/biffo/proj-dev/events"
  retention_in_days = 365
}

resource "aws_cloudwatch_event_rule" "log_all" {
  count          = var.environment != "prod" ? 1 : 0
  name           = "proj-dev-log-all"
  event_pattern  = jsonencode({ source = [{ prefix = "" }] })
}

resource "aws_cloudwatch_event_target" "log_all" {
  count          = var.environment != "prod" ? 1 : 0
  rule           = aws_cloudwatch_event_rule.log_all[0].name
  target_id      = "CloudWatchLogs"
  arn            = aws_cloudwatch_log_group.events.arn
}
`

describe('findResourceBlocks', () => {
  it('extracts a resource block body between balanced braces', () => {
    const blocks = findResourceBlocks(FIXED_MODULE, 'x.tf', 'aws_cloudwatch_event_target')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].name).toBe('log_all')
    expect(blocks[0].body).toContain('aws_cloudwatch_log_group.events.arn')
  })

  it('does not stop at a nested brace inside jsonencode(...)', () => {
    const blocks = findResourceBlocks(FIXED_MODULE, 'x.tf', 'aws_cloudwatch_log_resource_policy')
    expect(blocks).toHaveLength(1)
    // If the scanner stopped at the first inner `}` (Principal = { ... }),
    // the Resource line further down would be missing from the captured body.
    expect(blocks[0].body).toContain('aws_cloudwatch_log_group.events.arn')
    expect(blocks[0].body).toContain('events.amazonaws.com')
  })

  it('records an unterminated block rather than dropping it', () => {
    const text = 'resource "aws_cloudwatch_event_target" "broken" {\n  arn = "x"\n'
    const blocks = findResourceBlocks(text, 'x.tf', 'aws_cloudwatch_event_target')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].body).toBeNull()
  })

  it('returns nothing for a resource type not present', () => {
    const blocks = findResourceBlocks(FIXED_MODULE, 'x.tf', 'aws_lambda_permission')
    expect(blocks).toEqual([])
  })
})

describe('countRawResourceDeclarations', () => {
  it('counts independently of the block scanner', () => {
    expect(countRawResourceDeclarations(FIXED_MODULE, 'aws_cloudwatch_event_target')).toBe(1)
    expect(countRawResourceDeclarations(FIXED_MODULE, 'aws_cloudwatch_log_resource_policy')).toBe(1)
    expect(countRawResourceDeclarations(FIXED_MODULE, 'aws_lambda_permission')).toBe(0)
  })
})

// ── Exact-match principal check (js/incomplete-url-substring-sanitization) ──
//
// A raw `.includes('events.amazonaws.com')` reads a Service value carrying the
// real string as a SUBSTRING as if it were the real principal — a policy
// scoped to `events.amazonaws.com.attacker.example` or `notevents.amazonaws.com`
// would pass. That is the exact "reads permissioned but isn't" shape this
// whole guard exists to catch, reproduced inside the guard's own check
// (flagged by CodeQL, high severity). These pin the fix as exact-value
// matching, not substring matching.
describe('servicePrincipalsIn / grantsPrincipal', () => {
  it('extracts a single-string Service value', () => {
    expect(servicePrincipalsIn('Principal = { Service = "events.amazonaws.com" }')).toEqual([
      'events.amazonaws.com',
    ])
  })

  it('extracts every value from a list-form Service', () => {
    expect(
      servicePrincipalsIn(
        'Principal = { Service = ["events.amazonaws.com", "other.amazonaws.com"] }',
      ),
    ).toEqual(['events.amazonaws.com', 'other.amazonaws.com'])
  })

  it('matches the real principal exactly', () => {
    expect(grantsPrincipal('Service = "events.amazonaws.com"', 'events.amazonaws.com')).toBe(true)
  })

  it('does NOT match a principal carrying the real string as a suffix-attack host', () => {
    // events.amazonaws.com.attacker.example CONTAINS the real string but is a
    // different, attacker-controlled principal.
    expect(
      grantsPrincipal('Service = "events.amazonaws.com.attacker.example"', 'events.amazonaws.com'),
    ).toBe(false)
  })

  it('does NOT match a principal carrying the real string as a prefix-attack host', () => {
    expect(grantsPrincipal('Service = "notevents.amazonaws.com"', 'events.amazonaws.com')).toBe(
      false,
    )
  })

  it('does NOT match the string merely appearing outside a Service assignment', () => {
    // A comment or an unrelated field mentioning the principal must never
    // read as a grant — only a real `Service = ` assignment counts.
    expect(
      grantsPrincipal(
        '# events.amazonaws.com is what SHOULD be granted here, but is not\n' +
          'Principal = { Service = "logs.amazonaws.com" }',
        'events.amazonaws.com',
      ),
    ).toBe(false)
  })
})

describe('auditEventBridgeLogPermissions', () => {
  it('passes the fixed shape: target has a matching resource policy', () => {
    const dir = makeTmpDir('ebridge-fixed')
    writeTf(dir, 'main.tf', FIXED_MODULE)
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(true)
    expect(report.violations).toEqual([])
    expect(report.logTargets).toHaveLength(1)
    expect(report.eventTargetBlind).toBe(false)
    expect(report.logPolicyBlind).toBe(false)
  })

  it('fails the shipped-broken shape: target with no resource policy at all', () => {
    const dir = makeTmpDir('ebridge-broken')
    writeTf(dir, 'main.tf', BROKEN_MODULE)
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].targetName).toBe('log_all')
    expect(report.violations[0].logGroupName).toBe('events')
  })

  it('fails when a resource policy exists but grants the wrong principal', () => {
    const dir = makeTmpDir('ebridge-wrong-principal')
    writeTf(
      dir,
      'main.tf',
      BROKEN_MODULE +
        `
resource "aws_cloudwatch_log_resource_policy" "wrong" {
  policy_name = "x"
  policy_document = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "logs.amazonaws.com" }
      Action    = ["logs:PutLogEvents"]
      Resource  = "\${aws_cloudwatch_log_group.events.arn}:*"
    }]
  })
}
`,
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
  })

  it('fails when the granted principal carries the real one as a suffix-attack host', () => {
    // events.amazonaws.com.attacker.example is a substring superset of the
    // real principal, not the real principal. Before the exact-match fix, a
    // raw .includes() check treated this as granted.
    const dir = makeTmpDir('ebridge-principal-suffix-attack')
    writeTf(
      dir,
      'main.tf',
      BROKEN_MODULE +
        `
resource "aws_cloudwatch_log_resource_policy" "attacker" {
  policy_name = "x"
  policy_document = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com.attacker.example" }
      Action    = ["logs:PutLogEvents"]
      Resource  = "\${aws_cloudwatch_log_group.events.arn}:*"
    }]
  })
}
`,
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].logGroupName).toBe('events')
  })

  it('fails when the granted principal carries the real one as a prefix-attack host', () => {
    const dir = makeTmpDir('ebridge-principal-prefix-attack')
    writeTf(
      dir,
      'main.tf',
      BROKEN_MODULE +
        `
resource "aws_cloudwatch_log_resource_policy" "not_events" {
  policy_name = "x"
  policy_document = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "notevents.amazonaws.com" }
      Action    = ["logs:PutLogEvents"]
      Resource  = "\${aws_cloudwatch_log_group.events.arn}:*"
    }]
  })
}
`,
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].logGroupName).toBe('events')
  })

  it('fails when a resource policy exists but names a different log group', () => {
    const dir = makeTmpDir('ebridge-wrong-group')
    writeTf(
      dir,
      'main.tf',
      BROKEN_MODULE +
        `
resource "aws_cloudwatch_log_group" "other" {
  name = "/biffo/other"
}

resource "aws_cloudwatch_log_resource_policy" "wrong_group" {
  policy_name = "x"
  policy_document = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = ["logs:PutLogEvents"]
      Resource  = "\${aws_cloudwatch_log_group.other.arn}:*"
    }]
  })
}
`,
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].logGroupName).toBe('events')
  })

  it('does not flag a target pointing at something other than a log group', () => {
    // The plugin-template shape (modules/plugins/_template/main.tf): the
    // event target's arn is a Lambda function ARN, not a log group — out of
    // this guard's scope by definition, and must not be reported.
    const dir = makeTmpDir('ebridge-lambda-target')
    writeTf(
      dir,
      'main.tf',
      `
resource "aws_cloudwatch_event_target" "subscription" {
  count          = local.has_subscriptions ? 1 : 0
  rule           = aws_cloudwatch_event_rule.subscription[0].name
  target_id      = "plugin-lambda"
  arn            = module.function.function_arn
}

resource "aws_lambda_permission" "subscription" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.function.function_name
  principal     = "events.amazonaws.com"
}
`,
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(true)
    expect(report.logTargets).toEqual([])
    expect(report.violations).toEqual([])
  })

  it('resolves a count-indexed log group reference', () => {
    const dir = makeTmpDir('ebridge-indexed')
    writeTf(
      dir,
      'main.tf',
      `
resource "aws_cloudwatch_log_group" "events" {
  count = 1
  name  = "/biffo/x"
}

resource "aws_cloudwatch_event_target" "log_all" {
  rule      = "x"
  target_id = "CloudWatchLogs"
  arn       = aws_cloudwatch_log_group.events[0].arn
}

resource "aws_cloudwatch_log_resource_policy" "grant" {
  policy_name = "x"
  policy_document = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Resource  = "\${aws_cloudwatch_log_group.events[0].arn}:*"
    }]
  })
}
`,
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(true)
    expect(report.logTargets).toHaveLength(1)
  })

  // ── Fail-closed-on-zero (CRITICAL per the dispatch brief; #1363/#1374) ────

  it('throws when the root has no .tf files at all — cannot see input is not a pass', () => {
    const dir = makeTmpDir('ebridge-empty')
    writeFileSync(join(dir, 'README.md'), 'nothing terraform here', 'utf8')
    expect(() => auditEventBridgeLogPermissions(dir)).toThrow(/no \.tf files found/)
  })

  it('throws on a completely empty directory, not merely returns ok:true', () => {
    const dir = makeTmpDir('ebridge-dirempty')
    expect(() => auditEventBridgeLogPermissions(dir)).toThrow(/no \.tf files found/)
  })

  it('reports eventTargetBlind when raw text has the resource but the scanner cannot parse it', () => {
    // Simulate the extractor breaking: the resource header is malformed
    // (missing the opening brace entirely) so the regex that requires a
    // trailing `{` never matches, while the raw substring is still present.
    const dir = makeTmpDir('ebridge-blind')
    writeTf(
      dir,
      'main.tf',
      'resource "aws_cloudwatch_event_target" "log_all"\n  arn = aws_cloudwatch_log_group.events.arn\n',
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.eventTargetBlind).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('fails on an unterminated resource block rather than silently ignoring it', () => {
    const dir = makeTmpDir('ebridge-unterminated')
    writeTf(
      dir,
      'main.tf',
      'resource "aws_cloudwatch_event_target" "log_all" {\n  arn = aws_cloudwatch_log_group.events.arn\n',
    )
    const report = auditEventBridgeLogPermissions(dir)
    expect(report.ok).toBe(false)
    expect(report.unterminatedBlocks).toHaveLength(1)
  })

  it('assertEventBridgeLogPermissions throws with detail on the broken shape', () => {
    const dir = makeTmpDir('ebridge-assert-broken')
    writeTf(dir, 'main.tf', BROKEN_MODULE)
    expect(() => assertEventBridgeLogPermissions(dir)).toThrow(/UNPERMISSIONED/)
  })

  it('assertEventBridgeLogPermissions does not throw on the fixed shape', () => {
    const dir = makeTmpDir('ebridge-assert-fixed')
    writeTf(dir, 'main.tf', FIXED_MODULE)
    expect(() => assertEventBridgeLogPermissions(dir)).not.toThrow()
  })

  // ── Real estate measurement ────────────────────────────────────────────

  it('passes against this repo’s own modules/cloud/aws (the real, fixed #1355 module)', () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    const report = auditEventBridgeLogPermissions(join(repoRoot, 'modules', 'cloud', 'aws'))
    expect(report.ok).toBe(true)
    // At least the events module's own target must have been seen and matched
    // — a false "ok: true" from finding zero targets anywhere would also
    // satisfy a weaker assertion, so pin the real count.
    expect(report.logTargets.some((t) => t.logGroupName === 'events')).toBe(true)
    expect(report.violations).toEqual([])
  })

  it('passes against modules/plugins/_template (event target aims at Lambda, not logs)', () => {
    // modules/plugins/ itself is user-owned (biffo plugin install writes a
    // third-party plugin's terraform/ there) — modules/plugins/_template/ is
    // the template-owned scaffold source (longest-prefix-wins), so this is
    // the one instance-safe subtree to assert on directly (#367/#384).
    const repoRoot = join(__dirname, '..', '..', '..')
    const report = auditEventBridgeLogPermissions(join(repoRoot, 'modules', 'plugins', '_template'))
    expect(report.ok).toBe(true)
    expect(report.logTargets).toEqual([])
  })
})
