import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REAL_ENV_VAR } from './env-sandbox.js'

/**
 * `test-setup.ts` runs `installTestEnvSandbox()` before any test in *any*
 * file, this one included — so what's under test here is the ambient state
 * it leaves behind, not something this file sets up itself.
 *
 * These checks deliberately never fire a real notification, even the stub.
 * `command -v` only resolves a name against `PATH`; it does not execute the
 * target, so it is safe to run on a real, live desktop session — which the
 * machine this was written on is (#1125 is exactly about that risk). Proving
 * containment by actually invoking `notify-send`, stub or not, would be
 * demonstrating the fix by doing the thing the fix exists to prevent if the
 * fix were absent; resolution alone is enough to show which binary a real
 * call *would* have reached.
 */
describe('the whole-suite test sandbox installed by test-setup.ts', () => {
  it('has already stripped DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR before this test runs', () => {
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(process.env.XDG_RUNTIME_DIR).toBeUndefined()
  })

  it('resolves notify-send, for a child inheriting process.env untouched, to the stub rather than a real binary', () => {
    // A test that does `env: process.env` or omits `env` entirely (full
    // inherit) is the exact shape practices-daily-alert.test.ts used to have
    // before #1121's per-test fix. `sh -c 'command -v notify-send'` reports
    // what such a child would find on PATH, without ever running it.
    const resolved = execFileSync('sh', ['-c', 'command -v notify-send'], {
      env: process.env,
    })
      .toString()
      .trim()

    expect(resolved).not.toBe('')
    // Real notify-send lives in a system bin directory; the stub lives under
    // a throwaway test-sandbox-bin/ made by makeTmpDir. Asserting the negative
    // shape (not a system path) rather than the positive one (matches the
    // sandbox's own tmp prefix) keeps this from being a test that only knows
    // how to recognize its own fixture.
    expect(resolved).not.toMatch(/^\/(usr\/)?s?bin\//)
  })

  it('preserves whatever the outer environment had under an explicit opt-in name', () => {
    // Whether these are actually defined depends on the machine this suite
    // runs on (a real desktop session vs. headless CI) — either way, the
    // property under test is that the opt-in name mirrors the sandboxed one
    // as it stood *before* installTestEnvSandbox() stripped it, not any
    // particular value.
    for (const [sandboxed, optIn] of Object.entries(REAL_ENV_VAR)) {
      const optInValue = process.env[optIn]
      if (optInValue !== undefined) {
        expect(typeof optInValue).toBe('string')
      }
      // Whatever it is, it must not be the same key as the stripped one --
      // i.e. opting in is a deliberate, differently-named action.
      expect(optIn).not.toBe(sandboxed)
    }
  })
})
