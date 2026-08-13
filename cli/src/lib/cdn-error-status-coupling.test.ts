/**
 * The #1529 demote/restore pair must never be half-configured (issue #1574).
 *
 * ## What is coupled, and why half of it is worse than none of it
 *
 * CloudFront's `custom_error_response` is distribution-wide — it cannot be
 * scoped to a cache behaviour — so it was rewriting every genuine API 403/404
 * JSON body into the portal's SPA shell. #1529 fixes that on the three API
 * behaviours with a PAIR of functions:
 *
 *   - **demote** (Lambda@Edge, origin-response): turns the real 403/404 into a
 *     200 and stashes the true status in `x-biffo-true-status`, so
 *     `custom_error_response` never fires for that response;
 *   - **restore** (CloudFront Function, viewer-response): puts the true status
 *     back, after `custom_error_response` has had its chance and declined.
 *
 * Demote WITHOUT restore is not a degraded fix, it is a new and worse defect:
 * clients receive **HTTP 200 on real API errors**. `res.ok` is true, no error
 * path runs, retries never fire and monitoring sees success. That is the exact
 * failure #647 already recorded once, reintroduced from the other end.
 *
 * ## Why the invariant is asserted HERE
 *
 * The module makes the half-configured state unrepresentable by construction:
 * ONE variable (`error_status_restore_lambda_arn`) gates BOTH associations on
 * all three API behaviours, so there is no second switch to forget. That is a
 * property of how main.tf happens to be written today, and nothing but this
 * test stops a later refactor — splitting the variable in two, adding a fourth
 * API behaviour, moving the demote association to `default_cache_behavior` —
 * from quietly reintroducing it.
 *
 * It is deliberately NOT a workflow guard. #1574 exists precisely because a
 * workflow silently failed to set the variable, so "a workflow enforces it" is
 * the assumption that already broke. A workflow guard also covers only the CI
 * path, while `.github/` and `modules/` are template-owned and `infra/` is not
 * (core-manifest.json) — an instance authors its own environment stacks and
 * can apply them by hand. The module is the one layer every route to a
 * CloudFront distribution passes through.
 *
 * Companion guards: `workflow-global-output-wiring.test.ts` (the variable is
 * actually wired from the global stack to the regional one) and
 * `cdn-error-status-guard.test.ts` (`custom_error_response` never claims 200).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripComments } from './terraform-input-guard.js'

const repoRoot = join(__dirname, '..', '..', '..')
const cdnDir = join(repoRoot, 'modules', 'cloud', 'aws', 'cdn')

/** The single variable that arms both halves. */
const GATE = 'var.error_status_restore_lambda_arn'

/**
 * Extract balanced `{ … }` blocks whose opening line matches `header`.
 *
 * Comments are stripped first (shared with the #322 guard) so prose describing
 * a block cannot be mistaken for one. Naive brace counting is safe on HCL here:
 * the only braces inside string literals are `${…}` interpolations, which are
 * themselves balanced.
 */
function blocksMatching(source: string, header: RegExp): string[] {
  const src = stripComments(source)
  const found: string[] = []
  const re = new RegExp(header.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index)
    if (open === -1) continue
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) {
          found.push(src.slice(open, i + 1))
          break
        }
      }
    }
  }
  return found
}

const mainTf = readFileSync(join(cdnDir, 'main.tf'), 'utf8')
const variablesTf = readFileSync(join(cdnDir, 'variables.tf'), 'utf8')

const behaviours = () => blocksMatching(mainTf, /dynamic\s+"ordered_cache_behavior"/)
const hasDemote = (b: string) => /event_type\s*=\s*"origin-response"/.test(b)
const hasRestore = (b: string) => /event_type\s*=\s*"viewer-response"/.test(b)

/** The three API behaviours the fix applies to, by the variable that gates each. */
const API_BEHAVIOUR_GATES = [
  'var.plugin_host_api_domain',
  'var.core_api_health_domain',
  'var.tracked_link_api_domain',
]

describe('CDN error-status demote/restore coupling (#1529, #1574)', () => {
  it('finds the behaviour blocks it asserts over', () => {
    // Guards the guard: a rename or an HCL reformat that makes the extractor
    // match nothing would otherwise turn every assertion below into a vacuous
    // pass — the failure shape this repo has already been bitten by.
    const found = behaviours()
    expect(found.length).toBeGreaterThanOrEqual(3)
    expect(found.some(hasDemote)).toBe(true)
    expect(found.some(hasRestore)).toBe(true)
  })

  it('never associates demote without restore, or restore without demote', () => {
    for (const block of behaviours()) {
      const pattern = /path_pattern\s*=\s*(\S+)/.exec(block)?.[1] ?? '(unknown behaviour)'
      expect(
        hasDemote(block) === hasRestore(block),
        `Behaviour ${pattern} has origin-response demote=${hasDemote(block)} but ` +
          `viewer-response restore=${hasRestore(block)}. Demote alone returns HTTP 200 ` +
          `on real API errors — worse than the bug #1529 fixes. Add both or neither.`,
      ).toBe(true)
    }
  })

  it('gates both halves on the same single variable, so one cannot be set without the other', () => {
    const coupled = behaviours().filter(hasDemote)
    expect(coupled).toHaveLength(3)

    for (const block of coupled) {
      const demote = blocksMatching(block, /dynamic\s+"lambda_function_association"/)
      const restore = blocksMatching(block, /dynamic\s+"function_association"/)
      expect(demote).toHaveLength(1)
      expect(restore).toHaveLength(1)

      const forEachOf = (b: string) => /for_each\s*=\s*([^\n]*)/.exec(b)?.[1] ?? ''
      expect(forEachOf(demote[0]), 'the demote association must be gated on ' + GATE).toContain(
        GATE,
      )
      expect(
        forEachOf(restore[0]),
        'the restore association must be gated on the SAME variable as demote',
      ).toContain(GATE)
    }
  })

  it('applies the pair to exactly the three API behaviours, and to nothing else', () => {
    // A portal or sibling behaviour gaining a demote association would send
    // HTTP 200 for every missing static file too — and there is no restore on
    // those behaviours to undo it.
    const coupled = behaviours().filter(hasDemote)
    const gates = coupled.map((b) => /for_each\s*=\s*([^\n]*)/.exec(b)?.[1] ?? '')
    for (const apiGate of API_BEHAVIOUR_GATES) {
      expect(
        gates.some((g) => g.includes(apiGate)),
        `no coupled behaviour is gated on ${apiGate}`,
      ).toBe(true)
    }
    // No demote anywhere outside those three — including default_cache_behavior,
    // which is a static block the extractor above deliberately does not read.
    const allDemotes = stripComments(mainTf).match(/event_type\s*=\s*"origin-response"/g) ?? []
    expect(allDemotes).toHaveLength(3)
  })

  it('creates the restore CloudFront Function under the same gate', () => {
    const fn = blocksMatching(
      mainTf,
      /resource\s+"aws_cloudfront_function"\s+"error_status_restore"/,
    )
    expect(fn).toHaveLength(1)
    expect(/count\s*=\s*([^\n]*)/.exec(fn[0])?.[1] ?? '').toContain(GATE)
  })
})

describe('error_status_restore_lambda_arn rejects a set-but-unusable value (#1574)', () => {
  /**
   * Pull the validation regex out of the module and exercise it directly, so
   * this asserts the rule's BEHAVIOUR rather than the presence of a block.
   * Lambda@Edge associations need a qualified ARN (trailing numeric version,
   * never $LATEST) in us-east-1; CloudFront rejects anything else with an
   * error that names neither the variable nor the reason.
   */
  const pattern = () => {
    const block = blocksMatching(variablesTf, /variable\s+"error_status_restore_lambda_arn"/)[0]
    expect(block, 'variable error_status_restore_lambda_arn not found').toBeTruthy()
    const src = /regex\("([^"]+)"/.exec(block)?.[1]
    expect(src, 'no validation regex on error_status_restore_lambda_arn').toBeTruthy()
    return new RegExp(src as string)
  }

  const GOOD = 'arn:aws:lambda:us-east-1:123456789012:function:my-project-error-status-demote:7'

  it('accepts a qualified us-east-1 ARN', () => {
    expect(pattern().test(GOOD)).toBe(true)
  })

  it.each([
    ['unqualified (no version)', 'arn:aws:lambda:us-east-1:123456789012:function:demote'],
    ['$LATEST', 'arn:aws:lambda:us-east-1:123456789012:function:demote:$LATEST'],
    ['wrong region', 'arn:aws:lambda:eu-west-1:123456789012:function:demote:7'],
    ['not an ARN at all', 'error: Output "error_status_restore_lambda_arn" not found'],
  ])('rejects %s', (_label, value) => {
    expect(pattern().test(value)).toBe(false)
  })

  it('still allows empty, which is the safe off-state', () => {
    const block = blocksMatching(variablesTf, /variable\s+"error_status_restore_lambda_arn"/)[0]
    expect(block).toContain('var.error_status_restore_lambda_arn == ""')
    expect(block).toContain('default     = ""')
  })
})
