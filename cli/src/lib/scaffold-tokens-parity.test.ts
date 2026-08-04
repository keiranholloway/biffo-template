import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The scaffold token list is duplicated on purpose. This is the guard that
 * makes the duplication safe (#1271).
 *
 * `cli/src/lib/plugin-scaffold.ts` owns the authoritative substitution table —
 * it needs the *replacements*, which are functions of the new plugin's derived
 * names and cannot live in JSON. `scripts/shared-sync.sh` needs only the
 * *tokens*, and it is POSIX sh, so it cannot import TypeScript.
 *
 * Hence `_skeletons/plugin-template/.scaffold-tokens.json`. Without this test
 * it would be exactly the "second copy of a decision" the estate keeps getting
 * burned by — `_extract_detail` (#1107), AGENTS.md drifting behind (#1164), the
 * commit-msg type list. A token added to the code and not the JSON would
 * silently put `src/<new_token>/…` back into the adoption gap list as a phantom
 * 0/N, which is the false positive this whole mechanism exists to remove.
 *
 * Asserted in BOTH directions, deliberately: a token only in the JSON would
 * suppress a real gap, which is worse than the phantom it was meant to prevent.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCAFFOLD_TS = join(ROOT, 'cli', 'src', 'lib', 'plugin-scaffold.ts')
const TOKENS_JSON = join(ROOT, '_skeletons', 'plugin-template', '.scaffold-tokens.json')

/**
 * The literal sources of every regex in `substitutions()`.
 *
 * Read from the source text rather than by calling `substitutions()`, because
 * calling it returns compiled RegExp objects whose `.source` is what we want
 * anyway — and reading the text also catches a token added to the table in a
 * form the parser here does not expect, which is the drift worth failing on.
 */
function tokensInCode(): string[] {
  const src = readFileSync(SCAFFOLD_TS, 'utf8')
  const start = src.indexOf('function substitutions(')
  expect(start, 'substitutions() not found — this guard is reading the wrong file').toBeGreaterThan(
    -1,
  )
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/\[\/([^/]+)\/g,/g)].map((m) => m[1])
}

function tokensInJson(): string[] {
  return JSON.parse(readFileSync(TOKENS_JSON, 'utf8')).tokens
}

describe('scaffold token parity (#1271)', () => {
  it('finds a non-empty table in the code, so the comparison is not vacuous', () => {
    // Without this, a refactor that renames substitutions() turns every
    // assertion below into a comparison of two empty lists — the fail-open
    // shape #1218 and #1270 both record.
    expect(tokensInCode().length).toBeGreaterThanOrEqual(3)
    expect(tokensInJson().length).toBeGreaterThanOrEqual(3)
  })

  it('every token the scaffolder rewrites is declared to shared-sync', () => {
    // Missing here => a phantom 0/N adoption gap for a path that did its job.
    expect([...tokensInJson()].sort()).toEqual([...tokensInCode()].sort())
  })

  it('declares no token the scaffolder does not actually rewrite', () => {
    // Extra here => a REAL adoption gap silently suppressed, which is worse
    // than the phantom this file exists to remove.
    const code = new Set(tokensInCode())
    for (const t of tokensInJson()) {
      expect(
        code.has(t),
        `.scaffold-tokens.json declares "${t}", which substitutions() never rewrites`,
      ).toBe(true)
    }
  })
})
