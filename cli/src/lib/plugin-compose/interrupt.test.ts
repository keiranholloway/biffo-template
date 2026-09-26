import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installInterruptSignal } from './interrupt.js'

describe('installInterruptSignal', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    '%s aborts the signal, for the WHOLE run and not only once the stack is up',
    (sig) => {
      const proc = new EventEmitter()
      const { signal } = installInterruptSignal(proc)
      expect(signal.aborted).toBe(false)
      proc.emit(sig)
      expect(signal.aborted).toBe(true)
    },
  )

  it('dispose() removes every listener it added, so it does not leak into the host process', () => {
    const proc = new EventEmitter()
    const { dispose } = installInterruptSignal(proc)
    expect(proc.eventNames().length).toBe(3)
    dispose()
    expect(proc.eventNames()).toEqual([])
  })

  it('a second signal after the first is not swallowed: the listeners are gone, so the default action (die) applies', () => {
    const proc = new EventEmitter()
    installInterruptSignal(proc)
    proc.emit('SIGTERM')
    expect(proc.eventNames()).toEqual([])
  })
})
