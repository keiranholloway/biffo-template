/**
 * `biffo-aws-account-id` used to be `\b\d{12}\b`, which matches *any* bare
 * 12-digit run — including the last segment of an ordinary fixture UUID
 * (`11111111-1111-1111-1111-111111111111` ends in twelve digits with a word
 * boundary on both sides). Secret Scan then failed on correct test code
 * (issue #893). The finding also survives editing the value at a later
 * commit, because the scan is history-wide
 * (`--log-opts="--full-history HEAD"` in `.github/workflows/ci.yml`) — so the
 * only real-world fixes were "never write a fixture UUID with an all-digit
 * last segment" (unenforceable) or squashing/rewriting the branch (the
 * disproportionate cost the issue calls out).
 *
 * The fix narrows the regex's boundary condition rather than allowlisting a
 * path or value: `(?:^|[^0-9A-Fa-f-])(\d{12})\b` requires the character
 * immediately before the 12 digits to be either nothing (start of the
 * scanned content) or something that is NOT a hyphen and NOT a hex digit.
 * A UUID's last segment is always preceded by a hyphen, which this excludes;
 * an account id quoted, colon-prefixed (ARN), or otherwise word-bounded is
 * unaffected. gitleaks/RE2 has no lookbehind, so the excluded character has
 * to be consumed as part of the match — `secretGroup = 1` reports only the
 * digit group as the actual secret, so redacted output and allowlist
 * `regexes` (which test the reported secret) still see a bare 12-digit
 * string, unaffected by this change.
 *
 * These tests prove BOTH directions with the real gitleaks binary against
 * the real `.gitleaks.toml`, the same way `verify-gitleaks-scope.test.ts`
 * does — a regex that stops flagging UUIDs but ALSO stops flagging real
 * account ids would be worse than the bug it fixes.
 *
 * The "still flags a real one" cases need a plausible-looking, NON-canonical
 * 12-digit value (the two canonical placeholders are allowlisted, so using
 * one would prove nothing). Generated at runtime with a small deterministic
 * PRNG rather than written as a literal in this file — the exact reasoning
 * `verify-gitleaks-scope.test.ts`'s `fakeToken()` documents: a plausible
 * invented value committed as a literal trips THIS repo's own Secret Scan on
 * the test file itself (AGENTS.md §7's "two agents hit this in one day" is
 * this same trap; a third one nearly wrote a fourth instance in this very
 * PR — caught by the pre-push gate before it reached CI).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const GITLEAKS_TOML = join(repoRoot, '.gitleaks.toml')

// Same reasoning as verify-gitleaks-scope.test.ts: the `gitleaks` binary is
// only installed in the Secret Scan CI job, not where `vitest` runs. Skip
// visibly rather than silently passing with nothing exercised.
const HAS_GITLEAKS = (() => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** A 12-digit, non-canonical, deterministically-generated fake account id.
 * Built digit-by-digit at runtime so no 12-digit run ever appears as a
 * literal in this file's tracked source (see the module doc comment). */
function fakeAccountId(seed: number): string {
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s
  }
  let out = ''
  for (let i = 0; i < 12; i++) out += String(rand() % 10)
  return out
}

interface Finding {
  RuleID: string
  Secret: string
}

/** Run `gitleaks detect` (history-scoped, like CI) against a scratch repo
 * seeded with one commit, using this repo's real `.gitleaks.toml`. Returns
 * the parsed findings (empty array on a clean scan). */
function detect(fileContents: string): Finding[] {
  const dir = makeTmpDir('gitleaks-uuid-account-id')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'],
    {
      cwd: dir,
    },
  )
  writeFileSync(join(dir, '.gitleaks.toml'), readFileSync(GITLEAKS_TOML, 'utf8'))
  writeFileSync(join(dir, 'fixture.py'), fileContents)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'seed'],
    { cwd: dir },
  )

  const reportPath = join(dir, 'report.json')
  try {
    execFileSync(
      'gitleaks',
      [
        'detect',
        '--source',
        dir,
        '--report-path',
        reportPath,
        '--exit-code=2',
        '--log-opts=--full-history HEAD',
      ],
      { stdio: 'pipe' },
    )
    return []
  } catch (err) {
    const e = err as { status?: number }
    // exit 1 is a genuine tool error (bad config, etc.) -- only 2 is "found leaks".
    if (e.status !== 2) throw err
    return JSON.parse(readFileSync(reportPath, 'utf8')) as Finding[]
  }
}

describe.skipIf(!HAS_GITLEAKS)(
  'biffo-aws-account-id: UUID vs real account id [needs gitleaks]',
  () => {
    it('does NOT flag a fixture UUID whose last segment is all-digit', () => {
      const findings = detect('UUID = "11111111-1111-1111-1111-111111111111"\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    it('still flags a genuine bare 12-digit account id (word-bounded, not UUID-shaped)', () => {
      // Deliberately not one of the allowlisted canonical values
      // (123456789012 / 999999999999) -- this proves detection still fires on
      // an arbitrary real-looking id, not just that the allowlist still works.
      const acct = fakeAccountId(1)
      const findings = detect(`ACCOUNT = "${acct}"\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('still flags an account id inside an ARN (colon-bounded, the realistic shape)', () => {
      const acct = fakeAccountId(2)
      const findings = detect(`arn = "arn:aws:iam::${acct}:role/deploy"\n`)
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(1)
    })

    it('still flags an account id as the very first bytes of a file (no preceding char)', () => {
      const findings = detect(`${fakeAccountId(3)}\n`)
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(1)
    })

    it('does not flag a UUID embedded mid-line either', () => {
      const findings = detect(
        'log.info("request id 11111111-1111-1111-1111-111111111111 accepted")\n',
      )
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    it('still allowlists the canonical placeholder values', () => {
      const findings = detect('A = "123456789012"\nB = "999999999999"\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })
  },
)
