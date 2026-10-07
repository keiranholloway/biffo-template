import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkCoreStaleness,
  coreStalenessBody,
  coreStalenessTitle,
  fileCoreStalenessIssue,
} from './core-staleness.js'
import { makeTmpDir } from '../test-utils/tmp.js'

// Data captured 2026-10-07: tabsii-platform `dev` (583c9bad) pinned 0.371.0.
const minors = (to: number): string[] => {
  const tags = ['core-v0.365.0', 'core-v0.365.1', 'not-a-tag']
  for (let m = 366; m <= to; m++) tags.push(`core-v0.${m}.0`)
  return tags
}
const TAGS_1021 = minors(384)
const TAGS_BEFORE_2426 = minors(383)

const subjects = (from: string, to: string): string[] => {
  expect(from).toBe('core-v0.371.0')
  return to === 'core-v0.384.0'
    ? ['feat: pre-push lane (#2426)', 'fix: x (#2400)']
    : ['fix: x (#2400)']
}

const dirs: string[] = []
function instance(content?: string): string {
  const d = makeTmpDir('stale')
  dirs.push(d)
  mkdirSync(d, { recursive: true })
  if (content !== undefined) writeFileSync(join(d, 'biffo.core.json'), content)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('checkCoreStaleness', () => {
  it('tabsii-platform at 10:21 UTC: behind by 13, carries 2426', () => {
    const [f, ...rest] = checkCoreStaleness(instance('{"version":"0.371.0"}'), {
      tags: TAGS_1021,
      subjectsBetween: subjects,
    })
    expect(rest).toEqual([])
    expect(f).toMatchObject({ status: 'behind', behindBy: 13, newestTag: 'core-v0.384.0' })
    expect(f?.carriedPrs).toContain(2426)
  })

  it('with the tag list cut at 0.383.0 names that tag and omits 2426', () => {
    const [f] = checkCoreStaleness(instance('{"version":"0.371.0"}'), {
      tags: TAGS_BEFORE_2426,
      subjectsBetween: subjects,
    })
    expect(f?.newestTag).toBe('core-v0.383.0')
    expect(f?.carriedPrs).not.toContain(2426)
  })

  it('biffo-platform at 0.365.0 returns one finding', () => {
    const r = checkCoreStaleness(instance('{"version":"0.365.0"}'), { tags: TAGS_1021 })
    expect(r).toHaveLength(1)
    expect(r[0]?.status).toBe('behind')
  })

  it('current pin: no finding', () => {
    expect(checkCoreStaleness(instance('{"version":"0.384.0"}'), { tags: TAGS_1021 })).toEqual([])
  })

  it('no biffo.core.json: not an instance, no finding', () => {
    expect(checkCoreStaleness(instance(), { tags: TAGS_1021 })).toEqual([])
  })

  it('unparseable version is cannot-tell, never current', () => {
    const r = checkCoreStaleness(instance('{"version":"x"}'), { tags: TAGS_1021 })
    expect(r).toHaveLength(1)
    expect(r[0]?.status).toBe('cannot-tell')
    expect(checkCoreStaleness(instance('not json'), { tags: TAGS_1021 })[0]?.status).toBe(
      'cannot-tell',
    )
  })

  it('no core tags at all is cannot-tell', () => {
    expect(checkCoreStaleness(instance('{"version":"0.1.0"}'), { tags: [] })[0]?.status).toBe(
      'cannot-tell',
    )
  })
})

describe('core staleness issue filing', () => {
  const finding = (pin: string) =>
    checkCoreStaleness(instance(`{"version":"${pin}"}`), {
      tags: TAGS_1021,
      subjectsBetween: () => ['a (#1)'],
    })[0]!

  it('title is stable across pins', () => {
    const t = (pin: string) => {
      const create = vi.fn().mockReturnValue('url')
      fileCoreStalenessIssue('tabsii-platform', 'tabsii-com/tabsii-platform', finding(pin), 'run', {
        listOpenTitles: () => [],
        create,
      })
      return create.mock.calls[0]?.[1]
    }
    expect(t('0.371.0')).toBe('core staleness: tabsii-platform is behind biffo-template')
    expect(t('0.371.0')).toBe(t('0.383.0'))
    expect(coreStalenessTitle('tabsii-platform')).toBe(t('0.383.0'))
  })

  it('an open issue with that title: no create, no comment', () => {
    const create = vi.fn()
    const comment = vi.fn()
    const gh = {
      listOpenTitles: () => ['core staleness: tabsii-platform is behind biffo-template'],
      create,
      comment,
    }
    const r = fileCoreStalenessIssue('tabsii-platform', 'o/r', finding('0.371.0'), 'run', gh)
    expect(r.action).toBe('exists')
    expect(create).not.toHaveBeenCalled()
    expect(comment).not.toHaveBeenCalled()
  })

  it('body carries pin, tag, PR count and the remedy', () => {
    const body = coreStalenessBody(finding('0.371.0'), 'RUN')
    expect(body).toContain('0.371.0')
    expect(body).toContain('core-v0.384.0')
    expect(body).toContain('carried by this upgrade: 1')
    expect(body).toContain('--apply --no-push')
    expect(body).toContain('Do not hand-merge template files')
  })
})
