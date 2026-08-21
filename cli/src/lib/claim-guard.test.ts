import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `scripts/claim.sh --guard <branch>` (#1231 instance 2) is the enforced half
 * of the claim: `.githooks/pre-push` calls it on every push, so it is what
 * actually stops a collision rather than merely documenting one. These tests
 * drive the real script — not a reimplementation — against stubbed `gh` and
 * `git`, because the two defects that matter most are shell-level: does the
 * branch/PR self-exclusion actually work in the script's own `jq` query and
 * `grep`, and does a branch naming no issue really skip before touching the
 * network.
 *
 * Both stubs run the request through the REAL `jq` (for `gh`'s `--jq`
 * argument) or the script's own `sed`/`grep` (for `git ls-remote` output), so
 * a test exercises the actual filter clauses in `claim.sh` rather than a
 * hand-computed stand-in for them.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

interface OpenPr {
  number: number
  title?: string
  body?: string
  headRefName: string
  /**
   * What GitHub computes from a closing keyword — the signal the guard now
   * reads instead of the raw body text (#1281, #1311). A fixture that writes
   * `title: 'fixes #1234'` must ALSO declare this, because GitHub would: the
   * text and the structured field are two views of one fact, and the guard
   * deliberately trusts only the parsed one.
   */
  closingIssuesReferences?: Array<{
    number: number
    repository: { name: string; owner: { login: string } }
  }>
}

/** A closing reference in the repo the stub reports. */
const closes = (n: number) => [
  { number: n, repository: { name: 'repo', owner: { login: 'owner' } } },
]

interface StubOptions {
  /** Open PRs `gh pr list` would report, before claim.sh's own jq filter runs. */
  openPrs?: OpenPr[]
  /** Non-zero to simulate `gh` failing (unauthenticated, API error, ...). */
  prListExit?: number
  /** Remote branch names `git ls-remote --heads` would report. */
  remoteBranches?: string[]
  /** Non-zero to simulate `git ls-remote` failing (no network). */
  lsRemoteExit?: number
}

/**
 * Writes a `gh` and a `git` stub into a fresh directory and returns it, along
 * with the path to a log file that records every invocation — used to prove
 * "no issue in the branch name" never touches either.
 */
function stubBins(options: StubOptions): { dir: string; callLog: string } {
  const dir = makeTmpDir('claimguard')
  const callLog = join(dir, 'calls.log')
  writeFileSync(callLog, '')

  const prFixture = join(dir, 'prs.json')
  writeFileSync(prFixture, JSON.stringify(options.openPrs ?? []))
  const prExit = options.prListExit ?? 0

  const gh = [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${JSON.stringify(callLog)}`,
    // repo_slug() asks for this; without it the slug is empty and no closing
    // reference can ever match.
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
    `  if [ ${prExit} -ne 0 ]; then`,
    '    echo "stub gh: simulated failure" >&2',
    `    exit ${prExit}`,
    '  fi',
    // Forward the REAL --jq expression claim.sh built to the real jq, against
    // canned fixture data — this is what makes the self-exclusion clause
    // (`select(.headRefName != "...")`) something the test actually exercises.
    '  jqexpr=""',
    '  prev=""',
    '  for a in "$@"; do',
    '    if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi',
    '    prev="$a"',
    '  done',
    `  jq -r "$jqexpr" ${JSON.stringify(prFixture)}`,
    '  exit 0',
    'fi',
    'echo "stub gh: unhandled args: $*" >&2',
    'exit 1',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)

  const branchFixture = join(dir, 'branches.txt')
  const branchLines = (options.remoteBranches ?? [])
    .map((b) => `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/heads/${b}`)
    .join('\n')
  writeFileSync(branchFixture, branchLines ? branchLines + '\n' : '')
  const lsRemoteExit = options.lsRemoteExit ?? 0

  const git = [
    '#!/usr/bin/env bash',
    `echo "git $*" >> ${JSON.stringify(callLog)}`,
    'if [ "$1" = "ls-remote" ]; then',
    `  if [ ${lsRemoteExit} -ne 0 ]; then`,
    '    echo "stub git: simulated failure" >&2',
    `    exit ${lsRemoteExit}`,
    '  fi',
    `  cat ${JSON.stringify(branchFixture)}`,
    '  exit 0',
    'fi',
    // Anything else (there should be nothing else on the guard path) falls
    // through to the real binary rather than failing opaquely.
    `exec ${JSON.stringify(REAL_GIT)} "$@"`,
    '',
  ].join('\n')
  writeFileSync(join(dir, 'git'), git)
  chmodSync(join(dir, 'git'), 0o755)

  return { dir, callLog }
}

function run(dir: string, branch: string, env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync('sh', [script, '--guard', branch], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + ':' + process.env['PATH'], ...env },
    })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('claim.sh --guard', () => {
  it('skips silently, and touches neither gh nor git, when the branch names no issue', () => {
    // The literal example from #1231: a branch that is not <type>/<number>-…
    const { dir, callLog } = stubBins({})
    const { code, out } = run(dir, 'security/brace-expansion-5-0-9')

    expect(code).toBe(0)
    expect(out).toBe('')
    expect(readFileSync(callLog, 'utf8')).toBe('')
  })

  it('does not block a second push of its own branch — self-exclusion', () => {
    // The branch is already pushed (so it shows up in `git ls-remote`) and
    // already has its own open PR. Neither should count against itself.
    const { dir } = stubBins({
      openPrs: [{ number: 55, headRefName: 'feat/1234-thing', title: 'x', body: '' }],
      remoteBranches: ['feat/1234-thing'],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(0)
    expect(out).not.toContain('claimed by someone else')
  })

  it('blocks on a real conflict — another branch names the same issue', () => {
    const { dir } = stubBins({
      remoteBranches: ['feat/1234-thing', 'fix/1234-other-session'],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(1)
    expect(out).toContain('claimed by someone else')
    expect(out).toContain('fix/1234-other-session')
    // AGENTS.md's stale-claim escape hatch, not a dead end.
    expect(out).toContain('AGENTS.md')
  })

  it('blocks on a real conflict — another OPEN PR references the same issue', () => {
    const { dir } = stubBins({
      openPrs: [
        { number: 99, headRefName: 'feat/1234-thing', title: '', body: '' },
        {
          number: 100,
          headRefName: 'chore/rename',
          title: 'fixes #1234',
          body: '',
          closingIssuesReferences: closes(1234),
        },
      ],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(1)
    expect(out).toContain('#100')
    expect(out).not.toContain('#99')
  })

  it('never treats the label as a signal — it is not asked about at all', () => {
    // Guard mode makes no `gh issue` call of any kind, so a labelled-but-
    // unworked issue (#1188's shape) cannot block a push. Proven by the call
    // log rather than by inspecting labels, since guard mode has no code path
    // that could read one.
    const { dir, callLog } = stubBins({ remoteBranches: ['feat/4321-thing'] })
    run(dir, 'feat/4321-thing')

    expect(readFileSync(callLog, 'utf8')).not.toMatch(/gh issue/)
  })

  it('warns and ALLOWS when it cannot tell', () => {
    const { dir } = stubBins({ prListExit: 1, remoteBranches: ['feat/5555-thing'] })
    const { code, out } = run(dir, 'feat/5555-thing')

    expect(code).toBe(2)
    expect(out).toContain('cannot tell')
  })

  it('BIFFO_CLAIM_STRICT=1 turns cannot-tell into a block', () => {
    const { dir } = stubBins({ prListExit: 1, remoteBranches: ['feat/5555-thing'] })
    const { code, out } = run(dir, 'feat/5555-thing', { BIFFO_CLAIM_STRICT: '1' })

    expect(code).toBe(1)
    expect(out).toContain('cannot tell')
    expect(out).toContain('BIFFO_CLAIM_STRICT')
  })

  it('a real conflict still wins even when the OTHER signal cannot tell', () => {
    // git ls-remote fails, but the open-PR signal alone is enough to block —
    // conflict must take priority over cannot-tell, not the reverse.
    const { dir } = stubBins({
      openPrs: [
        {
          number: 100,
          headRefName: 'chore/rename',
          title: 'fixes #1234',
          body: '',
          closingIssuesReferences: closes(1234),
        },
      ],
      lsRemoteExit: 1,
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(1)
    expect(out).toContain('#100')
  })
})

describe('claim.sh --guard: a batch branch names a sequence, not an issue, and zero-padding must not defeat the boundary anchor (#1672)', () => {
  it('skips a batch branch before any derivation, even one shaped like a real collision', () => {
    // `batch/04-stale-reconverge` fits `<type>/<number>-<slug>` exactly, and a
    // branch naming issue 4 (zero-padded) genuinely exists on the remote --
    // proving the skip is structural (before derivation), not incidental
    // (derivation just happening not to find a collision this time).
    const { dir, callLog } = stubBins({ remoteBranches: ['feat/04-thing'] })
    const { code, out } = run(dir, 'batch/04-stale-reconverge')

    expect(code).toBe(0)
    expect(out).toBe('')
    expect(readFileSync(callLog, 'utf8')).toBe('')
  })

  it('a zero-padded branch collides with an identically zero-padded branch', () => {
    // The prosecutor's exact repro: both branches spell the issue number
    // "0010". Stripping the SEARCH side to "10" and leaving the CANDIDATE
    // text zero-padded made this go blind (10 cannot match inside literal
    // 0010 at a boundary, since the preceding "0" is alphanumeric).
    const { dir } = stubBins({
      remoteBranches: ['feat/0010-unsub-m3plugin'],
    })
    const { code, out } = run(dir, 'feat/0010-second-attempt')

    expect(code).toBe(1)
    expect(out).toContain('claimed by someone else')
    expect(out).toContain('feat/0010-unsub-m3plugin')
  })

  it('a zero-padded branch collides with an identically zero-padded OPEN PR', () => {
    // Same defect, the other collision path: `claim_select_expr`'s jq test
    // over `headRefName` went blind the same way the ls-remote branch check
    // did, because both used the same stripped-search/padded-candidate
    // mismatch.
    const { dir } = stubBins({
      openPrs: [{ number: 200, headRefName: 'feat/0010-unsub-m3plugin', title: '', body: '' }],
    })
    const { code, out } = run(dir, 'feat/0010-second-attempt')

    expect(code).toBe(1)
    expect(out).toContain('#200')
  })

  it('a bare "4" does not collide with "104" or "dm-04" — no `/` means nothing is derived', () => {
    const { dir } = stubBins({
      remoteBranches: ['104', 'dm-04'],
    })
    const { code, out } = run(dir, 'feat/04-thing')

    expect(code).toBe(0)
    expect(out).not.toContain('claimed by someone else')
  })

  it('a bare "4" does not collide with a PR headRefName of "104" or "dm-04"', () => {
    const { dir } = stubBins({
      openPrs: [
        { number: 201, headRefName: '104', title: '', body: '' },
        { number: 202, headRefName: 'dm-04', title: '', body: '' },
      ],
    })
    const { code, out } = run(dir, 'feat/04-thing')

    expect(code).toBe(0)
    expect(out).not.toContain('#201')
    expect(out).not.toContain('#202')
  })
})

describe('claim.sh --guard disagreement: `Refs #N` must read as a claim (#1411, class #1362)', () => {
  // Same defect, same fix, as `claim-structured-refs.test.ts`'s disagreement
  // block — repeated here because `--guard` is a SEPARATE call site with its
  // own query, and #1411 was open in both. See that file's block comment for
  // the full account of why `Refs #N` disagreed with the guard.

  it('blocks on a PR saying "Refs #N" whose branch does not name N', () => {
    const { dir } = stubBins({
      openPrs: [
        {
          number: 80,
          headRefName: 'fix/other-branch',
          title: 'unrelated title',
          body: 'This is instance 8 of #1362.\n\nRefs #1234',
        },
      ],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(1)
    expect(out).toContain('#80')
  })

  it('does not block on a bare mention of #N with no claiming keyword', () => {
    const { dir } = stubBins({
      openPrs: [
        {
          number: 81,
          headRefName: 'fix/other-branch',
          title: 'unrelated title',
          body: 'see also #1234 for context',
        },
      ],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(0)
    expect(out).not.toContain('#81')
  })

  it('a keyword and #N split across a line break do not match', () => {
    const { dir } = stubBins({
      openPrs: [
        {
          number: 82,
          headRefName: 'fix/other-branch',
          title: 'unrelated title',
          body: 'Refs\n#1234',
        },
      ],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code).toBe(0)
    expect(out).not.toContain('#82')
  })
})

describe('claim.sh --guard: shell portability', () => {
  it('parses under sh, dash and bash', () => {
    for (const sh of ['sh', 'dash', 'bash']) {
      expect(() => execFileSync(sh, ['-n', script])).not.toThrow()
    }
  })

  it('the script file actually exists at the resolved path', () => {
    expect(existsSync(script)).toBe(true)
  })
  it('does NOT block on a PR that merely mentions the issue in prose (#1311)', () => {
    // The shape the estate's own practices produce: a PR naming the other
    // instances of a bug class, and what it deliberately left alone. PR #100
    // closes 999 and says it is NOT touching 1234 — it must not lock 1234.
    const { dir } = stubBins({
      openPrs: [
        {
          number: 100,
          headRefName: 'chore/rename',
          title: 'fix the other one',
          body: 'same bug, not fixed in this PR: #1234 is owned by another agent',
          closingIssuesReferences: closes(999),
        },
      ],
    })
    const { code, out } = run(dir, 'feat/1234-thing')

    expect(code, out).toBe(0)
    expect(out).not.toContain('#100')
  })
})
