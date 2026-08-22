import { describe, expect, it } from 'vitest'
import { execa, execTimeoutMs } from './exec.js'

// EVERY SUBPROCESS THIS CLI RUNS MUST BE ABLE TO END.
//
// `biffo core upgrade --apply` sat for 29 HOURS on `pnpm install` waiting to read a stdin
// nothing would ever write to (#1693). That call site was fixed directly; this module
// exists because it was one of SEVENTY, 62 of which spawn `git` -- which prompts for a
// username on an HTTPS fetch with no credential helper and then waits for an answer a
// headless run cannot give.
//
// Behavioural, not structural: the property is "a child that reads stdin still exits",
// which a grep for `stdin: 'ignore'` cannot demonstrate.
describe('every subprocess is bounded and cannot wait on stdin', () => {
  it('lets a stdin-reading child exit instead of hanging', async () => {
    const started = Date.now()
    const result = await execa('sh', ['-c', 'read x; echo "got:[$x]"'])
    // Under execa's default piped stdin this blocks until killed: measured at 29 hours in
    // production and reproduced as an indefinite hang before the fix.
    expect(result.stdout).toBe('got:[]')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('still lets a caller feed the child, which a bound stdin would have broken', async () => {
    // execa rejects `input` together with `stdin: 'ignore'` ("The `stdin` option must not
    // include `ignore`"), which is why the default is merged conditionally rather than
    // bound onto a preconfigured execa instance. Measured, then designed around.
    const result = await execa('cat', [], { input: 'fed\n' })
    expect(result.stdout).toBe('fed')
  })

  it('defaults to a finite timeout and lets an operator raise it', () => {
    const original = process.env.BIFFO_EXEC_TIMEOUT_MS
    try {
      delete process.env.BIFFO_EXEC_TIMEOUT_MS
      expect(execTimeoutMs()).toBe(900_000)
      process.env.BIFFO_EXEC_TIMEOUT_MS = '1200000'
      expect(execTimeoutMs()).toBe(1_200_000)
    } finally {
      if (original === undefined) delete process.env.BIFFO_EXEC_TIMEOUT_MS
      else process.env.BIFFO_EXEC_TIMEOUT_MS = original
    }
  })

  // A bound that can be set to "forever" is not a bound, and that is the exact failure.
  it.each([['0'], ['-5'], ['nonsense'], ['']])('stays finite for BIFFO_EXEC_TIMEOUT_MS=%j', (v) => {
    const original = process.env.BIFFO_EXEC_TIMEOUT_MS
    try {
      process.env.BIFFO_EXEC_TIMEOUT_MS = v
      const ms = execTimeoutMs()
      expect(Number.isFinite(ms)).toBe(true)
      expect(ms).toBeGreaterThan(0)
    } finally {
      if (original === undefined) delete process.env.BIFFO_EXEC_TIMEOUT_MS
      else process.env.BIFFO_EXEC_TIMEOUT_MS = original
    }
  })

  // THE SWEEP MUST STAY SWEPT. A new file importing execa directly reopens the class for
  // its own call sites, silently -- which is how 69 of the original 70 were missed.
  it('is the only non-test module that may import execa directly', async () => {
    const { execa: realExeca } = await import('execa')
    expect(typeof realExeca).toBe('function')
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders: string[] = []
    // `withFileTypes` rather than a separate statSync: checking a path and then reading it
    // is a TOCTOU that CodeQL flags as js/file-system-race, and the directory entry already
    // carries the answer. Reading is wrapped because a file can still vanish between the
    // listing and the read -- a walker that throws on that is a guard that fails to run.
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(p)
          continue
        }
        if (!entry.isFile()) continue
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue
        if (p.endsWith(join('lib', 'exec.ts'))) continue
        let source = ''
        try {
          source = readFileSync(p, 'utf8')
        } catch {
          continue
        }
        if (/from 'execa'/.test(source)) offenders.push(p)
      }
    }
    walk(new URL('..', import.meta.url).pathname)
    expect(offenders).toEqual([])
  })
})
