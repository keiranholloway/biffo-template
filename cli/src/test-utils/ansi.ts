/**
 * Test-only ANSI helpers.
 *
 * chalk colours its output when stdout is a TTY and goes plain when it is not,
 * so a test that asserts a literal substring against chalk-formatted text is
 * asserting *presentation* as well as content: it passes in CI (no TTY, no
 * escapes) and fails on a developer's machine (TTY, escapes interleaved). That
 * is the most confusing failure direction — a red suite on a clean checkout.
 *
 * Strip the escapes before asserting so the assertion is about content only.
 * Reach for this in any test that captures console output from a command that
 * uses chalk (directly or via `lib/logger.ts`).
 */

// CSI sequences (SGR colour/bold/dim, cursor moves, …) and OSC hyperlinks —
// what chalk and ora actually emit. Deliberately narrow rather than a general
// terminal-control grammar.
const CSI = '\\u001B\\[[0-?]*[ -/]*[@-~]'
const OSC = '\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)'
const ANSI_PATTERN = new RegExp(`${CSI}|${OSC}`, 'g')

/** Remove ANSI escape sequences from `value`. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}
