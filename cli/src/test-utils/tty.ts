import { afterEach, beforeEach } from 'vitest'

/**
 * Run the enclosing describe block as if stdin were (or were not) a terminal.
 *
 * vitest's own `process.stdin` is never a TTY, and `promptOr` refuses to prompt
 * without one (lib/interactive.ts), so a test of a command's interactive branch
 * has to say it is interactive. Restores the real value after each test.
 */
export function useStdinTTY(isTTY: boolean): void {
  let original: PropertyDescriptor | undefined
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
  })
  afterEach(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  })
}
