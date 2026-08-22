import { execa as rawExeca, type Options, type ResultPromise } from 'execa'

/**
 * Every subprocess this CLI runs, with the two properties that stop it hanging forever.
 *
 * ## Why this exists
 *
 * `biffo core upgrade --apply` on tabsii-platform sat for TWENTY-NINE HOURS on
 * `pnpm install` having done nothing at all. Diagnosed from the live process:
 * `node_modules` untouched since two days earlier, git tree clean, no lock files, NO
 * network connections, main thread idle in `ep_poll`, nine libuv workers parked in
 * `futex_do_wait`, one tick of CPU across the whole 29 hours. It was waiting to read
 * stdin, and nothing was ever going to write to it (#1693).
 *
 * That call site is fixed. This module exists because it was one of SEVENTY, and the
 * other sixty-nine had the same shape: 62 spawn `git`, which prompts for a username on
 * an HTTPS fetch with no credential helper and then waits for an answer that a headless
 * run cannot give. The fix belongs in one place rather than sixty-nine.
 *
 * ## The two defaults
 *
 * **`stdin: 'ignore'`.** execa 9 gives the child a PIPE for stdin by default — verified
 * directly rather than read from docs: a child spawned that way reports `socket:[...]`
 * for fd0, not the parent's descriptor. This CLI usually runs headless with its own
 * stdin on /dev/null, so closing the child's turns a silent forever-wait into an
 * immediate, legible failure. Measured: a child running `read x` hung until killed under
 * the default, and exited in 8ms with stdin ignored.
 *
 * **A finite `timeout`.** Before this, 0 of 70 call sites passed one. The point is not
 * that 15 minutes is the correct duration for any particular command — it is that
 * "forever" is the wrong one for all of them. Any call site needing longer says so.
 *
 * ## What it deliberately does NOT do
 *
 * It does not override a caller. A call site that passes `stdin`, or passes `input` to
 * write to the child, keeps exactly what it asked for — execa rejects `input` and `stdin`
 * together, so defaulting one on top of the other would break the one call site that
 * feeds a child (`adapters/source-control/github/index.ts`).
 */
export const execTimeoutMs = (): number => {
  const raw = process.env.BIFFO_EXEC_TIMEOUT_MS
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  // An unusable override falls back to finite rather than to "wait forever". A bound that
  // can be set to infinity is not a bound, which is the whole failure being prevented.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900_000
}

// GENERIC IN THE OPTIONS, because execa infers the type of `stdout` from them. A wrapper
// that declares its own concrete return type erases that inference, which surfaced at once
// as "Property 'trim' does not exist on type string | unknown[]" across adapters/git.
//
// Binding via execa's own `execa({...})` form was tried first and rejected on measurement:
// a bound `stdin: 'ignore'` cannot be overridden per call -- execa rejects it with "The
// `stdin` option must not include `ignore`" -- which breaks the one call site that feeds a
// child. Hence the conditional merge below rather than a bound instance.
// execa's own types use `{}` for exactly this default (`ExecaMethod<{}>`), and it is what
// makes `stdout` infer correctly at call sites. `= Options` was tried and degrades the
// inference to `string | unknown[]`, which breaks every caller that calls .trim() on it.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const execa = <O extends Options = {}>(
  file: string,
  args?: readonly string[],
  options?: O,
): ResultPromise<O> => {
  const opts = (options ?? {}) as O
  const supplied = 'stdin' in opts || 'input' in opts
  return rawExeca(file, args ?? [], {
    ...(supplied ? {} : { stdin: 'ignore' as const }),
    timeout: execTimeoutMs(),
    ...opts,
  } as unknown as O) as unknown as ResultPromise<O>
}
