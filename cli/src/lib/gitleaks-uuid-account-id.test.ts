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
 * THREE attempts were needed. Read all three before touching this rule
 * again — the first two each looked reasonable and were each prosecuted and
 * broken against the real gitleaks binary, not a theoretical flaw:
 *
 * - #893 landed on `(?:^|[^0-9A-Fa-f-])(\d{12})\b`, blanket-excluding a
 *   preceding hyphen so a UUID's last segment (always hyphen-preceded) could
 *   never match — but that also silently dropped the most common real-world
 *   shape of a leaked account id: `my-app-artifacts-<id>`, `deploy-role-<id>`
 *   and every other S3-bucket/IAM-role/ECR-repo/log-group name that ends
 *   `-<account-id>` (issue #1628, found prosecuting
 *   `biffo-plugin-marketing#185`, which it blocked).
 * - #1628 attempt 1 tried
 *   `(?:^|[^0-9A-Fa-f-]|[0-9A-Za-z]*[g-zG-Z][0-9A-Za-z]*-)(\d{12})\b`,
 *   requiring the word before a hyphen to contain a non-hex letter before
 *   treating the hyphen like a UUID separator. PROSECUTED AND REJECTED: the
 *   hex character class `[0-9A-Fa-f]` includes all ten digits, not just
 *   `a`-`f`, so any all-numeric prefix (`backup-2024-<id>`,
 *   `snapshot-2023-<id>`) or English word spelled only in `a`-`f`
 *   (`facade-<id>`, `decade-<id>`, `cafe-<id>`) escaped undetected — a date
 *   and a UUID segment are indistinguishable by looking at the word alone,
 *   because they can be the same string (`2024` is four hex-valid digits).
 * - #1628 attempt 2 inverted the approach: broad rule (`\b\d{12}\b`) again,
 *   with a rule-level allowlist matching a COMPLETE UUID —
 *   `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`
 *   — and `regexTarget = "line"`, reasoning that the reported *secret*
 *   (`secretGroup`) is only the matched 12 digits and never the hyphens
 *   around them, so the allowlist had to see the whole source LINE to
 *   recognise a UUID shape at all. PROSECUTED AND REJECTED: `"line"`
 *   suppresses the whole line, so a genuine account id sharing a line with
 *   ANY unrelated UUID text (a log line with a request-id and an account id,
 *   a JSON telemetry blob, a comma-separated pair) was silently waved
 *   through with it — reproduced live, `0` findings on all of those shapes.
 *
 * Attempt 3 (current) inverts the exclusion's SCOPE instead of tuning the
 * heuristic again. A UUID's final 12-digit segment is always preceded by
 * exactly two 4-character hex groups (RFC 4122's 3rd and 4th fields) — a
 * date or resource-name prefix is never TWO complete hex quads, only ever
 * zero or one. RE2 has no lookbehind, so that prefix is consumed as an
 * optional, non-capturing alternation in the RULE's own regex, and only the
 * 12 digits are reported via `secretGroup`:
 * `\b(?:[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-)?(\d{12})\b`. The leading `\b` is
 * deliberate: without it, the digit capture has no boundary constraint when
 * the optional prefix doesn't match, so it can match a 12-digit substring
 * embedded inside a longer digit run (a 16-digit blob) that the original
 * `\b\d{12}\b` never flagged — verified by experiment (see the "digit blob"
 * test below).
 *
 * The exclusion lives in a SEPARATE allowlist with `regexTarget = "match"`,
 * tested against the anchored shape `^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-\d{12}$`.
 * That target choice is load-bearing and was established by experiment
 * against the real binary, not from gitleaks' docs — and it corrects attempt
 * 2's own experimentally-derived conclusion, which was true only by
 * coincidence: attempt 2's rule regex had no capturing group, so its full
 * match and its `secretGroup` secret were always identical text, and nothing
 * in that experiment could have told "tests the match" apart from "tests the
 * secret". Re-run here with a rule regex built so the two DIFFER (this one:
 * for a UUID tail, the full match is `0000-0000-000000000001` but the
 * reported secret is only its trailing twelve digits), `regexTarget =
 * "match"` tests the RAW regex
 * match, hyphens included, and correctly suppresses the UUID case; the
 * default (unset) target — which behaves identically to `"match"` when no
 * rule regex has a group narrowing the secret below the full match — was
 * also directly confirmed to suppress nothing once match and secret diverge.
 * See the "regexTarget" test below for both directions.
 *
 * Because the allowlist is now scoped per MATCH rather than per LINE,
 * attempt 2's failure mode is closed structurally, not patched: an account
 * id and an unrelated UUID sharing one line each produce their OWN match
 * with their OWN full-match text, so only the UUID's gets excluded — see the
 * "same line as a UUID" tests below, the ones attempt 2 was rejected for
 * missing.
 *
 * `backup-2024-<id>` does not match the two-hex-quad prefix (only one quad
 * precedes it, and "backup" isn't hex either) and stays caught;
 * `b3f1c0de-0000-0000-0000-000000000001` does match it and is suppressed.
 * The residual gap the word-heuristic approach (attempt 1) used to accept in
 * prose — a hyphenated word that is ITSELF all-hex, e.g. `deadbeef-<id>`,
 * indistinguishable from a UUID tail by that heuristic — is CLOSED here: it
 * is not part of a two-hex-quad prefix, so it is no longer exempt (see the
 * "no longer exempt" test below).
 *
 * These tests prove BOTH directions with the real gitleaks binary against
 * the real `.gitleaks.toml`, the same way `verify-gitleaks-scope.test.ts`
 * does — a regex that stops flagging UUIDs but ALSO stops flagging real
 * account ids would be worse than the bug it fixes. Every accepted trade-off
 * gets its own test case here rather than living only in the `.gitleaks.toml`
 * comment — a gap documented in prose but not pinned by a test is exactly how
 * this rule's previous trade-offs (the hyphen case, #1628 attempt 1; the
 * same-line case, #1628 attempt 2) went unnoticed until they blocked an
 * unrelated PR or were caught by prosecution.
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

    it('does not flag a UUID at the very start of a line', () => {
      const findings = detect('11111111-1111-1111-1111-111111111111\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    it('does not flag a UUID inside a list', () => {
      const findings = detect(
        '["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]\n',
      )
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    it('does not flag several UUIDs on one line', () => {
      const findings = detect(
        '11111111-1111-1111-1111-111111111111 22222222-2222-2222-2222-222222222222 33333333-3333-3333-3333-333333333333\n',
      )
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    // The digit-blob regression #1628 attempt 3's leading `\b` exists to
    // prevent. Without it, the rule's optional two-hex-quad prefix leaves
    // the bare-digit alternative with no leading boundary at all, so it can
    // match a 12-digit SUBSTRING inside a longer run of digits that the
    // original `\b\d{12}\b` never flagged (both boundaries required). This
    // is not a UUID case at all — a 16-digit blob has no hyphens anywhere —
    // it is a second, independent false-positive class the redesign could
    // have reintroduced by accident.
    it('does not flag a 12-digit substring embedded in a longer run of digits', () => {
      const findings = detect('1234567890123456\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })

    // The failure #1628 attempt 2 was rejected for: `regexTarget = "line"`
    // suppressed a real account id whenever it shared a LINE with any
    // unrelated UUID text. Attempt 3 scopes the allowlist to the raw regex
    // MATCH instead, so each occurrence is judged independently regardless
    // of what else shares its line. Each case below is a realistic
    // co-occurrence (log line, JSON payload, comma list), not a contrived
    // one, and each must still catch the real account id.
    it('still flags an account id sharing a line with an unrelated UUID (log-line shape)', () => {
      const acct = fakeAccountId(12)
      const findings = detect(
        `log.info("account ${acct} request 11111111-1111-1111-1111-111111111111 accepted")\n`,
      )
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('still flags an account id sharing a line with an unrelated UUID (UUID first)', () => {
      const acct = fakeAccountId(13)
      const findings = detect(
        `log.info("uuid 11111111-1111-1111-1111-111111111111 account ${acct}")\n`,
      )
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('still flags an account id sharing a line with an unrelated UUID (inside JSON)', () => {
      const acct = fakeAccountId(14)
      const findings = detect(
        `{"account": "${acct}", "trace": "11111111-1111-1111-1111-111111111111"}\n`,
      )
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    it('still flags an account id sharing a line with an unrelated UUID (comma-separated list)', () => {
      const acct = fakeAccountId(15)
      const findings = detect(`11111111-1111-1111-1111-111111111111, ${acct}\n`)
      const hits = findings.filter((f) => f.RuleID === 'biffo-aws-account-id')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.Secret).toBe(acct)
    })

    // `regexTarget` decides whether the UUID allowlist regex is tested
    // against the reported SECRET (only the 12 digits, no hyphens — the
    // allowlist can then never match a UUID shape, so it suppresses
    // NOTHING) or the raw regex MATCH (which, when the optional two-hex-quad
    // prefix matched, does contain the complete two-quad-plus-digits text).
    // Established by experiment against the real 8.30.1 binary, not from
    // gitleaks' docs: without `regexTarget = "match"` in `.gitleaks.toml`,
    // this test fails, because the UUID tail below stays flagged.
    it('regexTarget = "match" is required for the UUID allowlist to suppress anything', () => {
      expect(readFileSync(GITLEAKS_TOML, 'utf8')).toContain('regexTarget = "match"')
      const findings = detect('uuid_tail = "b3f1c0de-0000-0000-0000-000000000001"\n')
      expect(findings.filter((f) => f.RuleID === 'biffo-aws-account-id')).toHaveLength(0)
    })
  },
)
