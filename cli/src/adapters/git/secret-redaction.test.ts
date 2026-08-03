import { execa } from 'execa'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GitAdapter, REDACTED, redactSecrets } from './index.js'
import { makeTmpDir } from '../../test-utils/tmp.js'

/**
 * No thrown error from a token-taking git operation may contain the token.
 *
 * ## Why this is a sweep and not three assertions
 *
 * Before #1135/#1169 there was no redaction helper anywhere in `cli/src`, so
 * each author handling a credential-carrying failure chose between leaking the
 * secret and discarding the error. Both wrong answers shipped, in the same
 * file: `push` discarded (making #1040 undiagnosable), the two clones
 * interpolated raw (leaking the token into CI logs).
 *
 * A test pinning the three known methods would catch neither the fourth
 * credential-carrying `execa` call nor a future author reverting to either
 * extreme. `TOKEN_TAKING` is therefore an enumeration meant to grow, and the
 * coverage assertion below fails if a new token-taking method is added to
 * `GitAdapter` without being listed here.
 *
 * ## Why the failures are real, not mocked
 *
 * The leak vector is `execa`'s command echo — its error message opens with the
 * full argv it ran, tokenized URL included. A mocked rejection would not carry
 * that argv, so it would pass against the very bug this exists to catch. Each
 * case therefore drives a real `git` subprocess at an unroutable remote.
 */

/**
 * Deliberately NOT shaped like a real GitHub PAT.
 *
 * The first draft used a `ghp_`-prefixed value, which reads as more realistic
 * and is exactly wrong: gitleaks' `github-pat` rule matched it and `.husky/
 * pre-push` rejected the push. Per AGENTS.md §7 the fix is the fixture value,
 * never the allowlist — and note the scan reads git *history*, so a
 * token-shaped sentinel has to be amended out rather than corrected at the tip.
 *
 * Nothing here depends on the shape: `injectToken` places whatever string it is
 * given into the URL's password field, and `execa` echoes the argv either way.
 * Realism would buy nothing and cost every future push.
 */
const SENTINEL = 'BIFFO-SENTINEL-NOT-A-REAL-CREDENTIAL-0123456789'

/**
 * Port 1 is reserved and never listenable, so the connection is refused
 * immediately — no DNS timeout, no credential prompt, no network dependency.
 * `https` is required: `injectToken` deliberately leaves other schemes alone.
 */
const UNROUTABLE = 'https://127.0.0.1:1/biffo/does-not-exist.git'

/** A real repo with one commit and an HTTPS remote, so `push` reaches `injectToken`. */
async function repoWithHttpsRemote(): Promise<string> {
  const dir = makeTmpDir('biffo-redact-push')
  const opts = { cwd: dir } as const
  await execa('git', ['init', '-q', '-b', 'main'], opts)
  await execa('git', ['config', 'user.email', 'test@example.com'], opts)
  await execa('git', ['config', 'user.name', 'Test'], opts)
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], opts)
  await execa('git', ['remote', 'add', 'origin', UNROUTABLE], opts)
  return dir
}

interface TokenTakingCase {
  method: string
  run: (git: GitAdapter) => Promise<unknown>
}

const TOKEN_TAKING: TokenTakingCase[] = [
  {
    method: 'cloneToTemp',
    run: (git) => git.cloneToTemp(UNROUTABLE, 'biffo-redact-clone', SENTINEL),
  },
  {
    method: 'cloneForEditing',
    run: (git) => git.cloneForEditing(UNROUTABLE, 'biffo-redact-edit', SENTINEL),
  },
  {
    method: 'push',
    run: async (git) => git.push(await repoWithHttpsRemote(), 'main', { token: SENTINEL }),
  },
]

describe('a git failure never leaks the token it was given', () => {
  it.each(TOKEN_TAKING.map((c) => [c.method, c] as const))(
    '%s: throws, and the token is not in the message',
    async (method, testCase) => {
      const git = new GitAdapter()

      let message: string | undefined
      try {
        await testCase.run(git)
      } catch (err) {
        message = (err as Error).message
      }

      // A case that stopped failing would vacuously "not leak" — the estate's
      // most repeated defect is a check reporting zero because it read nothing.
      expect(message, `${method} was expected to fail against ${UNROUTABLE}`).toBeDefined()

      expect(message, `${method} leaked its token into the thrown error`).not.toContain(SENTINEL)
      expect(
        message,
        `${method} leaked its percent-encoded token into the thrown error`,
      ).not.toContain(encodeURIComponent(SENTINEL))
    },
    30_000,
  )

  /**
   * The other half of #1135: redacting by discarding the whole error is not a
   * pass. Each message must still carry enough to tell one failure from
   * another — that is the entire reason #1040's cause was never found.
   */
  it.each(TOKEN_TAKING.map((c) => [c.method, c] as const))(
    '%s: still reports why it failed',
    async (method, testCase) => {
      const git = new GitAdapter()

      let message = ''
      try {
        await testCase.run(git)
      } catch (err) {
        message = (err as Error).message
      }

      expect(
        message.length,
        `${method} threw a contentless message — a discarded error is not redaction`,
      ).toBeGreaterThan(60)
      expect(message, `${method} did not report the underlying git invocation`).toMatch(
        /git|Command failed|exit code/i,
      )
    },
    30_000,
  )

  /**
   * Guards the enumeration itself. Any `GitAdapter` method accepting a token
   * must appear in `TOKEN_TAKING`, so adding a fourth credential-carrying call
   * cannot silently escape the sweep above.
   */
  it('covers every token-taking method on GitAdapter', () => {
    const source = readAdapterSource()
    const declared = [...source.matchAll(/^\s{2}async (\w+)\(([^)]*)\)/gm)]
      .filter(([, , params]) => /\btoken\b/.test(params))
      .map(([, name]) => name)

    expect(
      declared.length,
      'found no token-taking methods — has the parser stopped reading?',
    ).toBeGreaterThanOrEqual(3)

    const covered = new Set(TOKEN_TAKING.map((c) => c.method))
    const uncovered = declared.filter((name) => !covered.has(name))

    expect(
      uncovered,
      `these GitAdapter methods take a token but are not exercised above:\n` +
        `  ${uncovered.join(', ')}\n` +
        `  add a case to TOKEN_TAKING — a credential-carrying call that is not\n` +
        `  swept is exactly how #1169 shipped.`,
    ).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('replaces the raw and percent-encoded forms', () => {
    const secret = 'tok++needs//encoding'
    const text = `raw ${secret} encoded ${encodeURIComponent(secret)}`
    const out = redactSecrets(text, [secret])

    expect(out).not.toContain(secret)
    expect(out).not.toContain(encodeURIComponent(secret))
    expect(out).toBe(`raw ${REDACTED} encoded ${REDACTED}`)
  })

  it('treats the secret literally, never as a regex', () => {
    // `.` would match any character if this were compiled into a pattern.
    expect(redactSecrets('a.b.c.d.e.f', ['x.x.x.x.x'])).toBe('a.b.c.d.e.f')
  })

  it('ignores undefined and implausibly short secrets rather than shredding the message', () => {
    expect(redactSecrets('the error text', [undefined])).toBe('the error text')
    expect(redactSecrets('the error text', ['e'])).toBe('the error text')
  })

  it('redacts every occurrence, not just the first', () => {
    const out = redactSecrets('ghp_abcdefgh once ghp_abcdefgh twice', ['ghp_abcdefgh'])
    expect(out).toBe(`${REDACTED} once ${REDACTED} twice`)
  })
})

function readAdapterSource(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
}
