import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so it runs on bare node in CI with no install,
// like every other script in scripts/. Tested from here so the logic has one home.
import {
  assess,
  closingReferences,
  DEPLOY_ONLY_PREFIXES,
  deployOnlyPaths,
  formatFailure,
  hasVerifiedTrailer,
  VERIFIED_TRAILER,
} from '../../../scripts/check-closing-keywords.mjs'

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
})
