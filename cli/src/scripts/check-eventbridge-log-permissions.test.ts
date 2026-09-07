/**
 * `biffo check eventbridge-log-permissions` (biffo-template#1413's wiring,
 * #1906's satellite fix).
 *
 * `runEventBridgeLogPermissionCheck` takes no options — it always resolves
 * its root via `git rev-parse --show-toplevel` — so these tests mock the
 * underlying `execa` package (not `../lib/exec.js`, which just wraps it) to
 * point that resolution at a disposable tmp tree, the same technique
 * `check-branch-protection.test.ts` uses for its own git call. The
 * underlying `auditEventBridgeLogPermissions` audit logic (violations,
 * blindness, unterminated blocks) is already exercised directly in
 * `../lib/eventbridge-log-permission-guard.test.ts`; this file proves the CI
 * entrypoint's own error handling, not the audit itself.
 *
 * The satellite-shaped case (#1906) is the one this file exists to add: a
 * repo with no `.tf` files at all used to be indistinguishable from a real
 * instance whose Terraform scan had broken, and
 * `runEventBridgeLogPermissionCheck` hard-failed on every satellite in the
 * shared-sync rehearsal. A genuine violation on a real .tf tree must still
 * fail exactly as before; that is exercised here too, so the fix cannot be
 * read as silencing the real signal along with the false one.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runEventBridgeLogPermissionCheck } from './check-eventbridge-log-permissions.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function setRoot(root: string): void {
  vi.mocked(execa).mockResolvedValue({ stdout: root } as never)
}

// The shipped-broken shape #1356 was filed over: an event target with no
// matching log resource policy at all — reused verbatim from
// eventbridge-log-permission-guard.test.ts's own BROKEN_MODULE fixture.
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

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

describe('runEventBridgeLogPermissionCheck', () => {
  it('is not applicable (exit 0, no crash) in a satellite tree with no .tf files at all (#1906)', async () => {
    const root = makeTmpDir('eventbridge-log-satellite')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(root)

    await expect(runEventBridgeLogPermissionCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('no .tf files found under')
    expect(logged.toLowerCase()).toContain('not applicable')
  })

  it('STILL fails (exit 1) on a real unpermissioned event target', async () => {
    const root = makeTmpDir('eventbridge-log-real-violation')
    write(root, 'modules/cloud/aws/events/main.tf', BROKEN_MODULE)
    setRoot(root)

    await expect(runEventBridgeLogPermissionCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('UNPERMISSIONED')
  })
})
