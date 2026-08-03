/**
 * `verify.sh`'s gitleaks pass scans TRACKED files only (#1194).
 *
 * `gitleaks detect --no-git` walks the filesystem rather than the index, and
 * does not honour `.gitignore` -- so a stray `pnpm run build` sitting around
 * at push time got scanned right alongside the source. An agent in
 * `tabsii-crm` hit this scanning 218MB of `.next/`/`out/` and got 30 phantom
 * leaks, none in a tracked file, none of them committable. A secret scanner
 * that cries wolf is worse than a slow one: the second time 30 leaks turn out
 * to be bundle noise, people stop reading gitleaks output, which is exactly
 * the day a real one hides in it.
 *
 * The fix mirrors `git ls-files` into a scratch directory and scans that
 * instead of the raw working tree -- narrowing to what can actually reach the
 * remote a push sends to, not to a hand-maintained list of build-output
 * directories that has to be kept in step with `.gitignore` forever.
 *
 * These tests use a fixture token shaped like a GitHub PAT (`ghp_` + 36
 * alphanumeric characters) because that is what gitleaks' own default
 * ruleset reliably fires on -- AKIA-style AWS example keys are allowlisted by
 * the "EXAMPLE" regex in `.gitleaks.toml`'s global allowlist and would prove
 * nothing. The characters are pseudo-random per test (not a real credential,
 * never used anywhere) so as not to resemble one, per AGENTS.md SS7's fixture
 * guidance and the incident it documents (a `ghp_`-prefixed test token that
 * looked too plausible tripped the `github-pat` rule for real).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')
const GITLEAKS_TOML = join(repoRoot, '.gitleaks.toml')

function fakeToken(seed: number): string {
  // A small deterministic PRNG, not Math.random(), so failures are
  // reproducible without needing to capture the generated value.
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = 'ghp_'
  for (let i = 0; i < 36; i++) out += chars[rand() % chars.length]
  return out
}

interface Run {
  stdout: string
  status: number
}

function runVerify(cwd: string): Run {
  try {
    const stdout = String(
      execFileSync('sh', [SCRIPT], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }),
    )
    return { stdout, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
  }
}

/** A minimal repo verify.sh can run against fast: no Python, no JS build, no CI file. */
function minimalRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-gitleaks-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'],
    {
      cwd: dir,
    },
  )
  writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"lint":"true"}}\n')
  execFileSync('git', ['add', 'package.json'], { cwd: dir })
  // The repo's real `.gitleaks.toml` must be present and TRACKED for these
  // tests to exercise the same rules the estate actually runs (the custom
  // `biffo-placeholder-config`/`biffo-aws-account-id` rules plus
  // `useDefault = true`'s bundled ruleset, which is what the `ghp_` pattern
  // needs). It is also the fixture for "gitleaks.toml is itself tracked, so
  // it travels with the mirrored copy" -- untested directly, but implied by
  // every case below actually finding or not finding a leak.
  writeFileSync(join(dir, '.gitleaks.toml'), readFileSync(GITLEAKS_TOML, 'utf8'))
  execFileSync('git', ['add', '.gitleaks.toml'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'seed'],
    { cwd: dir },
  )
  return dir
}

describe("verify.sh's gitleaks pass scans tracked files only", () => {
  it('ignores a leak sitting in an UNTRACKED file (build output)', () => {
    const dir = minimalRepo()
    try {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'bundle.js'), `const t = "${fakeToken(1)}"\n`)
      // Never `git add`ed -- this is the exact shape of a `pnpm run build`
      // artefact sitting around at push time, whether or not `.gitignore`
      // happens to name the directory.
      //
      // Assertions look for `leaks found`/`verify failed` rather than a
      // literal `OK   gitleaks`/`FAIL gitleaks` substring: the gate colours
      // those two words with ANSI escapes that sit BETWEEN them
      // (`\x1b[32mOK\x1b[0m   gitleaks`), so a plain substring match on the
      // uncoloured text never matches real output -- caught by running this
      // test for real rather than eyeballing the assertion.
      const run = runVerify(dir)
      expect(run.stdout).not.toContain('leaks found')
      expect(run.stdout).not.toContain('verify failed')
      expect(run.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still fails on a leak in a TRACKED file -- the scan is scoped, not weakened', () => {
    const dir = minimalRepo()
    try {
      writeFileSync(join(dir, 'leak.txt'), `token=${fakeToken(2)}\n`)
      execFileSync('git', ['add', '-f', 'leak.txt'], { cwd: dir })
      const run = runVerify(dir)
      expect(run.stdout).toContain('leaks found')
      expect(run.stdout).toContain('verify failed')
      expect(run.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still fails on a leak STAGED but not yet committed to a tracked file', () => {
    // `git ls-files` lists the index, and the mirror copies CURRENT on-disk
    // content -- not `git show HEAD:<path>` -- so a secret added to an
    // already-tracked file is caught before the commit that would push it,
    // not only after.
    const dir = minimalRepo()
    try {
      writeFileSync(
        join(dir, 'package.json'),
        `{"name":"p","token":"${fakeToken(3)}","scripts":{"lint":"true"}}\n`,
      )
      const run = runVerify(dir)
      expect(run.stdout).toContain('leaks found')
      expect(run.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not hard-fail a repo with no .gitleaks.toml at all', () => {
    // Regression guard: a first cut of the fix passed an explicit
    // `--config <path>` pointing at this repo's own `.gitleaks.toml`. Fine
    // here (the file exists), fatal everywhere it does not -- "unable to
    // load gitleaks config" is not the same failure as a real leak, and it
    // would have broken every push in a repo that (legitimately) relies on
    // gitleaks' built-in default ruleset.
    const dir = mkdtempSync(join(tmpdir(), 'verify-gitleaks-noconfig-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"lint":"true"}}\n')
      execFileSync('git', ['add', 'package.json'], { cwd: dir })
      execFileSync(
        'git',
        ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'init'],
        { cwd: dir },
      )
      const run = runVerify(dir)
      expect(run.stdout).not.toContain('unable to load gitleaks config')
      expect(run.stdout).not.toContain('leaks found')
      expect(run.stdout).not.toContain('verify failed')
      expect(run.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the existing path-based .gitleaks.toml allowlist working inside the mirrored copy', () => {
    // The global allowlist excludes `docs/` entirely. Relative paths inside
    // the scratch mirror match the repo's own paths, so this must still hold
    // post-#1194 -- if it stopped, every repo's docs would start failing on
    // legitimate example values.
    const dir = minimalRepo()
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'example.md'), `token=${fakeToken(4)}\n`)
      execFileSync('git', ['add', '-f', 'docs/example.md'], { cwd: dir })
      const run = runVerify(dir)
      expect(run.stdout).not.toContain('leaks found')
      expect(run.stdout).not.toContain('verify failed')
      expect(run.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
