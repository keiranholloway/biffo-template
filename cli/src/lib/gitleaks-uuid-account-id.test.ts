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
 * path or value. The first pass (#893) landed on
 * `(?:^|[^0-9A-Fa-f-])(\d{12})\b`, blanket-excluding a preceding hyphen so a
 * UUID's last segment (always hyphen-preceded) could never match — but that
 * also silently dropped the most common real-world shape of a leaked account
 * id: `my-app-artifacts-123456789012`, `deploy-role-123456789012` and every
 * other S3-bucket/IAM-role/ECR-repo/log-group name that ends `-<account-id>`
 * (issue #1628, found prosecuting `biffo-plugin-marketing#185`, which it
 * blocked).
 *
 * The current regex,
 * `(?:^|[^0-9A-Fa-f-]|[0-9A-Za-z]*[g-zG-Z][0-9A-Za-z]*-)(\d{12})\b`, replaces
 * the blanket hyphen exclusion with a narrower one: a hyphen is only treated
 * like a UUID separator when the word immediately before it is composed
 * entirely of hex characters, which is what a UUID segment always is by
 * construction and an ordinary hyphenated resource-name word
 * (`artifacts`, `role`) essentially never is (English words routinely contain
 * letters outside a-f). gitleaks/RE2 has no lookbehind, so the preceding
 * context still has to be consumed as part of the match rather than asserted
 * — `secretGroup = 1` reports only the digit group as the actual secret, so
 * redacted output and allowlist `regexes` (which test the reported secret)
 * still see a bare 12-digit string, unaffected by this change.
 *
 * These tests prove BOTH directions with the real gitleaks binary against
 * the real `.gitleaks.toml`, the same way `verify-gitleaks-scope.test.ts`
 * does — a regex that stops flagging UUIDs but ALSO stops flagging real
 * account ids would be worse than the bug it fixes. Every accepted trade-off
 * gets its own test case here rather than living only in the `.gitleaks.toml`
 * comment — a gap documented in prose but not pinned by a test is exactly how
 * this rule's previous trade-off (the hyphen case, #1628) went unnoticed
 * until it blocked an unrelated PR.
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

    it('still flags an account id after a colon in YAML', () => {
      const acct = fakeAccountId(4)
      const findings = detect(`aws:\n  account_id: ${acct}\n`)
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(1)
    })

    it('still flags the ECR registry host shape (account id dot-bounded, not hyphenated)', () => {
      const acct = fakeAccountId(5)
      const findings = detect(`REPO = "${acct}.dkr.ecr.eu-west-1.amazonaws.com/foo"\n`)
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(1)
    })

    // The gap this rule used to have (#1628): S3 bucket names, IAM role
    // names, ECR repo names and log groups routinely end `-<account-id>`,
    // and the previous fix's blanket hyphen exclusion silently dropped every
    // one of them. Pinned here so the trade-off cannot be lost again.
    it('flags an S3-bucket-shaped name ending in a hyphenated account id', () => {
      const acct = fakeAccountId(6)
      const findings = detect(`bucket = "my-app-artifacts-${acct}"\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('flags an IAM-role-shaped name ending in a hyphenated account id', () => {
      const acct = fakeAccountId(7)
      const findings = detect(`resource "aws_iam_role" "deploy" { name = "deploy-role-${acct}" }\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    // The trade-off this rule's fix explicitly accepts (documented in
    // .gitleaks.toml, and pinned here rather than left only in that
    // comment): a hyphen is indistinguishable from a UUID separator when the
    // word immediately before it is ITSELF composed entirely of hex
    // characters. This is the negative case the class of bug (#1628's
    // shape: an accepted limit that lived only in prose) requires a test
    // for, same as the UUID-tail case above.
    it('does NOT flag a hyphenated account id whose preceding word is itself all-hex (accepted trade-off)', () => {
      const acct = fakeAccountId(8)
      const findings = detect(`bucket = "deadbeef-${acct}"\n`)
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })
  },
)
