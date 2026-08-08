import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain .mjs so it runs on bare node in CI with no install,
// like every other script in scripts/. Tested from here so the logic has one home.
import {
  assess,
  closingReferences,
  DEPLOY_ONLY_PREFIXES,
  deployOnlyPaths,
  documentsFor,
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

    it('keeps the list short on purpose', () => {
      // A guard that fires on everything teaches people to bypass it. If this
      // number climbs, argue for each addition with an incident.
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
        { source: 'the PR body', text: 'Refs #1' },
        { source: 'the PR title', text: 'fix(ci): tighten workflow permissions' },
        { source: 'the commit message (subject)', text: 'fix(ci): a' },
        { source: 'the commit message (body)', text: 'Closes #1' },
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
        { source: 'the PR body', text: 'Refs #1' },
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

    it('still PASSES a commit closing keyword when nothing changed is deploy-only', () => {
      // The deploy-only-path check stays scoped by design — see the module
      // docstring's "why this guard fires on every path" note, which is
      // about the NEGATION check, not this one. A closing keyword in a
      // commit on an ordinary code change is fine, same as it always was
      // for the body.
      const result = assess({
        body: 'Refs #9',
        commits: [{ messageHeadline: 'fix: closes #9', messageBody: '' }],
        changedFiles: ['cli/src/lib/a.ts'],
      })
      expect(result.ok).toBe(true)
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
})
