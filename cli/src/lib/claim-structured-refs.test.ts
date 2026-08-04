import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `claim.sh` decides "is this issue already being worked?" from GitHub's
 * STRUCTURED closing references, not from a text match over the PR body
 * (#1281, #1311).
 *
 * ## Why the text match had to go
 *
 * It asked "does this PR's title or body contain `#N`?", which conflates three
 * different things:
 *
 *  - **A cross-repo reference.** `@tabsii-com/ui#3` matched as a local claim,
 *    because the character before `#` is a letter rather than a digit. Claiming
 *    `tabsii-lms#3` reported it worked by merged PR #24, which referenced the
 *    shared UI package's issue 3, not the LMS one (#1281).
 *  - **A note saying the PR is NOT doing the work.** PR #50's body read
 *    *"same bug, not fixed in this PR ... owned by another agent for #47/#48"*
 *    and thereby blocked #47's own branch (#1311). The estate's own practices
 *    ask every PR to name the other instances of a bug class and what it
 *    deliberately left alone — so **the better a PR documents its boundaries,
 *    the more issues it locked.**
 *  - The thing actually meant: a PR that will close the issue.
 *
 * Both are false positives, and a false positive here is worse than a miss: it
 * tells an agent to skip work nobody is doing, and the failure mode is silence.
 *
 * ## Why the number alone is still not the answer
 *
 * `closingIssuesReferences` includes CROSS-REPO closes in the same list —
 * `tabsii-lms#43` legitimately closes `tabsii-platform#553`. Matching on
 * `.number` would reproduce #1281 inside the structured data, so the repository
 * is compared too.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

interface Pr {
  number: number
  headRefName: string
  /** Present so the OLD body-text matcher would have matched — without it these
   *  cases pass against the old script too, for the wrong reason. */
  title?: string
  body?: string
  closingIssuesReferences?: Array<{
    number: number
    repository: { name: string; owner: { login: string } }
  }>
}

/** A closing reference in the repo under test. */
const local = (n: number) => ({
  number: n,
  repository: { name: 'repo', owner: { login: 'owner' } },
})
/** A closing reference in a DIFFERENT repo — the #1281 shape. */
const foreign = (n: number) => ({
  number: n,
  repository: { name: 'ui', owner: { login: 'owner' } },
})

function stub(openPrs: Pr[]): string {
  const dir = makeTmpDir('claimrefs')
  const fixture = join(dir, 'prs.json')
  writeFileSync(fixture, JSON.stringify(openPrs))

  const gh = [
    '#!/usr/bin/env bash',
    // The repo under test.
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    // An open, unlabelled issue -> not blocked by the label signal.
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    "  printf 'OPEN\\ta free issue\\t\\n'",
    '  exit 0',
    'fi',
    // Forward claim.sh's OWN --jq to real jq against the fixture, so the
    // expression under test is the one that ships.
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
    '  for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
    '  case "$*" in *"--state merged"*) echo "[]" | jq -r "$jqexpr" ;;',
    `    *) jq -r "$jqexpr" ${JSON.stringify(fixture)} ;; esac`,
    '  exit 0',
    'fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

function claim(binDir: string, issue: number) {
  try {
    const out = execFileSync('sh', [script, String(issue), '--check'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('claim.sh matches structured closing references (#1281, #1311)', () => {
  it('a PR that merely MENTIONS the issue does not claim it', () => {
    // #1311: PR #50 says "not fixed in this PR ... owned by another agent for
    // #47" and closes only 49. It must not block #47.
    const dir = stub([
      {
        number: 50,
        headRefName: 'fix/49-dates',
        title: 'UK date format',
        body: 'same bug, not fixed in this PR: #47 is owned by another agent',
        closingIssuesReferences: [local(49)],
      },
    ])
    const { code, out } = claim(dir, 47)
    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })

  it('a CROSS-REPO closing reference with the same number does not claim it', () => {
    // #1281: the number matches, the repository does not.
    const dir = stub([
      {
        number: 24,
        headRefName: 'fix/ui-thing',
        title: 'shared UI fix',
        body: 'closes @tabsii-com/ui#3',
        closingIssuesReferences: [foreign(3)],
      },
    ])
    const { code, out } = claim(dir, 3)
    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })

  it('a genuine LOCAL closing reference still blocks — no false negative', () => {
    const dir = stub([
      { number: 60, headRefName: 'feat/thing', closingIssuesReferences: [local(3)] },
    ])
    const { code, out } = claim(dir, 3)
    expect(code, out).toBe(1)
    expect(out).toMatch(/open PR/i)
  })

  it('a branch NAMING the issue still blocks, so "Towards #N" work stays visible', () => {
    // Closing references only capture closing KEYWORDS. The branch-name signal
    // is what keeps a PR that merely works an issue from being invisible.
    const dir = stub([{ number: 61, headRefName: 'fix/3-something', closingIssuesReferences: [] }])
    const { code, out } = claim(dir, 3)
    expect(code, out).toBe(1)
    expect(out).toMatch(/open PR/i)
  })
})
