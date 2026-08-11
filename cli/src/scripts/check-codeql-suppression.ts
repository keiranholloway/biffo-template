/**
 * CI entrypoint for the codeql-suppression-comment guard (#1491): refuse a
 * `// codeql[query-id]`-shaped comment anywhere in `cli/src`, because it does
 * not suppress anything here and reads as though it does. See
 * `cli/src/lib/codeql-suppression-guard.ts` for the full evidence trail
 * (alert #21 open under the exact comment, alerts #12/#13 dismissed by an
 * explicit API/UI action instead).
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execa } from 'execa'
import { sweepCodeqlSuppressionComments } from '../lib/codeql-suppression-guard.js'

export async function runCodeqlSuppressionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const hits = sweepCodeqlSuppressionComments(join(root, 'cli', 'src'))

  if (hits.length > 0) {
    console.error(
      '✗ codeql-suppression guard: found a `codeql[...]`-shaped comment, which does not ' +
        'suppress anything in this repo (#1491) — dismiss the real alert instead ' +
        '(UI, or `PATCH .../code-scanning/alerts/<n>` with a recorded reason)\n',
    )
    for (const hit of hits) {
      console.error(`  ${relative(root, hit.path)}:${hit.line}  ${hit.text.trim()}`)
    }
    process.exit(1)
  }

  // Read-back check, same shape as the pipe-trap guard: refuse to report
  // success over zero input if the scan target somehow vanished.
  const probe = readFileSync(join(root, 'cli', 'src', 'lib', 'codeql-suppression-guard.ts'), 'utf8')
  if (probe.length === 0) {
    console.error('✗ codeql-suppression guard: scan target read empty — refusing a false green.')
    process.exit(1)
  }

  console.log('✓ codeql-suppression guard: no dead `codeql[...]` suppression comment found')
}
