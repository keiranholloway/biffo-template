/**
 * `verify.sh` must not let "there is no CI to ask" read as "CI requires
 * everything" (#942).
 *
 * `ci_has()` answers **yes** to every question when there is no `ci.yml`. That is
 * deliberate — with no pipeline to mirror, best-effort beats silence — and these
 * tests pin it rather than reverse it, because flipping it to `false` would make
 * the repos with the least safety run nothing at all.
 *
 * What was wrong is that the two states printed identically. A repo that *lost*
 * its `ci.yml` produced exactly the output of a fully-mirrored repo, so the most
 * important thing the gate could tell you was the one thing it did not say.
 *
 * Driven by running the real script, because the defect is in its output and its
 * exit status. Asserting on the source text would be the substring-guard mistake
 * #957 exists to stop.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

interface Run {
  stdout: string
  status: number
}

function runIn(files: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-verify-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    const opts: ExecFileSyncOptions = { cwd: dir, encoding: 'utf8', stdio: 'pipe' }
    try {
      return { stdout: String(execFileSync('sh', [SCRIPT], opts)), status: 0 }
    } catch (err) {
      const e = err as { stdout?: string; status?: number }
      return { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CI_YML = 'jobs:\n  js:\n    steps:\n      - run: pnpm run lint\n'

describe('verify.sh tells you WHICH question it answered', () => {
  it('labels a passing run as best-effort when there is no ci.yml', () => {
    // A check that really runs and really passes, so this exercises the pass
    // summary rather than the "ran NOTHING" path.
    const run = runIn({ 'package.json': '{"name":"p","scripts":{"lint":"true"}}\n' })

    expect(run.stdout).toContain('verify passed')
    expect(run.stdout).toContain('no ci.yml')
    expect(run.stdout).toContain('NOT evidence that CI requires them')
    expect(run.status).toBe(0)
  })

  it('does not say it when the repo has CI to mirror', () => {
    const run = runIn({
      'package.json': '{"name":"p","scripts":{"lint":"true"}}\n',
      '.github/workflows/ci.yml': CI_YML,
    })

    expect(run.stdout).toContain('verify passed')
    // The claim "CI requires this" is now only made when a workflow said so.
    expect(run.stdout).not.toContain('no ci.yml')
    expect(run.status).toBe(0)
  })
})

describe('verify.sh keeps the two ran-NOTHING cases distinct', () => {
  it('a repo with CI that mirrored nothing BLOCKS — the #855 bug', () => {
    const run = runIn({ '.github/workflows/ci.yml': CI_YML })

    expect(run.stdout).toContain('verify ran NOTHING')
    expect(run.stdout).toContain('This repo HAS CI')
    expect(run.status).toBe(1)
  })

  it('a repo with no CI at all says so loudly and does NOT block', () => {
    // Blocking here is friction with no benefit, and friction is what drives
    // BIFFO_SKIP_VERIFY — a counter-metric H4 pre-registered as refuting itself.
    const run = runIn({})

    expect(run.stdout).toContain('verify ran NOTHING')
    expect(run.stdout).toContain('no CI for the gate to mirror')
    expect(run.status).toBe(0)
  })
})
