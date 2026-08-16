import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The disagreement test for `claim-structural-resolver`, instance #9 of class
 * #1362 ("a guard resolves its answer from a different document than the actor
 * it is guarding"). Recorded as `disagreementTest: null` in
 * `guard-authority-inventory.ts`.
 *
 * ## The two documents
 *
 * - **The guard** is `claim.sh`, answering "is this issue already being
 *   worked?" from `claim_select_expr()`'s three signals.
 * - **The authority** is whether an open PR is *actually doing the work*. There
 *   is no GitHub field for that, which is the whole difficulty: GitHub's own
 *   structured answer (`closingIssuesReferences`) is populated **only** by a
 *   closing keyword, and this estate's conventions deliberately produce PRs
 *   that must not close their issue — partial fixes, DDL PRs, anything held
 *   open for verification.
 *
 * #1411 measured the consequence: PR #1410 was open against #1352 with
 * `closingIssuesReferences: 0` and branch `feat/pnpm-overrides-delivery`, and
 * `claim.sh` re-offered #1352 as free. **The better an author followed the
 * "don't close what you haven't verified" rule, the less protected their work
 * was.**
 *
 * ## What is being guarded against, in both directions
 *
 * The resolver's difficulty is that the two failure modes have opposite fixes,
 * and this class has produced instances of each:
 *
 * - **Miss** (#1411): a PR doing real work is invisible, so two sessions start
 *   the same thing.
 * - **False block** (#1311, #1327, #1281): a PR that merely *mentions* an issue
 *   — often to say it is deliberately NOT doing it — locks work nobody is
 *   doing. The estate's practices ask every PR to name the other instances of a
 *   class and what it left alone, so a naive text scan punishes exactly the
 *   PRs that document themselves best.
 *
 * A test that only asserted the miss is fixed would license a text scan, and
 * three prior instances were text scans. So this file pins BOTH directions
 * against one resolver, which is what makes it a disagreement test rather than
 * a regression test for #1411.
 *
 * ## Why these fixtures are the estate's own conventions
 *
 * Every "should claim" case below is a PR shape `AGENTS.md` actively mandates,
 * and every "should not claim" case is a PR shape it actively encourages. The
 * fixtures are not invented edge cases; they are the documented house style,
 * which is what made this blind spot structural rather than rare.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

interface Pr {
  number: number
  headRefName: string
  title?: string
  body?: string
  closingIssuesReferences?: Array<{
    number: number
    repository: { name: string; owner: { login: string } }
  }>
}

const local = (n: number) => ({
  number: n,
  repository: { name: 'repo', owner: { login: 'owner' } },
})

/**
 * Hermetic `claim.sh`. Stubs all four of its signals — `gh repo view`, `gh
 * issue view`, `gh pr list` (forwarding the script's OWN `--jq` to real jq, so
 * the expression under test is the shipping one) and `git ls-remote`.
 *
 * The `git` stub is load-bearing and its absence has bitten before: signal 3
 * ("a remote branch names this issue") is answered by `git ls-remote --heads`,
 * not by `gh`, so without it the test queries the real repository and any
 * pushed branch carrying the fixture's issue number fails every case at once.
 * See the note in `claim-structured-refs.test.ts`, where that happened.
 */
function stub(openPrs: Pr[]): string {
  const dir = makeTmpDir('claimresolver')
  const fixture = join(dir, 'prs.json')
  writeFileSync(fixture, JSON.stringify(openPrs))

  const gh = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    "  printf 'OPEN\\ta free issue\\t\\n'",
    '  exit 0',
    'fi',
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

  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const git = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "ls-remote" ]; then exit 0; fi',
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join('\n')
  writeFileSync(join(dir, 'git'), git)
  chmodSync(join(dir, 'git'), 0o755)

  return dir
}

function claim(binDir: string, issue: number) {
  try {
    const out = execFileSync(
      'sh',
      [script, String(issue), '--as', 'resolver-test-0816', '--check'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    )
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('claim.sh agrees with who is actually working (class #1362, instance #9)', () => {
  it('the #1411 case: a Refs-only PR with no issue number in its branch DOES claim', () => {
    // The measured failure, reconstructed exactly: PR #1410 against #1352,
    // `closingIssuesReferences: 0`, branch `feat/pnpm-overrides-delivery`.
    // Before the resolver, claim.sh reported #1352 free while this was open.
    const dir = stub([
      {
        number: 1410,
        headRefName: 'feat/pnpm-overrides-delivery',
        title: 'deliver a missing pnpm override',
        body: 'Refs #1352\n\nPartial: delivery only, the value-divergence half stays open.',
        closingIssuesReferences: [],
      },
    ])

    const { code, out } = claim(dir, 1352)

    expect(code, out).toBe(1)
    expect(out).toMatch(/open PR/i)
  })

  it('a partial fix using Refs — the shape three PRs landed in one day — claims its issue', () => {
    const dir = stub([
      {
        number: 1409,
        headRefName: 'feat/tool-supply-audit',
        body: 'Adds the tool-supply audit.\n\nRefs #822 — model-id validation deferred.',
        closingIssuesReferences: [],
      },
    ])

    const { code, out } = claim(dir, 822)

    expect(code, out).toBe(1)
    expect(out).toMatch(/open PR/i)
  })

  it('a PR that says it is deliberately NOT doing the issue does not claim it', () => {
    // #1311. The estate asks every PR to name the other instances of a class
    // and what it left alone, so this shape is produced by following the
    // practices — and a text scan would lock the issue it politely declines.
    const dir = stub([
      {
        number: 50,
        headRefName: 'fix/49-dates',
        body: 'Fixes the date format. The same bug at #47 is owned by another agent and is NOT touched here.',
        closingIssuesReferences: [local(49)],
      },
    ])

    const { code, out } = claim(dir, 47)

    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })

  it('a bare mention in prose does not claim — only the Refs convention does', () => {
    // The discriminator is the estate's documented keyword, not the presence of
    // `#N`. Without this, the resolver is the text scan #1327 removed.
    const dir = stub([
      {
        number: 61,
        headRefName: 'chore/unrelated',
        body: 'Background: this is the same area as #77, which explains the naming.',
        closingIssuesReferences: [],
      },
    ])

    const { code, out } = claim(dir, 77)

    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })

  it('a keyword ending one line with the number on the next does not claim', () => {
    // #1334's shape, in the other parser: GitHub's own closing-keyword scan
    // treats `Closes\n#N` as a reference because `\s` matches a newline. The
    // resolver uses `[ \t]`, so a paragraph ending in "refs" followed by a
    // list starting "#77" is prose, not a claim. Pinned because the natural
    // way to write this regex is with `\s` and it reads identically.
    const dir = stub([
      {
        number: 62,
        headRefName: 'chore/unrelated',
        body: 'See the surrounding refs\n#77 is listed there for context.',
        closingIssuesReferences: [],
      },
    ])

    const { code, out } = claim(dir, 77)

    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })

  it('a cross-repo Refs does not claim the local issue of the same number', () => {
    // #1281 inside the Refs convention rather than inside closing references.
    // `owner/ui#3` and `#3` differ by the characters before the `#`.
    const dir = stub([
      {
        number: 63,
        headRefName: 'chore/unrelated',
        body: 'Refs owner/ui#3 — the shared package, not this repo.',
        closingIssuesReferences: [],
      },
    ])

    const { code, out } = claim(dir, 3)

    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })

  it('the branch-name signal still claims when the body says nothing at all', () => {
    // The third signal, and the one that needs no convention to be followed —
    // you cannot do the work without creating a branch. Kept in the suite so a
    // future simplification of the resolver cannot quietly drop it.
    const dir = stub([{ number: 64, headRefName: 'fix/1352-overrides', body: '' }])

    const { code, out } = claim(dir, 1352)

    expect(code, out).toBe(1)
    expect(out).toMatch(/open PR/i)
  })

  it('a branch whose number merely CONTAINS the issue number does not claim', () => {
    // `fix/13520-thing` must not claim #1352. Substring matching here would
    // make the miss-fix into a false-block generator, which is the trade this
    // whole class keeps getting wrong in one direction or the other.
    const dir = stub([{ number: 65, headRefName: 'fix/13520-unrelated', body: '' }])

    const { code, out } = claim(dir, 1352)

    expect(code, out).toBe(0)
    expect(out).toContain('Free')
  })
})
