import { describe, expect, it } from 'vitest'
import {
  type RegistrySource,
  type SourcesFile,
  addSource,
  manifestUrlFor,
  serialiseSources,
} from './registry-sources.js'

const existing: RegistrySource = {
  name: 'ideation',
  repo: 'https://github.com/keiranholloway/biffo-plugin-ideation',
  manifest:
    'https://raw.githubusercontent.com/keiranholloway/biffo-plugin-ideation/dev/biffo.plugin.json',
  tags: [],
}

const file = (): SourcesFile => ({ note: 'why this exists', sources: [existing] })

describe('manifestUrlFor', () => {
  it('builds the raw URL the registry sync fetches', () => {
    expect(manifestUrlFor('https://github.com/acme/biffo-plugin-crm')).toBe(
      'https://raw.githubusercontent.com/acme/biffo-plugin-crm/dev/biffo.plugin.json',
    )
  })

  it('strips a .git suffix, which createEmptyRepo returns on the clone URL', () => {
    // github's clone_url ends in .git; leaving it in produces a 404 that would
    // only surface a week later when the scheduled sync ran.
    expect(manifestUrlFor('https://github.com/acme/biffo-plugin-crm.git')).toBe(
      'https://raw.githubusercontent.com/acme/biffo-plugin-crm/dev/biffo.plugin.json',
    )
  })

  it('points at the integration branch, not the default of some other repo', () => {
    expect(manifestUrlFor('https://github.com/acme/x', 'main')).toContain('/main/')
  })
})

describe('addSource', () => {
  it('appends a new plugin', () => {
    const next = addSource(file(), { ...existing, name: 'crm' })
    expect(next?.sources.map((s) => s.name)).toEqual(['ideation', 'crm'])
  })

  it('returns null when the plugin is already registered', () => {
    // Re-running `plugin create` against an existing registration is not an
    // error, and must not produce an empty commit.
    expect(addSource(file(), existing)).toBeNull()
  })

  it('preserves the note and every other field', () => {
    const next = addSource(file(), { ...existing, name: 'crm' })
    expect(next?.note).toBe('why this exists')
    expect(next?.sources[0]).toEqual(existing)
  })

  it('does not mutate the file it was given', () => {
    const original = file()
    addSource(original, { ...existing, name: 'crm' })
    expect(original.sources).toHaveLength(1)
  })
})

describe('serialiseSources', () => {
  it('round-trips', () => {
    const next = addSource(file(), { ...existing, name: 'crm' })
    expect(JSON.parse(serialiseSources(next!))).toEqual(next)
  })

  it('ends with a newline, so the diff is one line not two', () => {
    expect(serialiseSources(file()).endsWith('}\n')).toBe(true)
  })
})
