/**
 * `verify.sh` refuses a tracked terraform plan artefact (biffo-runners#1).
 *
 * A saved plan is a zip. `strings`/`grep` over it is a false-negative machine — a
 * pre-commit check on `terraform/tfplan2` reported it clean and it carried a live
 * private key. gitleaks cannot see inside it either, because the bytes are
 * compressed, so the working-tree scan is no protection here.
 *
 * The answer is therefore not a better scanner but refusing to track the
 * artefact at all, detected by **content**. Name-based ignoring is what already
 * failed: `.gitignore` carried `tfplan` and the file that nearly leaked was
 * `tfplan2`.
 *
 * The fixture is the zip *signature* — magic plus a `tfplan` member name, which a
 * real archive stores uncompressed. Verified by hand against a genuine
 * `ZIP_DEFLATED` archive containing a private key, where `grep` for the key
 * returned **0 matches** and the guard still fired; this pins the logic cheaply.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const PLAN_BYTES = Buffer.concat([ZIP_MAGIC, Buffer.from('  tfplan  payload')])

interface Run {
  stdout: string
  status: number
}

function runWith(rel: string | null, bytes: Buffer | null): Run {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-plan-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"lint":"true"}}\n')
    execFileSync('git', ['add', 'package.json'], { cwd: dir })
    if (rel !== null && bytes !== null) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), bytes)
      // -f because the whole point is that .gitignore does not reliably cover it.
      execFileSync('git', ['add', '-f', rel], { cwd: dir })
    }
    try {
      const stdout = String(
        execFileSync('sh', [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }),
      )
      return { stdout, status: 0 }
    } catch (err) {
      const e = err as { stdout?: string; status?: number }
      return { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('verify.sh refuses a tracked terraform plan artefact', () => {
  it('fails whatever the plan is named — tfplan2 is the real incident file', () => {
    const run = runWith('terraform/tfplan2', PLAN_BYTES)

    expect(run.stdout).toContain('terraform plan artefact is tracked')
    expect(run.stdout).toContain('terraform/tfplan2')
    expect(run.status).toBe(1)
  })

  it('names the remedy, so the failure is actionable without reading the script', () => {
    expect(runWith('infra/dev.tfplan', PLAN_BYTES).stdout).toContain('git rm --cached')
  })

  it('passes when no plan is tracked', () => {
    const run = runWith(null, null)

    expect(run.stdout).not.toContain('terraform plan artefact')
    expect(run.status).toBe(0)
  })

  it('does not fire on a non-text file that merely mentions tfplan', () => {
    // Deliberately extension-less, so this reaches the magic check rather than
    // being skipped by the candidate filter — otherwise it would pass for the
    // wrong reason and stop testing anything. A file naming the artefact is not
    // the artefact, and a guard that cried wolf here would be switched off.
    const run = runWith('notes/README', Buffer.from('we removed the tfplan file\n'))

    expect(run.stdout).not.toContain('terraform plan artefact')
    expect(run.status).toBe(0)
  })

  it('the candidate filter skips text, which is what gitleaks can already read', () => {
    // The narrowing is a performance measure, not a weakening: it exists because
    // content-checking all 907 tracked files cost 4.2s and timed out three parity
    // tests. What it skips is exactly what a scanner can handle unaided.
    const run = runWith('docs/notes.md', Buffer.concat([ZIP_MAGIC, Buffer.from(' tfplan ')]))

    expect(run.status).toBe(0)
  })

  it('does not fire on a zip that is not a plan', () => {
    // A plain archive with no `tfplan` member is somebody's fixture, not a leak.
    const run = runWith('fixtures/ordinary.zip', Buffer.concat([ZIP_MAGIC, Buffer.from('readme')]))

    expect(run.stdout).not.toContain('terraform plan artefact')
    expect(run.status).toBe(0)
  })
})
