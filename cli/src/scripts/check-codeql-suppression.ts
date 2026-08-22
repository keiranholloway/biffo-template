/**
 * CI entrypoint for the codeql-suppression-comment guard (#1491): refuse a
 * `// codeql[query-id]`-shaped comment anywhere in `cli/src`, because it does
 * not suppress anything here and reads as though it does. See
 * `cli/src/lib/codeql-suppression-guard.ts` for the full evidence trail
 * (alert #21 open under the exact comment, alerts #12/#13 dismissed by an
 * explicit API/UI action instead).
 */
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execa } from '../lib/exec.js'
import {
  countSourceFiles,
  sweepCodeqlSuppressionComments,
} from '../lib/codeql-suppression-guard.js'

export async function runCodeqlSuppressionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  // This guard scans the CLI's own source. A repo without `cli/` — every
  // instance and satellite the workflow is distributed to — has nothing for it
  // to read, so it reports that plainly and exits clean rather than crashing.
  //
  // It used to do neither: it swept a non-existent directory and then read
  // `cli/src/lib/codeql-suppression-guard.ts` as a read-back canary, which
  // exists only in a biffo-template checkout. An instance installs the CLI from
  // npm (ships `dist`, not `src`), so the step died with ENOENT in every repo
  // it reached and the check could never pass there — found blocking a core
  // upgrade in tabsii-platform at 0.276.9.
  //
  // Skipping is stated, not silent: a lane that cannot run must say so, since
  // a quiet pass over zero input is the failure this estate keeps paying for.
  const scanRoot = join(root, 'cli', 'src')
  if (!existsSync(scanRoot)) {
    console.log(
      '— codeql-suppression guard: skipped — no cli/src in this repo, so there is ' +
        'no CLI source to scan.',
    )
    return
  }

  const hits = sweepCodeqlSuppressionComments(scanRoot)

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
  // success over zero input.
  //
  // This used to read `cli/src/lib/codeql-suppression-guard.ts` as its canary,
  // which exists only in a biffo-template checkout — an instance installs the
  // CLI from npm (ships `dist`, not `src`) and has no `cli/` directory, so the
  // guard crashed with ENOENT in every repo it was distributed to and could
  // never pass. A read-back that only works where the file happens to live is
  // not a read-back; counting what the sweep actually read is.
  if (countSourceFiles(root) === 0) {
    console.error('✗ codeql-suppression guard: scanned zero files — refusing a false green.')
    process.exit(1)
  }

  console.log('✓ codeql-suppression guard: no dead `codeql[...]` suppression comment found')
}
