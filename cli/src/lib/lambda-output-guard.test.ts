import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTemplateOwned, readCoreManifest } from './core-manifest.js'
import {
  checkLambdaOutput,
  checkWorkflowSource,
  isOutputSuppressed,
  joinContinuations,
} from './lambda-output-guard.js'
import { findWorkflowFiles } from './terraform-input-guard.js'

const repoRoot = join(__dirname, '..', '..', '..')

/** The exact shape of the bug in #334: update-function-code with no output flag. */
const BROKEN = `
name: Deploy
jobs:
  go:
    steps:
      - run: |
          aws lambda update-function-code \\
            --function-name "$FN" \\
            --zip-file fileb://../lambda.zip
`

/** The fix as shipped: output narrowed to the update status. */
const FIXED = `
name: Deploy
jobs:
  go:
    steps:
      - run: |
          aws lambda update-function-code \\
            --function-name "$FN" \\
            --zip-file fileb://../lambda.zip \\
            --output text --query 'LastUpdateStatus'
`

describe('joinContinuations', () => {
  it('collapses a backslash-continued command into one logical line', () => {
    const joined = joinContinuations(
      'aws lambda update-function-code \\\n  --zip-file x \\\n  --output text',
    )
    const cmd = joined.find((l) => l.text.includes('update-function-code'))
    expect(cmd?.text).toContain('--output text')
    // The reported line is where the invocation starts, not where it ends.
    expect(cmd?.startLine).toBe(1)
  })
})

describe('isOutputSuppressed', () => {
  it('accepts --output text with a scalar --query', () => {
    expect(
      isOutputSuppressed(
        "aws lambda update-function-code --output text --query 'LastUpdateStatus'",
      ),
    ).toBe(true)
  })

  it('accepts a redirect to /dev/null', () => {
    expect(isOutputSuppressed('aws lambda update-function-code --zip-file x > /dev/null')).toBe(
      true,
    )
  })

  it('rejects a bare invocation', () => {
    expect(isOutputSuppressed('aws lambda update-function-code --zip-file x')).toBe(false)
  })

  it('rejects narrowing back onto the environment, which re-leaks the secrets', () => {
    expect(
      isOutputSuppressed(
        "aws lambda update-function-code --output text --query 'Environment.Variables'",
      ),
    ).toBe(false)
  })
})

describe('checkWorkflowSource', () => {
  it('FAILS on the real #334 regression', () => {
    const violations = checkWorkflowSource('bad.yml', BROKEN)
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toContain('#334')
  })

  it('passes once the output is narrowed', () => {
    expect(checkWorkflowSource('good.yml', FIXED)).toEqual([])
  })

  it('does not accept a comment in place of the fix', () => {
    // The trap a previous guard in this repo fell into: matching its own prose.
    // Here the suppression flags appear only in a comment, so the actual command
    // still leaks and must still be flagged.
    const commentOnly = `
name: Deploy
jobs:
  go:
    steps:
      - run: |
          # fixed by --output text --query 'LastUpdateStatus'
          aws lambda update-function-code \\
            --function-name "$FN" \\
            --zip-file fileb://../lambda.zip
`
    expect(checkWorkflowSource('trap.yml', commentOnly)).toHaveLength(1)
  })

  it('does not flag prose that merely mentions the command', () => {
    const prose = `
name: Docs
jobs:
  go:
    steps:
      # This runs aws lambda update-function-code under the hood.
      - run: echo hi
`
    expect(checkWorkflowSource('prose.yml', prose)).toEqual([])
  })

  it('flags update-function-configuration too, not just -code', () => {
    const src = `
jobs:
  a:
    steps:
      - run: aws lambda update-function-configuration --function-name x --environment Variables={A=b}
`
    expect(checkWorkflowSource('cfg.yml', src)).toHaveLength(1)
  })

  it('does not flag read-only lambda calls like get-function', () => {
    const src = `
jobs:
  a:
    steps:
      - run: aws lambda get-function --function-name x >/dev/null 2>&1
`
    expect(checkWorkflowSource('get.yml', src)).toEqual([])
  })
})

describe('the repository itself', () => {
  it('has no aws lambda update-function-* call that emits an unfiltered response', () => {
    expect(checkLambdaOutput(repoRoot)).toEqual([])
  })
})

/**
 * Issue #325. This guard lives under the template-owned `cli/`, so `biffo core
 * upgrade` distributes it to every instance. Anything it *scans* must therefore
 * be template-owned too, or the upgrade ships an instance an assertion whose
 * subject it cannot receive.
 */
describe('scan scope stays inside the template-owned boundary (#325)', () => {
  const manifest = readCoreManifest(repoRoot)

  it('scans both the root and skeleton workflow trees', () => {
    const files = findWorkflowFiles(repoRoot)
    expect(files.some((f) => f.startsWith('.github/workflows/'))).toBe(true)
    expect(files.some((f) => f.startsWith('_skeletons/'))).toBe(true)
  })

  it('scans only template-owned paths, so every instance can receive the fix', () => {
    const unowned = findWorkflowFiles(repoRoot).filter((f) => !isTemplateOwned(f, manifest))
    expect(unowned).toEqual([])
  })
})
