import type { EventEmitter } from 'node:events'

const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * One AbortSignal that fires when the process is asked to stop, installed for the
 * WHOLE `dev up` run rather than only once the stack is up.
 *
 * The composition's servers are spawned `detached` (their own process group, so a
 * kill takes `uv` and the uvicorn beneath it). That makes them immune to the
 * terminal's Ctrl-C and to a SIGTERM aimed at this process alone — so a process
 * that dies from a signal it never handled leaves Core running with its database
 * clone attached (#1525 verdict, finding 3a). Handling the signal here is what
 * lets `composeStack` run its teardown at any point, including mid-startup and
 * during `--check`, not just in the steady-state wait.
 *
 * `once`: a second signal finds no listener and takes the default action, so a
 * teardown that itself hangs can still be killed.
 */
export function installInterruptSignal(proc: EventEmitter = process): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const onSignal = () => {
    controller.abort()
    dispose()
  }
  const dispose = () => {
    for (const name of INTERRUPTS) proc.removeListener(name, onSignal)
  }
  for (const name of INTERRUPTS) proc.once(name, onSignal)
  return { signal: controller.signal, dispose }
}
