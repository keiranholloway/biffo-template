/**
 * CI entrypoint for the pipe-trap guard (#1231, instance 1): fail when a
 * packaged script or hook pipes a status-bearing command (`claim.sh`,
 * `wait-for-checks`, `branch-health`, `git push`, `verify.sh`) into another
 * command, or reads `$?` on the line after such a pipeline — both read the
 * LAST command's exit status, which is how a rejected push, a failed claim,
 * or a red check has read as `exit: 0` before (AGENTS.md §4).
 *
 * Scoped to `scripts/*.sh` and `.githooks/*` — the shell every satellite
 * actually runs since #1109 collapsed each script to one canonical copy
 * inside the published package, matching the scope
 * `pipe-trap-guard.test.ts`'s own sweep already used.
 *
 * Shipped with #1231 and had zero callers as a CI *guard* until this
 * guard-wiring pass (biffo-template#1363) — its own `.test.ts` sweep has
 * exercised it against this repo's real shell on every `pnpm run test`, but
 * nothing ran it from `cli/src/commands/` or a named workflow step.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execa } from 'execa'
import { findPipeTraps } from '../lib/pipe-trap-guard.js'

/** Same scope as the guard's own test sweep: packaged scripts and hooks. */
function shellFiles(root: string): string[] {
  const out: string[] = []
  for (const dir of ['scripts', '.githooks']) {
    const full = join(root, dir)
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (dir === 'scripts' && !entry.name.endsWith('.sh')) continue
      out.push(join(full, entry.name))
    }
  }
  return out
}

export async function runPipeTrapCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const files = shellFiles(root)

  console.log(`audited ${files.length} shell file(s) under scripts/ and .githooks/ under ${root}`)

  if (files.length === 0) {
    console.error(
      '✗ Pipe-trap guard: found 0 shell files under scripts/ or .githooks/ — this looks like a ' +
        'broken scan, not a clean repo. Refusing to report success over zero input.',
    )
    process.exit(1)
  }

  const findings = files.flatMap((file) =>
    findPipeTraps(readFileSync(file, 'utf8')).map(
      (t) => `${relative(root, file)}:${t.line}  ${t.text}\n    ${t.reason}`,
    ),
  )

  if (findings.length > 0) {
    console.error('✗ Pipe-trap guard: status-bearing pipeline(s) found\n')
    for (const f of findings) {
      console.error(`  ${f}`)
    }
    console.error('\nSee biffo-template#1231 (AGENTS.md §4).')
    process.exit(1)
  }

  console.log(`✓ Pipe-trap guard: no status-bearing command is piped away`)
}
