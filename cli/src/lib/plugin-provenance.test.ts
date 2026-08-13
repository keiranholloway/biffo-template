import { execa } from 'execa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import {
  PLUGIN_PROVENANCE_FILENAME,
  inTreePluginProvenance,
  readProvenance,
  reconcileProvenance,
  resolveLocalProvenance,
  resolveRegistryProvenance,
  writePluginProvenance,
} from './plugin-provenance.js'

async function initGitRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir })
}

describe('readProvenance', () => {
  it('reports absent when no provenance file exists — a plugin vendored before #1547', () => {
    const dir = makeTmpDir('plugin-dir')
    expect(readProvenance(dir)).toEqual({ status: 'absent' })
  })

  it('reports invalid, distinct from absent, for unparseable JSON', () => {
    const dir = makeTmpDir('plugin-dir')
    writeFileSync(join(dir, PLUGIN_PROVENANCE_FILENAME), '{ not json')
    const result = readProvenance(dir)
    expect(result.status).toBe('invalid')
  })

  it('reports invalid for well-formed JSON missing required fields', () => {
    const dir = makeTmpDir('plugin-dir')
    writeFileSync(join(dir, PLUGIN_PROVENANCE_FILENAME), JSON.stringify({ origin: 'x' }))
    const result = readProvenance(dir)
    expect(result.status).toBe('invalid')
  })

  it('round-trips a written record', () => {
    const dir = makeTmpDir('plugin-dir')
    const record = {
      origin: 'https://github.com/acme/widgets',
      ref: null,
      sha: 'a'.repeat(40),
      recordedAt: '2026-01-01T00:00:00.000Z',
      inTree: false,
    }
    writePluginProvenance(dir, record)
    const result = readProvenance(dir)
    expect(result).toEqual({ status: 'present', record })
  })
})

describe('inTreePluginProvenance', () => {
  it('never carries a SHA or ref — there is no external source to compare against', () => {
    const record = inTreePluginProvenance('services/widgets')
    expect(record).toMatchObject({ origin: 'services/widgets', ref: null, sha: null, inTree: true })
  })
})

describe('resolveRegistryProvenance', () => {
  it('is pure — takes the SHA as a parameter rather than resolving it, so it never touches the network', () => {
    const record = resolveRegistryProvenance('https://github.com/acme/widgets', 'a'.repeat(40))
    expect(record).toMatchObject({
      origin: 'https://github.com/acme/widgets',
      ref: null,
      sha: 'a'.repeat(40),
      inTree: false,
    })
  })

  it('honestly records an unknown SHA as null rather than fabricating one', () => {
    const record = resolveRegistryProvenance('https://github.com/acme/widgets', null)
    expect(record.sha).toBeNull()
  })
})

describe('resolveLocalProvenance', () => {
  it('handles a non-git --local source honestly: sha and ref come back null, not fabricated', async () => {
    const dir = makeTmpDir('plugin-source')
    writeFileSync(join(dir, 'biffo.plugin.json'), '{}')

    const record = await resolveLocalProvenance(dir, dir)

    expect(record.origin).toBe(dir)
    expect(record.sha).toBeNull()
    expect(record.ref).toBeNull()
    expect(record.inTree).toBe(false)
  })

  it('records a real SHA and branch for a git --local source', async () => {
    const dir = makeTmpDir('plugin-source')
    await initGitRepo(dir)
    writeFileSync(join(dir, 'biffo.plugin.json'), '{}')
    await execa('git', ['add', '-A'], { cwd: dir })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    const { stdout: expectedSha } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })

    const record = await resolveLocalProvenance(dir, dir)

    expect(record.sha).toBe(expectedSha.trim())
    expect(record.ref).not.toBeNull()
    expect(record.inTree).toBe(false)
  })
})

describe('reconcileProvenance', () => {
  it('returns the previous record unchanged when only recordedAt would differ', () => {
    const dir = makeTmpDir('plugin-dir')
    mkdirSync(dir, { recursive: true })
    const first = resolveRegistryProvenance('https://github.com/acme/widgets', 'a'.repeat(40))
    writePluginProvenance(dir, first)
    const onDiskAfterFirst = readFileSync(join(dir, PLUGIN_PROVENANCE_FILENAME), 'utf8')

    // A second call with the same origin/sha but a necessarily later
    // recordedAt (Date.now() has moved) must be a no-op on disk — this is
    // what keeps a byte-identical `plugin upgrade --local` refresh a genuine
    // no-op rather than a commit consisting only of a new timestamp.
    const previous = readProvenance(dir)
    const second = resolveRegistryProvenance('https://github.com/acme/widgets', 'a'.repeat(40))
    writePluginProvenance(dir, reconcileProvenance(previous, second))
    const onDiskAfterSecond = readFileSync(join(dir, PLUGIN_PROVENANCE_FILENAME), 'utf8')

    expect(onDiskAfterSecond).toBe(onDiskAfterFirst)
  })

  it('returns the next record when the SHA genuinely changed', () => {
    const dir = makeTmpDir('plugin-dir')
    mkdirSync(dir, { recursive: true })
    writePluginProvenance(
      dir,
      resolveRegistryProvenance('https://github.com/acme/widgets', 'a'.repeat(40)),
    )
    const previous = readProvenance(dir)
    const next = resolveRegistryProvenance('https://github.com/acme/widgets', 'b'.repeat(40))
    writePluginProvenance(dir, reconcileProvenance(previous, next))

    const result = readProvenance(dir)
    expect(result.status).toBe('present')
    expect(result.status === 'present' && result.record.sha).toBe('b'.repeat(40))
  })

  it('passes through the next record as-is when there is no previous one', () => {
    const dir = makeTmpDir('plugin-dir')
    mkdirSync(dir, { recursive: true })
    expect(existsSync(join(dir, PLUGIN_PROVENANCE_FILENAME))).toBe(false)

    const next = inTreePluginProvenance('services/widgets')
    writePluginProvenance(dir, reconcileProvenance(readProvenance(dir), next))

    expect(existsSync(join(dir, PLUGIN_PROVENANCE_FILENAME))).toBe(true)
    const result = readProvenance(dir)
    expect(result.status === 'present' && result.record).toEqual(next)
  })
})
