import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
// @ts-expect-error -- plain .mjs so it runs on bare node in CI with no install,
// like every other script in scripts/. Tested from here so the logic has one home.
import {
  assess,
  closingReferences,
  deliberateClosingReferences,
  DEPLOY_ONLY_PREFIXES,
  deployOnlyPaths,
  documentsFor,
  fetchPrClosingIssuesReferencesViaGh,
  fetchPrCommitsViaGh,
  fetchPrTitleViaGh,
  formatFailure,
  hasVerifiedTrailer,
  negatedClosingReferences,
  resolveBody,
  resolveCommits,
  resolveTitle,
  VERIFIED_TRAILER,
} from '../../../scripts/check-closing-keywords.mjs'

// fetchPrClosingIssuesReferencesViaGh shells out too, and unlike the other
// two fetchers below it is actually EXERCISED here, not just typeof-checked —
// see the describe block near the bottom of this file for why that gap is
// exactly what let tabsii-crm#379 through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, execFileSync: vi.fn() }
})

/**
 * The two REAL bodies that motivated the negation guard (#1245). Fixtures, not
 * paraphrases: three of the four occurrences were "fixed" by re-writing the
 * rule down, so this guard is proven against the text that actually shipped.
 */
const PR_1238_BODY = [
  '## What this does',
  '',
  '- **Does not close #1021.** Two of its three checkboxes are answered by this',
  '  PR, which is the fail-open the tool exists to close.',
].join('\n')

const TABSII_CRM_141_BODY = [
  '## Scope note — this PR alone does not close #133',
  '',
  'Refs #133.',
].join('\n')

describe('closing-keyword guard', () => {
  describe('closingReferences', () => {
    it('finds every keyword GitHub actually acts on', () => {
      for (const kw of ['Closes', 'closed', 'Fix', 'fixes', 'Resolve', 'resolved']) {
        expect(closingReferences(`${kw} #12`)).toEqual(['#12'])
      }
    })

    it('finds the cross-repo and colon forms', () => {
      expect(closingReferences('Closes tabsii-com/tabsii-platform#511')).toEqual([
        'tabsii-com/tabsii-platform#511',
      ])
      expect(closingReferences('Closes: #7')).toEqual(['#7'])
    })

    it('ignores a keyword inside a fenced code block', () => {
      // A PR that quotes a commit message as an example should not trip a gate.
      const body = ['Here is what NOT to write:', '', '```', 'Closes #99', '```'].join('\n')
      expect(closingReferences(body)).toEqual([])
    })

    it('ignores a keyword inside an INLINE code span', () => {
      // GitHub does not linkify `#12` in backticks, so it does not close
      // anything there. Matching would make this guard stricter than the
      // behaviour it models — and it is how the guard failed its own PR, whose
      // body has to quote the pattern it forbids.
      expect(closingReferences('The rule refuses `Closes #99` on deploy paths')).toEqual([])
      expect(closingReferences('`Closes #99` here, but Closes #12 for real')).toEqual(['#12'])
    })

    it('does not match a mere mention of an issue', () => {
      expect(closingReferences('Related to #12, see also #13')).toEqual([])
      expect(closingReferences('Refs #12')).toEqual([])
    })

    it('does not match a word that merely starts with a keyword', () => {
      expect(closingReferences('Closest #12')).toEqual([])
    })

    // Real text: PR #1789's own body (`gh pr view 1789 --json body`). A
    // markdown heading ending in a closing keyword, a blank line, then an
    // entirely unrelated paragraph whose first token is a `#N` reference —
    // `\s+` used to span the blank line and read the two as one hit.
    // GitHub's own ground truth for this PR (`gh pr view 1789 --json
    // closingIssuesReferences`) never included #1717, only the genuine
    // `Closes #1718` trailer elsewhere in the same body — confirming the
    // heading/paragraph pair is not one unit to GitHub either.
    it('does NOT span a blank line — a heading ending in a keyword must not reach into the next paragraph', () => {
      const body = [
        '## What this fixes',
        '',
        '#1717 fixed one of two acceptance routes for a template-owned-path divergence.',
      ].join('\n')
      expect(closingReferences(body)).toEqual([])
    })

    it('still matches across a SINGLE line break — only a blank line (paragraph break) is excluded', () => {
      expect(closingReferences('Closes\n#1718')).toEqual(['#1718'])
    })

    // #1732: a commit message has no markdown semantics, so `{ code: false
    // }` must find a hit even inside backticks — the opposite of the
    // default, which correctly models the PR body/title's real markdown
    // rendering.
    it('with { code: false }, finds a keyword even INSIDE backticks — commit messages are not markdown', () => {
      expect(
        closingReferences('The rule refuses `Closes #99` on deploy paths', { code: false }),
      ).toEqual(['#99'])
    })

    it('with { code: false } still finds a keyword with no backticks at all, same as the default', () => {
      expect(closingReferences('Closes #99', { code: false })).toEqual(['#99'])
    })
  })

  describe('deliberateClosingReferences', () => {
    it('recognises a trailer on its own line as deliberate', () => {
      expect(deliberateClosingReferences('Closes #1001')).toEqual(['#1001'])
    })

    it('recognises a trailer sentence following prose on the same line', () => {
      expect(deliberateClosingReferences('warnings on both commands. Closes #201.')).toEqual([
        '#201',
      ])
    })

    it('does NOT recognise a mid-sentence hit as deliberate — the #1680/#1664 real shape', () => {
      expect(deliberateClosingReferences('This is the one-word fix #1664 asked for.')).toEqual([])
    })

    // #1732: with { code: false }, a LEADING backtick is a literal character
    // sitting before the keyword, not stripped away — so it blocks the
    // clause-initial match the same way any other stray character would,
    // and this reads as NOT deliberate. That is the safe direction, not a
    // bug: an author who wraps `Closes #99` in backticks inside a COMMIT
    // message, out of habit from writing PR bodies (where it WOULD be
    // protected), gets exactly what happened for real in #1730 — GitHub
    // still closes it regardless of the backticks, so this heuristic
    // correctly refuses to call that "obviously intentional" and asks for a
    // plain, backtick-free trailer instead (see `assess`'s
    // `commit-ground-truth-mismatch`, which this feeds).
    it('with { code: false }, a backtick-WRAPPED trailer is NOT recognised as deliberate — the safe direction', () => {
      expect(deliberateClosingReferences('`Closes #99`', { code: false })).toEqual([])
      // The un-stripped hit detector still finds it, though — GitHub will
      // still act on it, backticks or not, which is exactly why this is not
      // treated as safe.
      expect(closingReferences('`Closes #99`', { code: false })).toEqual(['#99'])
    })

    // Regression control for the same corpus shape as `closingReferences`'s
    // blank-line test above, on this function's own (independently patched)
    // keyword-to-reference tail — both patterns end in the identical
    // `\b:?<gap>(REFERENCE)` shape. This function already read the shape as
    // not-deliberate before the fix too (the heading's clause-start
    // decoration matches `## ` but never reaches the word "fixes" itself,
    // since only list/heading/bold markers count as decoration, not
    // arbitrary prose) — recorded here so a future change to
    // `CLAUSE_DECORATION` can't silently reopen it.
    it('does NOT span a blank line either — the PR #1789 heading/paragraph shape', () => {
      const body = ['## What this fixes', '', '#1717 fixed one of two acceptance routes.'].join(
        '\n',
      )
      expect(deliberateClosingReferences(body)).toEqual([])
    })
  })

  // #1245: GitHub's linker has no concept of negation. A body saying it does
  // NOT close an issue closes it anyway. Four occurrences, three of them
  // "fixed" by writing the rule down again — hence a mechanism.
  describe('negatedClosingReferences', () => {
    it('FAILS on the real #1238 body, and names the line that did it', () => {
      // #1021 closed at 2026-08-03T18:20:53Z by a7797a5, the squash-merge of
      // #1238, whose commit message carried only `Refs #1021`. The close came
      // from this sentence.
      const found = negatedClosingReferences(PR_1238_BODY)
      expect(found).toHaveLength(1)
      expect(found[0].reference).toBe('#1021')
      expect(found[0].lineNumber).toBe(3)
      expect(found[0].line).toContain('Does not close #1021.')
    })

    it('FAILS on the real tabsii-crm#141 body — the third occurrence', () => {
      const found = negatedClosingReferences(TABSII_CRM_141_BODY)
      expect(found).toHaveLength(1)
      expect(found[0].reference).toBe('#133')
      expect(found[0].lineNumber).toBe(1)
      expect(found[0].line).toContain('does not close #133')
    })

    it('catches the other negation forms an author would reach for', () => {
      for (const phrase of [
        "doesn't close #7",
        "don't fix #7",
        "won't resolve #7",
        'will not resolve #7',
        'does not fix #7',
        'did not fix #7',
        'this cannot close #7',
        'never closes #7',
        'Does NOT close #7',
      ]) {
        const refs = negatedClosingReferences(phrase).map((n: { reference: string }) => n.reference)
        expect(refs, phrase).toEqual(['#7'])
      }
    })

    it('spans a line break, because markdown renders one as a space', () => {
      expect(negatedClosingReferences('this PR does not\nclose #7')).toHaveLength(1)
    })

    it('finds the cross-repo form too', () => {
      expect(
        negatedClosingReferences('does not close tabsii-com/tabsii-crm#133')[0].reference,
      ).toBe('tabsii-com/tabsii-crm#133')
    })

    it('does NOT fire on ordinary prose — the false positives that would kill it', () => {
      // Verbatim from #1238's own body, and harmless: no issue number follows.
      expect(negatedClosingReferences('which is the fail-open the tool exists to close.')).toEqual(
        [],
      )
      // The safe rewrite this guard asks for must itself pass.
      expect(negatedClosingReferences('Refs #1021')).toEqual([])
      expect(negatedClosingReferences('Refs #1021 — this PR leaves #1021 open')).toEqual([])
      // A negation with no reference closes nothing, so there is nothing to warn about.
      expect(negatedClosingReferences('This does not close it')).toEqual([])
      // A keyword with no negation is the OTHER check's business, not this one.
      expect(negatedClosingReferences('Closes #1021')).toEqual([])
      // Not a closing keyword at all.
      expect(negatedClosingReferences('does not touch #1021')).toEqual([])
      expect(negatedClosingReferences('will not reopen #1021')).toEqual([])
      // Gerunds are not keywords GitHub acts on, so nothing closes here either.
      // Firing would make this guard stricter than the behaviour it models.
      expect(negatedClosingReferences('merged without closing #1021')).toEqual([])
      // A reference that is not adjacent to the keyword.
      expect(negatedClosingReferences('does not close anything; see #1021')).toEqual([])
    })

    it('ignores a negation inside code, because GitHub linkifies nothing there', () => {
      // Load-bearing: this guard's own failure message quotes the pattern, and
      // so must any PR discussing it — including the one that added it.
      expect(negatedClosingReferences('Never write `does not close #12` in a body')).toEqual([])
      expect(negatedClosingReferences(['```', 'Does not close #12', '```'].join('\n'))).toEqual([])
    })
  })

  describe('deployOnlyPaths', () => {
    it('selects only the paths whose behaviour a suite cannot evidence', () => {
      const changed = [
        'infra/environments/dev/main.tf',
        'apps/portal/src/components/auth-guard.tsx',
        'db/imports/tabsii/082_thing.sql',
        '.github/workflows/ci.yml',
        'modules/cloud/aws/cdn/main.tf',
        // Not deploy-only: a failing-first test really does evidence these.
        'cli/src/lib/core-upgrade.ts',
        'services/api/src/api/routers/users.py',
        'docs/ADR/0001-thing.md',
      ]
      expect(deployOnlyPaths(changed)).toEqual([
        'infra/environments/dev/main.tf',
        'apps/portal/src/components/auth-guard.tsx',
        'db/imports/tabsii/082_thing.sql',
        '.github/workflows/ci.yml',
        'modules/cloud/aws/cdn/main.tf',
      ])
    })

    it('treats a SIBLING frontend as deploy-only too (#1395)', () => {
      // A satellite calls it `apps/frontend/` where this repo calls it
      // `apps/portal/`. Both are in the one list rather than each skeleton
      // carrying a flavoured copy: a sibling has no `apps/portal/` and this
      // repo has no `apps/frontend/`, so each entry is inert where it does not
      // apply — and two copies of a list are two places for it to drift.
      expect(deployOnlyPaths(['apps/frontend/src/lib/auth.ts'])).toEqual([
        'apps/frontend/src/lib/auth.ts',
      ])
    })

    it('keeps the list short on purpose', () => {
      // A guard that fires on everything teaches people to bypass it. If this
      // number climbs, argue for each addition with an incident.
      //
      // #1395 took it to exactly six — the ceiling, not room under it. The
      // incident is tabsii-crm#320: a negated keyword closed an issue in a
      // satellite, whose frontend lives at a path this list did not name. The
      // NEXT addition needs the number raised deliberately, which is the point.
      expect(DEPLOY_ONLY_PREFIXES.length).toBeLessThanOrEqual(6)
    })
  })

  describe('hasVerifiedTrailer', () => {
    it('accepts a trailer that carries evidence', () => {
      expect(hasVerifiedTrailer(`${VERIFIED_TRAILER} saw 34 checked on dev deploy 123`)).toBe(true)
    })

    it('rejects a bare trailer with nothing after the colon', () => {
      // A box tick is not evidence.
      expect(hasVerifiedTrailer(VERIFIED_TRAILER)).toBe(false)
      expect(hasVerifiedTrailer(`${VERIFIED_TRAILER}   `)).toBe(false)
    })
  })

  describe('assess', () => {
    const deployPath = ['infra/environments/dev/main.tf']

    it('passes when the body closes nothing', () => {
      expect(assess({ body: 'Refs #1', changedFiles: deployPath }).ok).toBe(true)
    })

    it('passes when the change is provable locally', () => {
      expect(assess({ body: 'Closes #1', changedFiles: ['cli/src/lib/a.ts'] }).ok).toBe(true)
    })

    it('FAILS the case this guard exists for', () => {
      // tabsii-platform#511, 2026-08-02: `Closes #511` auto-closed the issue on
      // merge, ten minutes before the deploy that proved anything.
      const result = assess({ body: 'Closes #511', changedFiles: deployPath })
      expect(result.ok).toBe(false)
      expect(result.references).toEqual(['#511'])
      expect(result.paths).toEqual(deployPath)
    })

    it('passes when the author states what they saw on a deployed environment', () => {
      const body = ['Closes #511', '', `${VERIFIED_TRAILER} deploy 30752514507, checked: 34`].join(
        '\n',
      )
      expect(assess({ body, changedFiles: deployPath }).ok).toBe(true)
    })

    it('FAILS a negated keyword on a path the deploy-only check ignores', () => {
      // The whole point of #1245: #1238 touched `scripts/` and `cli/`, so the
      // deploy-only check correctly stayed silent — and #1021 closed anyway.
      const localOnly = ['scripts/wait-for-checks.sh', 'cli/src/lib/a.ts']
      expect(assess({ body: 'Closes #1021', changedFiles: localOnly }).ok).toBe(true)

      const result = assess({ body: PR_1238_BODY, changedFiles: localOnly })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('negated-keyword')
      expect(result.negated.map((n: { reference: string }) => n.reference)).toEqual(['#1021'])
    })

    it('FAILS the tabsii-crm#141 body too, on no changed files at all', () => {
      // Path-independent by construction: the failure mode has nothing to do
      // with what the PR touches.
      const result = assess({ body: TABSII_CRM_141_BODY, changedFiles: [] })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('negated-keyword')
    })

    it('does not let a Verified-on-deploy trailer excuse a negated keyword', () => {
      // The trailer says "I saw this working". A negation says "this is not
      // being closed". They are not the same claim, so one cannot waive the
      // other.
      const body = [PR_1238_BODY, '', `${VERIFIED_TRAILER} deploy 30752514507`].join('\n')
      expect(assess({ body, changedFiles: ['infra/a.tf'] }).ok).toBe(false)
    })

    it('names the offending line and both rewrites, so the fix is obvious', () => {
      const result = assess({ body: PR_1238_BODY, changedFiles: ['cli/src/lib/a.ts'] })
      const message = formatFailure(result)
      expect(message).toContain('#1021')
      expect(message).toContain('line 3')
      expect(message).toContain('Does not close #1021.')
      // Both suggested rewrites, verbatim from the issue.
      expect(message).toContain('Refs #1021')
      expect(message).toContain('leaves #1021 open')
    })

    it('names both the issue and the paths, so the fix is obvious from the log', () => {
      const result = assess({
        body: 'Closes #511 and fixes #512',
        changedFiles: ['infra/a.tf', 'apps/portal/b.tsx'],
      })
      const message = formatFailure(result)
      expect(message).toContain('#511')
      expect(message).toContain('#512')
      expect(message).toContain('infra/a.tf')
      expect(message).toContain('apps/portal/b.tsx')
      // And says how to proceed, both ways.
      expect(message).toContain('Refs #N')
      expect(message).toContain(VERIFIED_TRAILER)
    })

    // Real text: PR #1789's own body (`gh pr view 1789 --json body`), a
    // deploy-only-path PR. `## What this fixes` (heading, ends in a closing
    // keyword) is followed by a blank line and then an unrelated paragraph
    // starting `#1717 fixed one of two acceptance routes...`; a genuine
    // `Closes #1718` sits elsewhere in the same body. Before the fix, the
    // `deploy-only-path` branch used raw `closingReferences` with no
    // reconciliation, so it reported BOTH #1718 and #1717 — but GitHub's own
    // `closingIssuesReferences` for this PR
    // (`gh pr view 1789 --json closingIssuesReferences`) returns only #1718:
    // #1717 was never something GitHub was about to act on. The failure must
    // still fire (a real, deliberate `Closes #1718` on a deploy-only path is
    // exactly what this check exists to catch) but must name only #1718.
    it('on the real PR #1789 shape, flags only the genuine close, not the heading/paragraph false positive', () => {
      const body = [
        'Closes #1718',
        '',
        '## What this fixes',
        '',
        '#1717 fixed one of two acceptance routes for a template-owned-path divergence:',
        'unrelated prose that happens to start with an issue reference.',
      ].join('\n')
      const result = assess({ body, changedFiles: ['.github/workflows/orphan-ratchet-report.yml'] })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('deploy-only-path')
      expect(result.references).toEqual(['#1718'])
    })
  })

  // #1174: `github.event.pull_request.body` is frozen at the moment the
  // `pull_request` event fired, so editing the PR body — or re-running the
  // job — could never turn a failing check green. `resolveBody` is what
  // decides between the direct value (local runs, and every test above) and
  // a live fetch (CI), and it must fail CLOSED when the live fetch cannot be
  // trusted, not silently pass on an unreadable body.
  describe('resolveBody', () => {
    it('uses PR_BODY directly when set, and never calls the live fetch', async () => {
      const fetchLiveBody = vi.fn()
      const body = await resolveBody({
        env: { PR_BODY: 'Refs #1', GH_TOKEN: 'x', PR_NUMBER: '5', GH_REPO: 'a/b' },
        fetchLiveBody,
      })
      expect(body).toBe('Refs #1')
      expect(fetchLiveBody).not.toHaveBeenCalled()
    })

    it('treats a deliberately empty PR_BODY as set, not as "fetch instead"', async () => {
      const fetchLiveBody = vi.fn()
      const body = await resolveBody({ env: { PR_BODY: '' }, fetchLiveBody })
      expect(body).toBe('')
      expect(fetchLiveBody).not.toHaveBeenCalled()
    })

    it('fetches live when PR_BODY is absent and the CI trio is present — the CI path', async () => {
      const fetchLiveBody = vi.fn().mockResolvedValue('Closes #9')
      const body = await resolveBody({
        env: { GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' },
        fetchLiveBody,
      })
      expect(body).toBe('Closes #9')
      expect(fetchLiveBody).toHaveBeenCalledWith({ GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' })
    })

    it('returns an empty body when neither PR_BODY nor the CI trio is set (not a PR at all)', async () => {
      const fetchLiveBody = vi.fn()
      const body = await resolveBody({ env: {}, fetchLiveBody })
      expect(body).toBe('')
      expect(fetchLiveBody).not.toHaveBeenCalled()
    })

    it('FAILS CLOSED when the live fetch throws, rather than treating it as no closing keyword', async () => {
      const fetchLiveBody = vi
        .fn()
        .mockRejectedValue(new Error('HTTP 403: Resource not accessible'))
      await expect(
        resolveBody({
          env: { GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' },
          fetchLiveBody,
        }),
      ).rejects.toThrow(/could not fetch.*#9.*a\/b.*403/s)
    })

    it('FAILS CLOSED on a half-configured CI trio rather than silently falling back to empty', async () => {
      // GH_REPO missing: a workflow bug, not "not a pull request". Falling
      // through to '' here would pass every PR while the fetch is broken.
      const fetchLiveBody = vi.fn()
      await expect(
        resolveBody({ env: { GH_TOKEN: 'x', PR_NUMBER: '9' }, fetchLiveBody }),
      ).rejects.toThrow(/GH_TOKEN, PR_NUMBER and GH_REPO must all be set together/)
      expect(fetchLiveBody).not.toHaveBeenCalled()
    })
  })

  // #1334: GitHub builds this repo's squash-merge commit message from the
  // individual COMMIT messages, not the PR body. PR #1332 was opened with
  // `Closes #1331`, Release Guards correctly refused it (a deploy-only
  // path), the body was corrected to `Refs #1331`, the guard re-ran reading
  // only `PR_BODY` and passed — and #1331 closed anyway on merge, because
  // the first commit's message still said `Closes #1331`. The guard was
  // right about what it read; GitHub read a different document. #1362 names
  // this class: "a guard reads a different document from the one that
  // acts" — the fix is to read all three documents GitHub honours (body,
  // title, commit messages), not just the one this guard used to see.
  describe('documentsFor and assess — the commit-message and title sources (#1334)', () => {
    it('documentsFor includes the body, the title, and each commit — headline AND body', () => {
      const docs = documentsFor({
        body: 'Refs #1',
        title: 'fix(ci): tighten workflow permissions',
        commits: [{ messageHeadline: 'fix(ci): a', messageBody: 'Closes #1' }],
      })
      expect(docs).toEqual([
        { source: 'the PR body', text: 'Refs #1', kind: 'body' },
        { source: 'the PR title', text: 'fix(ci): tighten workflow permissions', kind: 'title' },
        { source: 'the commit message (subject)', text: 'fix(ci): a', kind: 'commit' },
        { source: 'the commit message (body)', text: 'Closes #1', kind: 'commit' },
      ])
    })

    it('labels multiple commits by position, since "the commit message" would be ambiguous', () => {
      const docs = documentsFor({
        body: '',
        commits: [
          { messageHeadline: 'fix(a): one', messageBody: '' },
          { messageHeadline: 'fix(b): two', messageBody: 'Closes #2' },
        ],
      })
      expect(docs.map((d) => d.source)).toEqual([
        'the PR body',
        'commit 1 (subject)',
        // commit 1's empty messageBody contributes no document — nothing to scan
        'commit 2 (subject)',
        'commit 2 (body)',
      ])
    })

    it('omits title and commits entirely when absent, so every pre-#1334 caller is unaffected', () => {
      expect(documentsFor({ body: 'Refs #1' })).toEqual([
        { source: 'the PR body', text: 'Refs #1', kind: 'body' },
      ])
    })

    // The disagreement test the class issue (#1362) asks every guard in this
    // shape to carry: construct the state where the two documents differ,
    // and assert the guard returns what the authority (GitHub) returns.
    // GitHub honours the commit message, so a clean body must not save it.
    it('FAILS when the body says Refs but a commit message says Closes — the #1332 shape', () => {
      const result = assess({
        body: 'Refs #1331 — see explanation below, this needs a deploy to verify.',
        title: 'fix(ci): tighten workflow permissions',
        commits: [
          {
            messageHeadline: 'fix(ci): tighten workflow permissions',
            messageBody: 'Closes #1331\n\nRemoves the stale grant.',
          },
        ],
        changedFiles: ['.github/workflows/example.yml'],
      })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('deploy-only-path')
      expect(result.references).toEqual(['#1331'])
      // Names the commit specifically — "the body passed" is not enough
      // information to fix this, per the module docstring above.
      expect(result.hits.map((h: { source: string }) => h.source)).toEqual([
        'the commit message (body)',
      ])
      const message = formatFailure(result)
      expect(message).toContain('the commit message (body): #1331')
      expect(message).toContain('COMMIT message')
    })

    // The negative control #1362 requires alongside the disagreement test:
    // a check that can only ever fail can never go green, which is its own
    // defect. All three documents saying `Refs` must PASS.
    it('PASSES the negative control — Refs everywhere, on a deploy-only path', () => {
      const result = assess({
        body: 'Refs #1331',
        title: 'fix(ci): tighten workflow permissions',
        commits: [
          { messageHeadline: 'fix(ci): tighten workflow permissions', messageBody: 'Refs #1331' },
        ],
        changedFiles: ['.github/workflows/example.yml'],
      })
      expect(result.ok).toBe(true)
    })

    it('FAILS on a closing keyword in the commit HEADLINE, not just the body', () => {
      // The task's own note: a keyword can sit in either field.
      const result = assess({
        body: 'Refs #42',
        commits: [{ messageHeadline: 'fix(ci): closes #42', messageBody: '' }],
        changedFiles: ['infra/a.tf'],
      })
      expect(result.ok).toBe(false)
      expect(result.hits.map((h: { source: string }) => h.source)).toEqual([
        'the commit message (subject)',
      ])
    })

    it('FAILS on a closing keyword in the PR TITLE', () => {
      const result = assess({
        body: 'Refs #42',
        title: 'fix(ci): closes #42',
        changedFiles: ['infra/a.tf'],
      })
      expect(result.ok).toBe(false)
      expect(result.hits.map((h: { source: string }) => h.source)).toEqual(['the PR title'])
    })

    it('still PASSES a DELIBERATE commit closing keyword when nothing changed is deploy-only', () => {
      // The deploy-only-path check stays scoped by design — see the module
      // docstring's "why this guard fires on every path" note, which is
      // about the NEGATION check, not this one. A genuine, deliberate
      // closing trailer in a commit on an ordinary code change is fine, same
      // as it always was for the body.
      const result = assess({
        body: 'Refs #9',
        commits: [{ messageHeadline: 'fix: x', messageBody: 'Closes #9' }],
        changedFiles: ['cli/src/lib/a.ts'],
      })
      expect(result.ok).toBe(true)
    })

    // #1732: this is the corrected behaviour for the case the test above USED
    // TO cover before this fix — 'fix: closes #9' is a non-deliberate hit
    // (the keyword is not clause-initial), and until now that was considered
    // fine on any ordinary path with no way to reconcile it. That is exactly
    // the gap PR #1730 fell into for real: `closingIssuesReferences` can
    // never see a commit-only hit, so a hit that would previously have been
    // silently passed on an ordinary path must now be reconciled the same
    // way a body hit already is.
    it('FAILS a non-deliberate commit-message hit on an ORDINARY path too, once the fix lands (#1732)', () => {
      const result = assess({
        body: 'Refs #9',
        commits: [{ messageHeadline: 'fix: closes #9', messageBody: '' }],
        changedFiles: ['cli/src/lib/a.ts'],
      })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('commit-ground-truth-mismatch')
      expect(result.hits.map((h: { source: string }) => h.source)).toEqual([
        'the commit message (subject)',
      ])
    })

    // The real incident (#1732): PR #1730's own body quoted the historical
    // bug it was fixing — "the one-word fix #1664 asked for" — inside a
    // markdown code span, so GitHub's PR-body linker correctly ignored it
    // and closingIssuesReferences read [] (verified live via `gh pr view
    // 1730 --json body,closingIssuesReferences`). The identical phrase, with
    // NO code span, was already sitting in the branch's own commit message
    // (verified via `gh api repos/.../commits/a11a5b7e2647 --jq
    // .commit.message`) — a git commit message has no markdown semantics, so
    // a backtick there is a literal character, not protection — and it
    // closed #1664 one second after merge. `closingIssuesReferences` being
    // empty must NOT excuse a hit that lives only in a commit.
    it('FAILS the real PR #1730 shape: body-only backtick protection does not extend to the commit (#1732)', () => {
      const body = [
        'The deploy-only-path check silently passed a genuine closing-keyword hit',
        'whenever the changed paths were ordinary, with nothing checking whether',
        "GitHub's own `closingIssuesReferences` actually confirmed the close would",
        "happen. Real instance: merged PR #1680's body read (in context)",
        '`"the one-word fix #1664 asked for"` -- mid-sentence prose, not a deliberate',
        '`Closes #N` trailer -- alongside its own explicit `Refs #1664` elsewhere.',
      ].join('\n')
      // Real squash commit text (a11a5b7e2647), trimmed to the load-bearing
      // paragraph — the backtick-free "fix #1664" is what actually closed it.
      const commitBody = [
        'Merged PR #1680\'s body read (in context) "the one-word fix #1664 asked',
        'for" -- mid-sentence prose, not a deliberate `Closes #N` trailer.',
      ].join('\n')
      const result = assess({
        body,
        commits: [
          {
            messageHeadline: 'fix(scripts): reconcile against ground truth',
            messageBody: commitBody,
          },
        ],
        changedFiles: ['scripts/check-closing-keywords.mjs'],
        closingIssuesReferences: [],
      })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('commit-ground-truth-mismatch')
    })

    it('a backtick-quoted closing keyword in a COMMIT is NOT protected the way it is in the PR body (#1732)', () => {
      // The mechanical half of #1732: a commit message has no markdown
      // semantics, so `stripCode` must not be applied to it the way it
      // correctly is to the PR body/title.
      const result = assess({
        body: 'Refs #99 only.',
        commits: [
          { messageHeadline: 'chore: tidy', messageBody: 'Quoting the pattern: `Closes #99`.' },
        ],
        changedFiles: ['cli/src/lib/a.ts'],
      })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('commit-ground-truth-mismatch')
    })

    it('a backtick-quoted closing keyword in the PR BODY stays protected — commits are the only document this changes', () => {
      const result = assess({
        body: 'Quoting the pattern: `Closes #99`.',
        commits: [{ messageHeadline: 'chore: tidy', messageBody: 'Refs #99 only.' }],
        changedFiles: ['cli/src/lib/a.ts'],
      })
      expect(result.ok).toBe(true)
    })

    it('a deliberate commit trailer for a deploy-only path is STILL caught by check 1, not this new check', () => {
      // Ordering matters: a hit on a deploy-only path must fail as
      // 'deploy-only-path' (with the existing Verified-on-deploy escape
      // hatch), never as 'commit-ground-truth-mismatch' — the new check only
      // ever fires from inside the "no deploy-only paths" pass branch.
      const result = assess({
        body: 'Refs #42',
        commits: [{ messageHeadline: 'fix: x', messageBody: 'Closes #42' }],
        changedFiles: ['infra/a.tf'],
      })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('deploy-only-path')
    })

    it('a Verified-on-deploy trailer in the body still excuses a commit-message closing keyword', () => {
      const body = ['Refs #1331', '', `${VERIFIED_TRAILER} deploy 30752514507, checked: 34`].join(
        '\n',
      )
      const result = assess({
        body,
        commits: [{ messageHeadline: 'fix: x', messageBody: 'Closes #1331' }],
        changedFiles: ['infra/a.tf'],
      })
      expect(result.ok).toBe(true)
    })

    it('FAILS a negated keyword found only in a commit message, on any path', () => {
      const result = assess({
        body: 'Refs #7',
        commits: [{ messageHeadline: 'fix: x', messageBody: 'This does not close #7, see #7' }],
        changedFiles: ['cli/src/lib/a.ts'],
      })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('negated-keyword')
      expect(result.negated[0].source).toBe('the commit message (body)')
    })
  })

  // Same live/local/fail-closed shape as `resolveBody` (#1174), applied to
  // the title — the second of the three documents (#1334).
  describe('resolveTitle', () => {
    it('uses PR_TITLE directly when set, and never calls the live fetch', async () => {
      const fetchLiveTitle = vi.fn()
      const title = await resolveTitle({
        env: { PR_TITLE: 'fix: x', GH_TOKEN: 'x', PR_NUMBER: '5', GH_REPO: 'a/b' },
        fetchLiveTitle,
      })
      expect(title).toBe('fix: x')
      expect(fetchLiveTitle).not.toHaveBeenCalled()
    })

    it('fetches live when PR_TITLE is absent and the CI trio is present', async () => {
      const fetchLiveTitle = vi.fn().mockResolvedValue('fix: closes #9')
      const title = await resolveTitle({
        env: { GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' },
        fetchLiveTitle,
      })
      expect(title).toBe('fix: closes #9')
      expect(fetchLiveTitle).toHaveBeenCalledWith({ GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' })
    })

    it('returns an empty title when neither PR_TITLE nor the CI trio is set', async () => {
      const fetchLiveTitle = vi.fn()
      expect(await resolveTitle({ env: {}, fetchLiveTitle })).toBe('')
      expect(fetchLiveTitle).not.toHaveBeenCalled()
    })

    it('FAILS CLOSED when the live fetch throws', async () => {
      const fetchLiveTitle = vi.fn().mockRejectedValue(new Error('HTTP 403'))
      await expect(
        resolveTitle({ env: { GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' }, fetchLiveTitle }),
      ).rejects.toThrow(/could not fetch.*title.*#9.*a\/b.*403/s)
    })

    it('FAILS CLOSED on a half-configured CI trio', async () => {
      const fetchLiveTitle = vi.fn()
      await expect(
        resolveTitle({ env: { GH_TOKEN: 'x', PR_NUMBER: '9' }, fetchLiveTitle }),
      ).rejects.toThrow(/GH_TOKEN, PR_NUMBER and GH_REPO must all be set together/)
      expect(fetchLiveTitle).not.toHaveBeenCalled()
    })
  })

  // Same shape again, for commit messages — the actual subject of #1334.
  describe('resolveCommits', () => {
    it('parses PR_COMMITS directly when set, and never calls the live fetch', async () => {
      const fetchLiveCommits = vi.fn()
      const commits = await resolveCommits({
        env: {
          PR_COMMITS: JSON.stringify([{ messageHeadline: 'fix: x', messageBody: 'Closes #1' }]),
          GH_TOKEN: 'x',
          PR_NUMBER: '5',
          GH_REPO: 'a/b',
        },
        fetchLiveCommits,
      })
      expect(commits).toEqual([{ messageHeadline: 'fix: x', messageBody: 'Closes #1' }])
      expect(fetchLiveCommits).not.toHaveBeenCalled()
    })

    it('treats a deliberately empty PR_COMMITS as no commits, not as "fetch instead"', async () => {
      const fetchLiveCommits = vi.fn()
      expect(await resolveCommits({ env: { PR_COMMITS: '' }, fetchLiveCommits })).toEqual([])
      expect(fetchLiveCommits).not.toHaveBeenCalled()
    })

    it('fetches live when PR_COMMITS is absent and the CI trio is present', async () => {
      const fetchLiveCommits = vi
        .fn()
        .mockResolvedValue([{ messageHeadline: 'fix: x', messageBody: 'Closes #9' }])
      const commits = await resolveCommits({
        env: { GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' },
        fetchLiveCommits,
      })
      expect(commits).toEqual([{ messageHeadline: 'fix: x', messageBody: 'Closes #9' }])
      expect(fetchLiveCommits).toHaveBeenCalledWith({
        GH_TOKEN: 'x',
        PR_NUMBER: '9',
        GH_REPO: 'a/b',
      })
    })

    it('returns no commits when neither PR_COMMITS nor the CI trio is set', async () => {
      const fetchLiveCommits = vi.fn()
      expect(await resolveCommits({ env: {}, fetchLiveCommits })).toEqual([])
      expect(fetchLiveCommits).not.toHaveBeenCalled()
    })

    it('FAILS CLOSED when the live fetch throws, rather than treating it as no commits', async () => {
      const fetchLiveCommits = vi.fn().mockRejectedValue(new Error('HTTP 403'))
      await expect(
        resolveCommits({
          env: { GH_TOKEN: 'x', PR_NUMBER: '9', GH_REPO: 'a/b' },
          fetchLiveCommits,
        }),
      ).rejects.toThrow(/could not fetch.*commits.*#9.*a\/b.*403/s)
    })

    it('FAILS CLOSED on a half-configured CI trio rather than silently falling back to empty', async () => {
      const fetchLiveCommits = vi.fn()
      await expect(
        resolveCommits({ env: { GH_TOKEN: 'x', PR_NUMBER: '9' }, fetchLiveCommits }),
      ).rejects.toThrow(/GH_TOKEN, PR_NUMBER and GH_REPO must all be set together/)
      expect(fetchLiveCommits).not.toHaveBeenCalled()
    })
  })

  // Both live-fetchers shell out via execFileSync — a smoke test that they
  // build the right `gh` invocation, mirroring the (absent) equivalent for
  // fetchPrBodyViaGh: these are new in #1334, so cover the command shape
  // directly rather than only through the injected-fake tests above.
  describe('fetchPrTitleViaGh and fetchPrCommitsViaGh', () => {
    it('are exported functions — the live path exists, not only the injectable fake', () => {
      expect(typeof fetchPrTitleViaGh).toBe('function')
      expect(typeof fetchPrCommitsViaGh).toBe('function')
    })
  })

  // Unlike the pair above, this one is actually EXERCISED — the gap that let
  // tabsii-crm#379 through. `fetchPrClosingIssuesReferencesViaGh` originally
  // shelled out to `gh pr view --json closingIssuesReferences`, which is
  // only as reliable as the installed `gh` binary's own hardcoded --json
  // field allowlist. Two identical CI runs on tabsii-crm#379 (same commit,
  // 03:10:33Z and 03:16:37Z) both failed with `Unknown JSON field:
  // "closingIssuesReferences"` — tabsii-crm's Release Guards runs on its own
  // self-hosted runner fleet (`vars.RUNNER_LABEL: tabsii`), whose `gh` predates
  // that field. This repo's own `gh` (2.96.0) lists the field and every prior
  // test here only ever checked `typeof fn === 'function'`, so the command
  // shape had literally never run against a mocked (or real) `gh` before —
  // an untested branch that turned out to be a guess about the CLI surface.
  //
  // The fix moves to `gh api graphql`, which has no version-dependent field
  // allowlist of its own: it forwards the query text verbatim to GitHub's
  // GraphQL schema. These tests exercise the actual invocation and the
  // actual parse, with a captured-live fixture rather than an invented one.
  describe('fetchPrClosingIssuesReferencesViaGh', () => {
    it('is an exported function — the live path exists, not only the injectable fake', () => {
      expect(typeof fetchPrClosingIssuesReferencesViaGh).toBe('function')
    })

    it('calls `gh api graphql`, never `gh pr view --json closingIssuesReferences` (the shape a stale gh CLI rejects)', async () => {
      const mockExecFileSync = vi.mocked(execFileSync)
      // Real output: `gh api graphql -f query='...' -f owner=keiranholloway
      // -f repo=biffo-template -F num=1417 --jq
      // .data.repository.pullRequest.closingIssuesReferences.nodes`,
      // captured live against PR #1417 (which genuinely closes an issue).
      mockExecFileSync.mockReturnValueOnce(
        JSON.stringify([
          {
            id: 'I_kwDOTGuLIc8AAAABMDkoVw',
            number: 1411,
            url: 'https://github.com/keiranholloway/biffo-template/issues/1411',
            repository: { nameWithOwner: 'keiranholloway/biffo-template' },
          },
        ]),
      )

      const result = await fetchPrClosingIssuesReferencesViaGh({
        GH_TOKEN: 'gh-token-fixture',
        PR_NUMBER: '1417',
        GH_REPO: 'keiranholloway/biffo-template',
      })

      expect(result).toEqual([
        {
          id: 'I_kwDOTGuLIc8AAAABMDkoVw',
          number: 1411,
          url: 'https://github.com/keiranholloway/biffo-template/issues/1411',
          repository: { nameWithOwner: 'keiranholloway/biffo-template' },
        },
      ])

      expect(mockExecFileSync).toHaveBeenCalledTimes(1)
      const [command, args] = mockExecFileSync.mock.calls[0]
      expect(command).toBe('gh')
      expect(args).toContain('api')
      expect(args).toContain('graphql')
      // The exact failure this replaces — never reach for the version-gated
      // shorthand again.
      expect(args).not.toContain('pr')
      expect(args).not.toContain('closingIssuesReferences')
      expect(args.join(' ')).toContain('owner=keiranholloway')
      expect(args.join(' ')).toContain('repo=biffo-template')
      expect(args.join(' ')).toContain('num=1417')
      expect(args.join(' ')).toContain('closingIssuesReferences')
    })

    it('returns [] on empty output, same contract as the other live fetchers', async () => {
      vi.mocked(execFileSync).mockReturnValueOnce('')
      const result = await fetchPrClosingIssuesReferencesViaGh({
        GH_TOKEN: 'gh-token-fixture',
        PR_NUMBER: '1',
        GH_REPO: 'o/r',
      })
      expect(result).toEqual([])
    })
  })
})
