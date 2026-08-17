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
 * TWO attempts at fixing this by narrowing the RULE REGEX both failed:
 *
 * - #893 landed on `(?:^|[^0-9A-Fa-f-])(\d{12})\b`, blanket-excluding a
 *   preceding hyphen so a UUID's last segment (always hyphen-preceded) could
 *   never match — but that also silently dropped the most common real-world
 *   shape of a leaked account id: `my-app-artifacts-<id>`, `deploy-role-<id>`
 *   and every other S3-bucket/IAM-role/ECR-repo/log-group name that ends
 *   `-<account-id>` (issue #1628, found prosecuting
 *   `biffo-plugin-marketing#185`, which it blocked).
 * - #1628's first attempt tried
 *   `(?:^|[^0-9A-Fa-f-]|[0-9A-Za-z]*[g-zG-Z][0-9A-Za-z]*-)(\d{12})\b`,
 *   requiring the word before a hyphen to contain a non-hex letter before
 *   treating the hyphen like a UUID separator. This was PROSECUTED AND
 *   REJECTED: the hex character class `[0-9A-Fa-f]` includes all ten digits,
 *   not just `a`-`f`, so any all-numeric prefix (`backup-2024-<id>`,
 *   `snapshot-2023-<id>`) or English word spelled only in `a`-`f`
 *   (`facade-<id>`, `decade-<id>`, `cafe-<id>`) escaped undetected — a date
 *   and a UUID segment are indistinguishable by looking at the word alone,
 *   because they can be the same string (`2024` is four hex-valid digits).
 *
 * The design now INVERTS the approach instead of tuning the regex further:
 * rather than describing the context that is NOT a UUID (heuristic, and
 * provably porous, twice), it describes the UUID ITSELF, which has a fixed,
 * unmistakable shape. The rule regex goes back to being broad
 * (`\b\d{12}\b`), and the rule-level allowlist gains a regex matching a
 * COMPLETE UUID —
 * `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`
 * — with `regexTarget = "line"`. That target choice is load-bearing and was
 * established by experiment against the real binary, not from gitleaks'
 * docs: the reported *secret* here is only the matched 12 digits, never the
 * hyphens around them, so an allowlist regex tested against the secret (the
 * default target, and `"match"`) can never see a full UUID shape and
 * suppresses NOTHING — verified directly, see the "regexTarget" test below.
 * `"line"` tests the allowlist regex against the whole source line instead,
 * which does contain the complete UUID text.
 *
 * `backup-2024-<id>` does not match the full UUID pattern and stays caught;
 * `b3f1c0de-0000-0000-0000-000000000001` does match it and is suppressed.
 * The exclusion is exact rather than heuristic, so the residual gap the
 * previous (rejected) design accepted in prose — a hyphenated word that is
 * ITSELF all-hex, e.g. `deadbeef-<id>`, indistinguishable from a UUID tail by
 * that heuristic — is CLOSED here: it is not part of a complete UUID, so it
 * is no longer exempt (see the "no longer exempt" test below, which replaces
 * the old accepted-trade-off test).
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
 * this same trap; a real value written into a doc comment while explaining
 * this rule is exactly how it recurs).
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

    // The word-level heuristic tried in #1628's first (rejected) attempt
    // accepted this as a trade-off: a hyphen is indistinguishable from a
    // UUID separator when the word immediately before it is ITSELF composed
    // entirely of hex characters. The UUID-allowlist design closes that gap
    // — `deadbeef-<id>` is not part of a COMPLETE 8-4-4-4-12 UUID, so it no
    // longer has anywhere to hide. This replaces the old "accepted
    // trade-off" test with its opposite: the trade-off is gone, not merely
    // documented.
    it('flags a hyphenated account id whose preceding word is itself all-hex (no longer exempt)', () => {
      const acct = fakeAccountId(8)
      const findings = detect(`bucket = "deadbeef-${acct}"\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    // The failure the prosecution found in #1628's first (rejected) attempt:
    // the hex character class `[0-9A-Fa-f]` includes all ten digits, so any
    // all-numeric prefix escaped the word-level heuristic entirely. A
    // date-stamped bucket/log-group/stack name is one of the most common AWS
    // naming conventions there is — this must never silently escape again.
    it('flags an account id after an all-numeric hyphenated prefix (backup-2024-<id>)', () => {
      const acct = fakeAccountId(9)
      const findings = detect(`bucket = "backup-2024-${acct}"\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    // Same failure, the other half: an ordinary English word spelled only in
    // a-f is exactly as hex-shaped as a date, by the same character class.
    it('flags an account id after an all-hex-letter English word (facade-<id>)', () => {
      const acct = fakeAccountId(10)
      const findings = detect(`bucket = "facade-${acct}"\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('flags an account id after another all-hex-letter English word (decade-<id>)', () => {
      const acct = fakeAccountId(11)
      const findings = detect(`role = "decade-${acct}"\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('does not flag a UUID embedded inside JSON', () => {
      const findings = detect('{"id": "11111111-1111-1111-1111-111111111111"}\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    // `regexTarget` decides whether the UUID allowlist regex is tested
    // against the reported SECRET (only the 12 digits, no hyphens — the
    // allowlist can then never match a UUID shape, so it suppresses
    // NOTHING) or the whole LINE (which contains the complete UUID text).
    // Established by experiment against the real 8.30.1 binary, not from
    // gitleaks' docs: without `regexTarget = "line"` in `.gitleaks.toml`,
    // this test fails, because the UUID tail below stays flagged.
    it('regexTarget = "line" is required for the UUID allowlist to suppress anything', () => {
      expect(readFileSync(GITLEAKS_TOML, 'utf8')).toContain('regexTarget = "line"')
      const findings = detect('uuid_tail = "b3f1c0de-0000-0000-0000-000000000001"\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })
  },
)
