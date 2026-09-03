import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `--release` refuses when a continuity promise is live (biffo-fleet#1232).
 *
 * PR #1848 stated, in its own body and in a same-session comment on the
 * issue it referenced (#1083), that it would not touch that issue's
 * `in-progress` claim/label. The same session's ordinary end-of-session
 * `--release` fired 21 seconds later and cleared it anyway — a written
 * promise and the actual mechanism disagreeing, exactly the shape
 * `.githooks/pre-push` already refuses structurally for the branch/PR half
 * of collision prevention (AGENTS.md §1). `--reaffirm` (biffo-template#1849)
 * gave a session the right TOOL for this; nothing enforced choosing it over
 * the wrong one. This is that enforcement.
 *
 * ## The case matrix (AGENTS.md's own "matrix before design" rule)
 *
 * MUST-CATCH cases 1 and 2 below are REAL text, captured live:
 *   - case 1: `gh pr view 1848 --repo keiranholloway/biffo-template
 *     --json body -q .body`, the exact "What this PR does not do" section.
 *   - case 2: `gh issue view 1083 --repo keiranholloway/biffo-template
 *     --json comments`, the comment containing "Nothing about this claim
 *     is being touched or released by me".
 *
 * MUST-NOT-CATCH cases 1-3 are also REAL text, captured the same way, from
 * PRs whose SUBJECT MATTER is the claim mechanism itself (#1417, #1665,
 * #1730) — the highest-risk false-positive shape, since they legitimately
 * use words like "claim", "release" and "label" throughout, describing the
 * feature rather than promising continuity for the issue the PR itself
 * references. `#1866`'s body (an ordinary `Refs`-only PR with zero
 * claim-related content) is the baseline must-not-catch case.
 *
 * Cases marked SYNTHETIC are constructed, not captured live, and are noted
 * as such — they extend the matrix to a shape (bare "stays claimed",
 * bare "reaffirm") the real corpus does not yet contain a second instance
 * of, per AGENTS.md's warning against a guard that only recognises one
 * report's literal wording.
 */

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'claim.sh')

// case 1 (MUST-CATCH, real): gh pr view 1848 --repo keiranholloway/biffo-template --json body -q .body
const PR_1848_BODY_EXCERPT =
  'This PR is only the start of a running measurement, due back 2026-09-08. It\n' +
  'is a `Refs`, not a `Closes` — the issue stays open, `in-progress`, and under\n' +
  "the Foreman's existing claim throughout the review window; nothing here\n" +
  'touches that label or that claim.'

// case 2 (MUST-CATCH, real): gh issue view 1083 --repo keiranholloway/biffo-template --json comments
const ISSUE_1083_COMMENT =
  'Nothing about this claim is being touched or released by me; the Foreman\n' +
  'holds it and clears it per its own process.'

// SYNTHETIC (constructed, not captured live) — extends the matrix past the
// one real report's exact wording.
const SYNTHETIC_STAYS_CLAIMED =
  'This issue stays claimed under the Foreman while the 7-day review window runs.'
const SYNTHETIC_BARE_REAFFIRM =
  'See --reaffirm for how to keep this issue claimed once the window closes.'

// must-not-catch case (real): gh pr view 1417 --repo keiranholloway/biffo-template --json body -q .body
// A PR whose SUBJECT is the claim mechanism itself — heavy on "claim"/
// "release"/"label" vocabulary, describing the feature rather than
// promising continuity for the issue it references.
const PR_1417_BODY_EXCERPT =
  'Closes #1411.\n\n' +
  '## The defect\n\n' +
  '`scripts/claim.sh` answered "does this open PR claim issue N?" from two\n' +
  'independently-written jq queries — the `--guard` path (pre-push gate) and\n' +
  "the plain `claim` path — and neither recognised this estate's own `Refs #N`\n" +
  'convention, mandated by AGENTS.md for a PR that must reference an issue\n' +
  '*without* closing it.'

// must-not-catch case (real): gh pr view 1730 --repo keiranholloway/biffo-template --json body -q .body
const PR_1730_BODY_EXCERPT =
  '## What this fixes\n\n' +
  "`scripts/check-closing-keywords.mjs`'s deploy-only-path check silently\n" +
  '**passed** a genuine closing-keyword hit whenever the changed paths were\n' +
  "ordinary, with nothing checking whether GitHub's own\n" +
  '`closingIssuesReferences` actually confirmed the close would happen.'

// must-not-catch case (real): gh pr view 1866 --repo keiranholloway/biffo-template --json body -q .body
// An ordinary `Refs`-only PR with zero claim-related content at all.
const PR_1866_BODY_EXCERPT =
  'Refs keiranholloway/biffo-template#1864\n' +
  'Refs keiranholloway/biffo-fleet#1238\n\n' +
  '## What\n\n' +
  "`cli/vitest.config.ts`'s tmpfs scratch-dir sweep had exactly one signal for\n" +
  '"this `run-*` directory is safe to remove": its age against a flat\n' +
  '`STALE_MS` (2 hours).'

function stub(opts: {
  holder: string
  prBody?: string | null
  issueComments?: string[]
  prListFails?: boolean
  commentsFail?: boolean
}): { dir: string; log: string } {
  const dir = makeTmpDir('claim-release-continuity')
  const log = join(dir, 'log')
  writeFileSync(log, '')
  // `gh`'s own --json/--jq flags do the filtering for real; this stub fakes
  // `gh` entirely, so it must emit exactly what the ALREADY-FILTERED output
  // would be (the same convention claim-reaffirm.test.ts uses for the
  // comments call), not raw unfiltered JSON.
  const commentBodies = [
    `Claimed at 2026-08-21T00:00:00Z. claim-holder:${opts.holder} x`,
    ...(opts.issueComments ?? []),
  ]
  const filteredComments = commentBodies.join('\n---\n')
  const filteredPrBodies = opts.prBody ?? ''
  const gh = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "owner/repo"; exit 0; fi',
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  case "$*" in',
    opts.commentsFail
      ? '    *comments*) exit 1 ;;'
      : `    *comments*) cat <<'BODYEOF'\n${filteredComments}\nBODYEOF\n       ;;`,
    '    *updatedAt*) echo "2026-08-21T00:00:00Z" ;;',
    "    *) printf 'OPEN\\ta claimed issue\\tin-progress\\n' ;;",
    '  esac',
    '  exit 0',
    'fi',
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then echo "edited: $*" >> "$CLAIM_TEST_LOG"; exit 0; fi',
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
    opts.prListFails
      ? '  exit 1'
      : opts.prBody == null
        ? '  printf ""'
        : `  cat <<'BODYEOF'\n${filteredPrBodies}\nBODYEOF`,
    '  exit 0',
    'fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  const git = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "config" ]; then echo "a person"; exit 0; fi',
    'if [ "$1" = "rev-parse" ]; then echo "agent/1083"; exit 0; fi',
    'exit 0',
  ].join('\n')
  writeFileSync(join(dir, 'git'), git)
  chmodSync(join(dir, 'git'), 0o755)
  return { dir, log }
}

function run(dir: string, log: string, args: string[]) {
  try {
    const out = execFileSync('sh', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAIM_TEST_LOG: log },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('claim.sh --release refuses on a live continuity promise (#1232)', () => {
  describe('MUST-CATCH: refuses, points to --reaffirm, does not remove the label', () => {
    it('case 1 (real, PR #1848 body): "under the Foreman\'s existing claim... nothing here touches that label or that claim"', () => {
      const { dir, log } = stub({ holder: 'foreman-1083-r2', prBody: PR_1848_BODY_EXCERPT })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(1)
      expect(out).toContain('refusing to release')
      expect(out).toContain('--reaffirm')
      expect(out).not.toContain('Released')
    })

    it('case 2 (real, issue #1083 comment): "Nothing about this claim is being touched or released by me"', () => {
      const { dir, log } = stub({
        holder: 'foreman-1083-r2',
        issueComments: [ISSUE_1083_COMMENT],
      })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(1)
      expect(out).toContain('refusing to release')
    })

    it('case 3 (SYNTHETIC): bare "stays claimed" phrasing', () => {
      const { dir, log } = stub({
        holder: 'foreman-1083-r2',
        issueComments: [SYNTHETIC_STAYS_CLAIMED],
      })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(1)
      expect(out).toContain('refusing to release')
    })

    it('case 4 (SYNTHETIC): bare "reaffirm" keyword in a referencing comment', () => {
      const { dir, log } = stub({
        holder: 'foreman-1083-r2',
        issueComments: [SYNTHETIC_BARE_REAFFIRM],
      })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(1)
      expect(out).toContain('refusing to release')
    })
  })

  describe('MUST-NOT-CATCH: releases normally', () => {
    it('real, PR #1417 body: the claim mechanism itself is the SUBJECT, not a continuity promise', () => {
      const { dir, log } = stub({ holder: 'foreman-1083-r2', prBody: PR_1417_BODY_EXCERPT })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(0)
      expect(out).toContain('Released')
    })

    it('real, PR #1730 body: an unrelated closing-keyword-guard PR', () => {
      const { dir, log } = stub({ holder: 'foreman-1083-r2', prBody: PR_1730_BODY_EXCERPT })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(0)
      expect(out).toContain('Released')
    })

    it('real, PR #1866 body: an ordinary Refs-only PR with no claim-related content', () => {
      const { dir, log } = stub({ holder: 'foreman-1083-r2', prBody: PR_1866_BODY_EXCERPT })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(0)
      expect(out).toContain('Released')
    })

    it('no referencing PR and no continuity comments at all -- the ordinary case', () => {
      const { dir, log } = stub({ holder: 'foreman-1083-r2' })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(0)
      expect(out).toContain('Released')
    })
  })

  describe('cannot tell: fails closed, same convention as claim_held_by', () => {
    it('refuses (exit 2) rather than releasing when the PR list read fails', () => {
      const { dir, log } = stub({ holder: 'foreman-1083-r2', prListFails: true })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(2)
      expect(out).toContain('cannot tell')
      expect(out).not.toContain('Released')
    })

    it('refuses (exit 2) rather than releasing when the issue comments read fails -- caught earlier, by claim_held_by, not by this guard', () => {
      // claim_continuity_promise ALSO fails closed (return 2) on this same
      // read, defensively -- but through --release specifically it can
      // never be the one to catch it: claim_held_by reads the identical
      // `gh issue view --json comments` call first, in the same process, so
      // a genuinely unreadable comment list fails there before this guard
      // ever runs. That branch inside claim_continuity_promise is therefore
      // unreachable via THIS call site (a deliberate, explained gap, not a
      // silent one) -- it exists for correctness if the function is ever
      // reused by a caller that does not check claim_held_by first. What
      // this test actually pins is the end-to-end guarantee: an unreadable
      // comment list never results in a release, from either layer.
      const { dir, log } = stub({ holder: 'foreman-1083-r2', commentsFail: true })
      const { code, out } = run(dir, log, [
        '1083',
        '--release',
        'foreman-1083-r2',
        '-R',
        'owner/repo',
      ])
      expect(code).toBe(2)
      expect(out).toContain('cannot tell')
      expect(out).not.toContain('Released')
    })
  })

  it('the exact #1848/#1083 incident, end to end: promise made, ordinary --release now refused instead of silently succeeding', () => {
    const { dir, log } = stub({
      holder: 'foreman-1083-r2',
      prBody: PR_1848_BODY_EXCERPT,
      issueComments: [ISSUE_1083_COMMENT],
    })
    const { code, out } = run(dir, log, [
      '1083',
      '--release',
      'foreman-1083-r2',
      '-R',
      'owner/repo',
    ])
    expect(code).toBe(1)
    expect(out).not.toContain('Released')
    // The label was never touched -- unlike the real incident, where
    // `gh issue edit --remove-label` ran 21 seconds after the promise.
    const editLog = execFileSync('cat', [log], { encoding: 'utf8' })
    expect(editLog).toBe('')
  })
})
