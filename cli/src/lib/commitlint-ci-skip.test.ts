/**
 * Guards the `body-no-ci-skip-token` commitlint rule (root `commitlint.config.js`).
 *
 * GitHub reads the WHOLE commit message for a CI-skip token, so prose in a body
 * explaining one silently suppresses every workflow. On 2026-08-01 the commit
 * implementing the sibling scaffold's deliberate marker did exactly that: zero
 * runs were created, the PR sat BLOCKED on checks that could never arrive, and
 * close/reopen did not help — only amending the message did.
 *
 * Tested here rather than by shelling out to commitlint so the intent of each
 * case is readable, and because the rule's own predicate is the thing that must
 * not regress. `commitlint.config.js` is CommonJS, hence createRequire.
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const config = require(resolve(repoRoot, 'commitlint.config.js'))

/** The rule's predicate, as commitlint would call it. */
function check(body: string | null): [boolean, string] {
  const rule = config.plugins[0].rules['body-no-ci-skip-token']
  return rule({ body })
}

// Assembled rather than written literally: this file's own content is not a
// commit message, but the repo greps for these tokens and a bare one here
// reads as a real marker to a human skimming.
const SKIP = `[${'skip'} ci]`
const CI_SKIP = `[${'ci'} skip]`

describe('body-no-ci-skip-token (the 2026-08-01 incident)', () => {
  it('passes an ordinary body', () => {
    const [ok] = check('Explains the change without mentioning any marker.')
    expect(ok).toBe(true)
  })

  it('passes an empty or absent body', () => {
    expect(check('')[0]).toBe(true)
    expect(check(null)[0]).toBe(true)
  })

  it('rejects the token in the body', () => {
    const [ok, message] = check(`The scaffold commit carries ${SKIP} so nothing triggers.`)
    expect(ok).toBe(false)
    expect(message).toContain(SKIP)
    // The message has to say what to do instead, or it just blocks people.
    expect(message).toContain('skip-ci marker')
    expect(message).toContain('SUBJECT')
  })

  it('rejects it inside backticks — the form that actually bit us', () => {
    const [ok] = check(`- the scaffold commit carries \`${SKIP}\`, so the push triggers nothing.`)
    expect(ok).toBe(false)
  })

  it('rejects the other spellings GitHub honours', () => {
    expect(check(`uses ${CI_SKIP} here`)[0]).toBe(false)
    expect(check('uses [no ci] here')[0]).toBe(false)
    expect(check('uses [skip actions] here')[0]).toBe(false)
    expect(check('uses [actions skip] here')[0]).toBe(false)
  })

  it('is case-insensitive, because GitHub is', () => {
    expect(check(`carries ${SKIP.toUpperCase()}`)[0]).toBe(false)
  })

  it('is wired into the exported rules at error level', () => {
    // A plugin that is defined but not enabled is exactly the fail-open shape
    // this rule exists to prevent, so assert the wiring and not just the logic.
    expect(config.rules['body-no-ci-skip-token']).toEqual([2, 'always'])
  })
})
