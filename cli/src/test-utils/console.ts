import { stripAnsi } from './ansi.js'

/** The shape of a `vi.spyOn(console, 'log')` spy, kept structural so callers
 * don't have to name vitest's `MockInstance` generics. */
interface CallCapturingSpy {
  mock: { calls: unknown[][] }
}

/**
 * Flatten everything a spied `console.log` (or `.warn`/`.error`) received into
 * one newline-joined string, with ANSI escapes stripped.
 *
 * Stripping is the point: commands format with chalk, which emits escapes when
 * stdout is a TTY and nothing when it is not. Asserting raw against that output
 * conflates content with presentation — the assertion passes in CI and fails on
 * a developer's machine, or (worse, for `not.toContain`) passes for the wrong
 * reason because the escapes broke up the substring being searched for.
 */
export function capturedOutput(spy: CallCapturingSpy): string {
  return capturedLines(spy).join('\n')
}

/** As `capturedOutput`, but one entry per `console.log` call — for assertions
 * that need to pick out a single line (e.g. a table header). */
export function capturedLines(spy: CallCapturingSpy): string[] {
  return spy.mock.calls.map((call) => stripAnsi(call.join(' ')))
}
