import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from './tmp.js'

/**
 * `execFileSync`/`spawn` inherit `process.env` and `PATH` by default, so any
 * test in this suite that shells out — and much of it legitimately does, to
 * real `git`, `gh`, `node`, `sh`, `terraform`, `gitleaks` — can also reach the
 * developer's live D-Bus session, `~/.ssh`, the GNOME keyring, the network,
 * and the real `$HOME`, purely by not overriding an `env:` option (#1125).
 *
 * `practices-daily-alert.test.ts` blanked `DBUS_SESSION_BUS_ADDRESS` to
 * "simulate cron" and fired eight real `-u critical` desktop notifications
 * per `pnpm test`, for seven hours, in a suite that stayed green throughout —
 * a side effect on somebody's desktop is not an assertion, so nothing could
 * fail on it. #1121 fixed that one test by putting a stub `notify-send` first
 * on its own `PATH`. That is a convention each test author has to remember,
 * not a property of the harness, and nothing stops the next test doing the
 * same thing.
 *
 * This module is that harness property. `installTestEnvSandbox()` runs once
 * from `test-setup.ts`'s `setupFiles` — once per test *file*, since vitest's
 * default `isolate: true` forks a process per file, so "once per file" is
 * "once per process" from here. After it runs, reaching the real session is
 * opt-in rather than the default, for any test that does not deliberately
 * work around it.
 *
 * Two independent mitigations, because neither alone closes the hole:
 *
 * 1. **`DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` are stripped from
 *    `process.env`.** But `practices-daily.sh`'s `_notify` treats an *empty*
 *    `DBUS_SESSION_BUS_ADDRESS` as the cron case and reconstructs the address
 *    from the hardcoded path `/run/user/<uid>/bus` — it does not consult
 *    `XDG_RUNTIME_DIR` at all, so stripping that variable does not stop
 *    *this* script's reconstruction. (That hardcoded path is exactly what the
 *    freedesktop D-Bus spec's `unix:path=$XDG_RUNTIME_DIR/bus` fallback
 *    generalizes; stripping `XDG_RUNTIME_DIR` is what stops a *generic*
 *    D-Bus-aware tool — `dbus-send`, `gdbus`, anything linking libdbus —
 *    from finding the real bus the same way, even though it does not
 *    neutralize this specific script's hardcoded guess.)
 * 2. **A stub `notify-send` is installed in a throwaway directory prepended
 *    to `PATH`.** This is what actually contains `practices-daily.sh`: no
 *    matter what address `_notify` reconstructs, `command -v notify-send`
 *    resolves to the inert stub first, so the real binary is never invoked
 *    and the reconstructed address is never used to send anything. This is
 *    the fix that matters for the incident that opened #1125; the env
 *    stripping above is defense in depth for whatever the next test shells
 *    out to that is not this script.
 *
 * A test that genuinely needs the real environment can opt back in: the
 * original values (if the outer process had them) are preserved under
 * `REAL_ENV_VAR[<name>]` before being stripped, so a test can restore them
 * explicitly — `DBUS_SESSION_BUS_ADDRESS: process.env[REAL_ENV_VAR.DBUS_SESSION_BUS_ADDRESS]`
 * — rather than only being able to guess what the ambient value used to be.
 * Opt-in is the right default here: there is no legitimate reason for an
 * automated test to interrupt the operator's desktop or touch their session
 * bus, so a test that needs the real value should have to say so.
 */
export const REAL_ENV_VAR = {
  DBUS_SESSION_BUS_ADDRESS: 'BIFFO_TEST_REAL_DBUS_SESSION_BUS_ADDRESS',
  XDG_RUNTIME_DIR: 'BIFFO_TEST_REAL_XDG_RUNTIME_DIR',
} as const

const SANDBOXED_VARS = Object.keys(REAL_ENV_VAR) as Array<keyof typeof REAL_ENV_VAR>

/**
 * Binaries stubbed on the prepended `PATH`, by name, contents. Extend this
 * map — not a one-off per-test `PATH` trick — when a future spawn target
 * turns out to reach some other real desktop/session service the same way
 * `notify-send` did.
 */
const STUBBED_BINARIES: Record<string, string> = {
  'notify-send': '#!/bin/sh\nexit 0\n',
}

/** Installs the whole-suite test sandbox described above. Idempotent-ish in
 * practice because it runs once per forked test-file process, not because
 * calling it twice in the same process is safe (it is not: a second call
 * would stash the *already-stripped* env under `REAL_ENV_VAR`, losing the
 * original). */
export function installTestEnvSandbox(): void {
  for (const varName of SANDBOXED_VARS) {
    const real = process.env[varName]
    if (real !== undefined) {
      process.env[REAL_ENV_VAR[varName]] = real
    }
    delete process.env[varName]
  }

  const bin = makeTmpDir('test-sandbox-bin')
  for (const [name, contents] of Object.entries(STUBBED_BINARIES)) {
    writeFileSync(join(bin, name), contents, { mode: 0o755 })
  }
  process.env.PATH = `${bin}${process.env.PATH ? `:${process.env.PATH}` : ''}`
}
