import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedOutput } from '../test-utils/console.js'
import { type CoreDiffJson, runCoreDiff } from './core-diff.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { log } from '../lib/logger.js'

// Only services/api/ is compared here; the core.version / core-manifest.json
// markers written into the template root are intentionally not template-owned
// in this fixture so they don't show up as diff noise.
const MANIFEST = {
  version: 1,
  templateOwned: ['services/api/'],
  userOwned: ['services/'],
}

describe('runCoreDiff', () => {
  let template: string
  let instance: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    template = mkdtempSync(join(tmpdir(), 'biffo-tmpl-'))
    instance = mkdtempSync(join(tmpdir(), 'biffo-inst-'))
    // minimal template root markers
    writeFileSync(join(template, 'core.version'), '0.2.0\n')
    writeFileSync(join(template, 'core-manifest.json'), JSON.stringify(MANIFEST))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })
  afterEach(() => {
    rmSync(template, { recursive: true, force: true })
    rmSync(instance, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function write(root: string, rel: string, content: string): void {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  // `runCoreDiff` formats its summary with chalk, which emits ANSI escapes when
  // stdout is a TTY and nothing when it is not. Strip them here so every
  // assertion below is about content, not presentation — otherwise a literal
  // like '3 template-owned file(s) would change' passes in CI and fails on a
  // developer's machine, where chalk.bold wraps the count.
  function output(): string {
    return capturedOutput(logSpy)
  }

  it('reports no changes when instance matches the template', async () => {
    write(instance, 'services/api/main.py', 'same')
    write(template, 'services/api/main.py', 'same')
    await runCoreDiff({ cwd: instance, templateRoot: template })
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('No template-owned changes'))
  })

  it('lists modified / added / removed template-owned files and ignores user-owned', async () => {
    write(template, 'services/api/main.py', 'v2')
    write(instance, 'services/api/main.py', 'v1') // modified
    write(template, 'services/api/added.py', 'x') // added
    write(instance, 'services/api/removed.py', 'y') // instance-only, not a removal (#689)
    write(template, 'services/acme-crm/p.json', 'a') // user-owned, ignored
    write(instance, 'services/acme-crm/p.json', 'b')

    await runCoreDiff({ cwd: instance, templateRoot: template })

    const out = output()
    expect(out).toContain('services/api/main.py')
    expect(out).toContain('services/api/added.py')
    expect(out).toContain('services/api/removed.py')
    expect(out).not.toContain('services/acme-crm/p.json')
    // Instance-only files are listed but NOT counted as pending changes (#689).
    expect(out).toContain('2 template-owned file(s) would change')
    expect(out).toContain('instance-only')
    expect(out).toContain('An upgrade leaves these alone')
    // read-only preview mentions Phase 3
    expect(out).toContain('biffo core upgrade')
  })

  it('shows the instance and template core versions', async () => {
    writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
    write(template, 'services/api/main.py', 'v2')
    write(instance, 'services/api/main.py', 'v1')
    await runCoreDiff({ cwd: instance, templateRoot: template })
    const out = output()
    expect(out).toContain('0.1.0')
    expect(out).toContain('0.2.0')
  })

  // #696 — the prose report was the only output, so consumers hand-parsed it and
  // could silently under-report. These assert the parse is unnecessary.
  describe('--json', () => {
    /** Parse stdout as a whole. Throws if anything non-JSON was printed, which
     * is the property under test — a banner or a success line makes the whole
     * document unparseable, and that is exactly how a consumer would break. */
    function json(): CoreDiffJson {
      return JSON.parse(output()) as CoreDiffJson
    }

    it('classifies each bucket, keeping instance-only distinct from removed', async () => {
      writeFileSync(join(instance, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
      write(template, 'services/api/main.py', 'v2')
      write(instance, 'services/api/main.py', 'v1') // modified
      write(template, 'services/api/added.py', 'x') // added
      write(instance, 'services/api/local.py', 'y') // instance-only, NOT removed (#689)
      write(template, 'services/api/same.py', 'z') // unchanged
      write(instance, 'services/api/same.py', 'z')
      write(template, 'services/acme-crm/p.json', 'a') // user-owned, ignored
      write(instance, 'services/acme-crm/p.json', 'b')

      await runCoreDiff({ cwd: instance, templateRoot: template, json: true })

      expect(json()).toEqual({
        schemaVersion: 1,
        instanceCore: '0.1.0',
        templateCore: '0.2.0',
        modified: ['services/api/main.py'],
        added: ['services/api/added.py'],
        removed: [],
        instanceOnly: ['services/api/local.py'],
        unchanged: 1,
      })
    })

    it('emits only the JSON document — no banner, no prose, nothing to strip', async () => {
      write(template, 'services/api/main.py', 'v2')
      write(instance, 'services/api/main.py', 'v1')

      await runCoreDiff({ cwd: instance, templateRoot: template, json: true })

      // Exactly one console.log call, and it parses whole. The regression this
      // guards is a later edit printing a header before the payload: the human
      // report still looks right, and every consumer breaks at once.
      expect(logSpy.mock.calls).toHaveLength(1)
      expect(() => json()).not.toThrow()
      expect(output()).not.toContain('Biffo core diff')
      expect(output()).not.toContain('would change')
    })

    it('stays parseable when there are no changes at all', async () => {
      // The prose path returns early through log.success here. That line goes to
      // stdout, so a JSON caller would get `✔ No template-owned changes…` ahead
      // of its document — the empty case is the one most likely to be mishandled
      // and the one a consumer is least likely to test.
      write(template, 'services/api/main.py', 'same')
      write(instance, 'services/api/main.py', 'same')

      await runCoreDiff({ cwd: instance, templateRoot: template, json: true })

      expect(log.success).not.toHaveBeenCalled()
      expect(json()).toMatchObject({ modified: [], added: [], removed: [], unchanged: 1 })
    })

    it('reports instanceCore as null when the instance records no version', async () => {
      // Distinguishable from a version string, unlike the prose "(unrecorded)".
      write(template, 'services/api/main.py', 'v2')
      write(instance, 'services/api/main.py', 'v1')

      await runCoreDiff({ cwd: instance, templateRoot: template, json: true })

      expect(json().instanceCore).toBeNull()
    })
  })
})
