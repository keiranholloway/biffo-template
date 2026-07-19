import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedOutput } from '../test-utils/console.js'
import { runCoreDiff } from './core-diff.js'

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
    write(instance, 'services/api/removed.py', 'y') // removed
    write(template, 'services/acme-crm/p.json', 'a') // user-owned, ignored
    write(instance, 'services/acme-crm/p.json', 'b')

    await runCoreDiff({ cwd: instance, templateRoot: template })

    const out = output()
    expect(out).toContain('services/api/main.py')
    expect(out).toContain('services/api/added.py')
    expect(out).toContain('services/api/removed.py')
    expect(out).not.toContain('services/acme-crm/p.json')
    expect(out).toContain('3 template-owned file(s) would change')
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
})
