/**
 * Drift guard against leaking Lambda env vars into CI logs (issue #334).
 *
 * `aws lambda update-function-code` (and `update-function-configuration`) print,
 * by default, the *entire* resolved function configuration as JSON — including
 * `Environment.Variables`, every env var on the function in plaintext. For the
 * Core API that is the master `DATABASE_URL` and (since #253) the
 * `BIFFO_APP_DATABASE_URL`; for a plugin Lambda it is whatever secrets it
 * carries. GitHub Actions masks only *registered* secrets, and these values come
 * from Secrets Manager / Terraform at deploy time, not from GitHub secrets — so
 * they printed verbatim into the Actions log on every deploy. A public instance
 * would have exposed live DB credentials to the world.
 *
 * The response is not even consumed: every call is immediately followed by
 * `aws lambda wait function-updated`. So narrowing the output to the update
 * status (`--output text --query 'LastUpdateStatus'`) or discarding it
 * (`> /dev/null`) loses nothing and closes the leak.
 *
 * This guard enforces that at source level: every `aws lambda update-function-*`
 * invocation in a workflow must suppress or narrow its output. It reconstructs
 * shell line-continuations (`\`) so a multi-line invocation is checked as one
 * command, and it strips comments first so a call cannot appear "fixed" by a
 * comment that merely quotes the flags — a previous guard in this repo passed by
 * matching its own explanatory prose (see #322), and the tests here assert this
 * one *fails* on a known-bad fixture.
 *
 * Scope note (#325): this lives under the template-owned `cli/`, so `biffo core
 * upgrade` ships it to every instance. It therefore scans only template-owned
 * workflow trees (`.github/workflows/` and `_skeletons/`), which every instance
 * can receive the corresponding fix for.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findWorkflowFiles, stripComments, type Violation } from './terraform-input-guard.js'

/**
 * The `aws lambda update-function-*` subcommands whose default output is the
 * full function configuration (env vars included).
 */
export const GUARDED_LAMBDA_SUBCOMMANDS = [
  'update-function-code',
  'update-function-configuration',
] as const

export interface LogicalLine {
  text: string
  startLine: number
}

/**
 * Collapses shell line-continuations into single logical lines so a command
 * split across several `\`-terminated lines is checked as one. The reported
 * line number is where the logical line *starts*, which is the `aws lambda …`
 * line an author would look at.
 */
export function joinContinuations(source: string): LogicalLine[] {
  const rawLines = source.split('\n')
  const logical: LogicalLine[] = []
  let buffer = ''
  let start = 0

  rawLines.forEach((raw, index) => {
    const lineNo = index + 1
    const trimmedEnd = raw.replace(/\s+$/, '')
    const continues = trimmedEnd.endsWith('\\')
    const piece = continues ? trimmedEnd.slice(0, -1) : trimmedEnd
    if (buffer === '') start = lineNo
    buffer = buffer === '' ? piece : `${buffer} ${piece.replace(/^\s+/, '')}`
    if (!continues) {
      logical.push({ text: buffer, startLine: start })
      buffer = ''
    }
  })
  if (buffer !== '') logical.push({ text: buffer, startLine: start })

  return logical
}

/**
 * Whether a single (already line-joined, comment-stripped) command suppresses or
 * narrows its output. Two accepted forms:
 *
 *   - stdout redirected to `/dev/null`, or
 *   - `--output text` together with a `--query` that projects a scalar field.
 *
 * A `--query` that re-selects the environment (e.g. `Environment.Variables`) is
 * explicitly rejected: narrowing to the very thing that carries the secrets is
 * not a fix.
 */
export function isOutputSuppressed(command: string): boolean {
  if (/>\s*\/dev\/null/.test(command)) return true

  const hasTextOutput = /--output\s+text\b/.test(command)
  const queryMatch = /--query\s+(['"]?)([^\s'"]+)\1/.exec(command)
  if (hasTextOutput && queryMatch) {
    const projection = queryMatch[2] ?? ''
    if (!/environment/i.test(projection)) return true
  }

  return false
}

/** Scans one workflow's source for unsuppressed `update-function-*` calls. */
export function checkWorkflowSource(file: string, rawSource: string): Violation[] {
  const violations: Violation[] = []
  const source = stripComments(rawSource)

  for (const { text, startLine } of joinContinuations(source)) {
    for (const subcommand of GUARDED_LAMBDA_SUBCOMMANDS) {
      const invocation = new RegExp(`(?:^|[\\s;&|(])aws\\s+lambda\\s+${subcommand}\\b`)
      if (!invocation.test(text)) continue
      if (isOutputSuppressed(text)) continue

      violations.push({
        file,
        line: startLine,
        message:
          `aws lambda ${subcommand} does not suppress its output. Its default is ` +
          `the full function configuration as JSON — Environment.Variables in ` +
          `plaintext — which leaks DB credentials into the Actions log (#334). ` +
          `Add --output text --query 'LastUpdateStatus' (or redirect to /dev/null).`,
      })
    }
  }

  return violations
}

/** Checks every template-owned workflow. Returns [] when the convention holds. */
export function checkLambdaOutput(repoRoot: string): Violation[] {
  return findWorkflowFiles(repoRoot).flatMap((file) =>
    checkWorkflowSource(file, readFileSync(join(repoRoot, file), 'utf8')),
  )
}
