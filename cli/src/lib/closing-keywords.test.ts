import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain .mjs so it runs on bare node in CI with no install,
// like every other script in scripts/. Tested from here so the logic has one home.
import {
  assess,
  closingReferences,
  DEPLOY_ONLY_PREFIXES,
  deployOnlyPaths,
  formatFailure,
  hasVerifiedTrailer,
  negatedClosingReferences,
  resolveBody,
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
})
