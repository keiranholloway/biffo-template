/**
 * The evidence corpus read/write helpers (#1132).
 *
 * `docs/practices/evidence.jsonl` used to be a single file every concurrent
 * session appended to — a conflict by construction. The fix is one file per
 * entry under `docs/practices/evidence/`; these tests pin the properties that
 * make the migration safe: the legacy file is read but never split, ordering
 * is deterministic rather than relying on directory listing order, and the
 * write path never touches the frozen legacy file.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
// @ts-expect-error -- plain .mjs, runs on bare node like every other script in scripts/.
import {
  corpusDirFor,
  listEvidenceFiles,
  readCorpus,
  readCorpusStrict,
  readEvidenceDir,
  readEvidenceDirEntries,
  readLegacyEvidence,
  slugify,
  writeEvidenceEntry,
  writeEvidenceFile,
} from '../../../scripts/practices-corpus.mjs'

const dirs: string[] = []

function tempRoot(): string {
  const dir = makeTmpDir('biffo-evidence')
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('corpusDirFor', () => {
  it('derives the sibling directory from the legacy .jsonl path', () => {
    expect(corpusDirFor('docs/practices/evidence.jsonl')).toBe('docs/practices/evidence')
  })
})

describe('readLegacyEvidence', () => {
  it('parses one JSON record per non-blank line', () => {
    const root = tempRoot()
    const file = join(root, 'evidence.jsonl')
    writeFileSync(file, '{"summary":"a"}\n{"summary":"b"}\n\n')
    expect(readLegacyEvidence(file)).toEqual([{ summary: 'a' }, { summary: 'b' }])
  })

  it('returns an empty array when the file does not exist', () => {
    expect(readLegacyEvidence('/nonexistent/evidence.jsonl')).toEqual([])
  })

  it('drops a malformed line rather than throwing — a scan for ranking, not a strict audit', () => {
    const root = tempRoot()
    const file = join(root, 'evidence.jsonl')
    writeFileSync(file, '{"summary":"a"}\nnot json\n{"summary":"b"}\n')
    expect(readLegacyEvidence(file)).toEqual([{ summary: 'a' }, { summary: 'b' }])
  })
})

describe('readEvidenceDir / readEvidenceDirEntries / listEvidenceFiles', () => {
  it('returns nothing for a directory that does not exist yet', () => {
    expect(readEvidenceDir('/nonexistent/evidence')).toEqual([])
    expect(listEvidenceFiles('/nonexistent/evidence')).toEqual([])
  })

  it('sorts by filename — the date-prefixed name is the ordering, not directory order', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    // Written out of order on purpose: the filesystem does not promise to
    // hand these back in creation order, so if the reader relied on that
    // this test would still pass by accident on most platforms.
    writeFileSync(join(dir, '2026-08-03-c.json'), JSON.stringify({ summary: 'c' }))
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'a' }))
    writeFileSync(join(dir, '2026-08-02-b.json'), JSON.stringify({ summary: 'b' }))
    expect(readEvidenceDir(dir).map((r: { summary: string }) => r.summary)).toEqual(['a', 'b', 'c'])
  })

  it('ignores non-json files sitting in the directory', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'a' }))
    writeFileSync(join(dir, 'README.md'), '# not an entry')
    expect(listEvidenceFiles(dir)).toEqual(['2026-08-01-a.json'])
  })

  it('drops a file that fails to parse rather than throwing', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'a' }))
    writeFileSync(join(dir, '2026-08-02-broken.json'), 'not json')
    expect(readEvidenceDir(dir).map((r: { summary: string }) => r.summary)).toEqual(['a'])
  })

  it('readEvidenceDirEntries carries the filename alongside the row, for a targeted rewrite', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'a' }))
    expect(readEvidenceDirEntries(dir)).toEqual([
      { file: '2026-08-01-a.json', row: { summary: 'a' } },
    ])
  })
})

describe('readCorpus — legacy rows first, directory rows sorted, nothing re-serialised', () => {
  it('concatenates legacy (existing order) with the directory (sorted)', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl')
    const dir = join(root, 'evidence')
    writeFileSync(legacy, '{"summary":"legacy-1"}\n{"summary":"legacy-2"}\n')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-03-new-b.json'), JSON.stringify({ summary: 'new-b' }))
    writeFileSync(join(dir, '2026-08-01-new-a.json'), JSON.stringify({ summary: 'new-a' }))

    expect(readCorpus(legacy).map((r: { summary: string }) => r.summary)).toEqual([
      'legacy-1',
      'legacy-2',
      'new-a',
      'new-b',
    ])
  })

  it('reads the legacy file alone when there is no directory yet', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl')
    writeFileSync(legacy, '{"summary":"only"}\n')
    expect(readCorpus(legacy)).toEqual([{ summary: 'only' }])
  })

  it('reads the directory alone when there is no legacy file', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl') // never created
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'a' }))
    expect(readCorpus(legacy)).toEqual([{ summary: 'a' }])
  })

  it('is deterministic across repeated reads regardless of write order', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl')
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    for (const name of ['2026-08-05-e', '2026-08-01-a', '2026-08-03-c', '2026-08-02-b']) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify({ summary: name }))
    }
    const first = readCorpus(legacy).map((r: { summary: string }) => r.summary)
    const second = readCorpus(legacy).map((r: { summary: string }) => r.summary)
    expect(first).toEqual(second)
    expect(first).toEqual(['2026-08-01-a', '2026-08-02-b', '2026-08-03-c', '2026-08-05-e'])
  })
})

describe('readCorpusStrict', () => {
  it('throws when neither the legacy file nor the directory exists', () => {
    expect(() => readCorpusStrict('/nonexistent/evidence.jsonl')).toThrow()
  })

  it('throws on a legacy line that does not parse, rather than silently dropping it', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl')
    writeFileSync(legacy, 'not json at all\n')
    expect(() => readCorpusStrict(legacy)).toThrow()
  })

  it('throws on a directory file that does not parse', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl')
    writeFileSync(legacy, '{"summary":"ok"}\n')
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-broken.json'), 'not json')
    expect(() => readCorpusStrict(legacy)).toThrow()
  })

  it('succeeds and merges when both parse cleanly', () => {
    const root = tempRoot()
    const legacy = join(root, 'evidence.jsonl')
    writeFileSync(legacy, '{"summary":"legacy"}\n')
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'new' }))
    expect(readCorpusStrict(legacy).map((r: { summary: string }) => r.summary)).toEqual([
      'legacy',
      'new',
    ])
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Metric Denominator Blindness!')).toBe('metric-denominator-blindness')
  })

  it('strips leading/trailing punctuation', () => {
    expect(slugify('--already hyphenated--')).toBe('already-hyphenated')
  })
})

describe('writeEvidenceEntry — the write path future sessions use', () => {
  it('writes one new file, never touching any other path', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    const path = writeEvidenceEntry(
      { summary: 'a metric with no denominator', class: 'visibility' },
      { dir, date: '2026-08-03' },
    )
    expect(path).toBe(join(dir, '2026-08-03-a-metric-with-no-denominator.json'))
    expect(readEvidenceDir(dir)).toEqual([
      { summary: 'a metric with no denominator', class: 'visibility', date: '2026-08-03' },
    ])
  })

  it('creates the directory if it does not exist yet', () => {
    const root = tempRoot()
    const dir = join(root, 'brand-new-evidence-dir')
    writeEvidenceEntry({ summary: 'first ever entry' }, { dir, date: '2026-08-03' })
    expect(readEvidenceDir(dir)).toHaveLength(1)
  })

  it('refuses to overwrite an existing entry — a collision needs a more specific slug', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    writeEvidenceEntry({ summary: 'same summary' }, { dir, date: '2026-08-03' })
    expect(() =>
      writeEvidenceEntry({ summary: 'same summary' }, { dir, date: '2026-08-03' }),
    ).toThrow()
  })

  it('two sessions writing on the same day never collide when their summaries differ', () => {
    // The whole point of #1132: N writers, one directory, disjoint paths.
    const root = tempRoot()
    const dir = join(root, 'evidence')
    writeEvidenceEntry({ summary: 'session one finding' }, { dir, date: '2026-08-03' })
    writeEvidenceEntry({ summary: 'session two finding' }, { dir, date: '2026-08-03' })
    expect(listEvidenceFiles(dir)).toHaveLength(2)
  })
})

describe('writeEvidenceFile — rewriting one already-existing entry (e.g. --enrich)', () => {
  it('overwrites only the named file, leaving siblings untouched', () => {
    const root = tempRoot()
    const dir = join(root, 'evidence')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-08-01-a.json'), JSON.stringify({ summary: 'a', date: null }))
    writeFileSync(join(dir, '2026-08-02-b.json'), JSON.stringify({ summary: 'b', date: null }))
    writeEvidenceFile(dir, '2026-08-01-a.json', { summary: 'a', date: '2026-08-01' })
    const entries = readEvidenceDirEntries(dir)
    expect(entries.find((e: { file: string }) => e.file === '2026-08-01-a.json').row.date).toBe(
      '2026-08-01',
    )
    expect(entries.find((e: { file: string }) => e.file === '2026-08-02-b.json').row.date).toBe(
      null,
    )
  })
})
