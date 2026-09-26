/**
 * The scheduled snapshot refresh (`.github/workflows/openrouter-snapshot-refresh.yml`,
 * #2115) opens a PR that must go green UNATTENDED. That only holds if what the
 * generator writes is a fixed point of everything downstream that reads it:
 *
 *  - `ci.yml`'s `pnpm run format:check` (prettier) — the first draft emitted
 *    double-quoted strings and a generic header, so the bot's PR was red on
 *    formatting alone and its `--auto` merge never fired;
 *  - the workflow's own "due" step, which greps `FETCHED_AT` out of the file
 *    (the same first draft made that read back empty, so it reported "due"
 *    forever);
 *  - the hand-written module docstring, which the first draft deleted.
 *
 * These tests run the real generator over a copy of the real committed
 * snapshot, then hand its output to the real prettier config and the real
 * workflow shell — not a restated copy of either — so the pieces cannot drift.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { refreshOpenRouterModelSnapshot } from './refresh-openrouter-model-snapshot.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const realSnapshot = join(repoRoot, 'cli', 'src', 'lib', 'openrouter-model-snapshot.ts')
const workflowPath = join(repoRoot, '.github', 'workflows', 'openrouter-snapshot-refresh.yml')

function fakeFetch(ids: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
    })) as unknown as typeof fetch
}

const IDS = ['~openai/gpt-latest', 'zeta/model:free', 'alpha/model-1.5', 'alpha/model-1.5']

describe('refreshOpenRouterModelSnapshot output', () => {
  let dir: string
  let out: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'or-refresh-'))
    mkdirSync(join(dir, 'cli', 'src', 'lib'), { recursive: true })
    out = join(dir, 'cli', 'src', 'lib', 'openrouter-model-snapshot.ts')
    copyFileSync(realSnapshot, out)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is already prettier-formatted under the repo config (format:check fixed point)', async () => {
    await refreshOpenRouterModelSnapshot(out, fakeFetch(IDS))
    const written = readFileSync(out, 'utf8')
    const config = await prettier.resolveConfig(realSnapshot)
    const formatted = await prettier.format(written, { ...config, filepath: realSnapshot })
    expect(written).toBe(formatted)
  })

  it('keeps the hand-written docstring and updates the id count in it', async () => {
    const before = readFileSync(out, 'utf8')
    await refreshOpenRouterModelSnapshot(out, fakeFetch(IDS))
    const after = readFileSync(out, 'utf8')
    expect(after).toContain('Why a snapshot, not a live call')
    expect(after).toContain('3 ids, sorted, deduplicated')
    const head = (s: string) => s.slice(0, s.indexOf('/** ISO-8601 UTC timestamp'))
    expect(head(after)).toBe(head(before))
  })

  it('writes sorted, deduplicated ids and nothing else in the array', async () => {
    await refreshOpenRouterModelSnapshot(out, fakeFetch(IDS))
    const after = readFileSync(out, 'utf8')
    expect(after.slice(after.indexOf('readonly string[] = ['))).toBe(
      [
        'readonly string[] = [',
        "  'alpha/model-1.5',",
        "  'zeta/model:free',",
        "  '~openai/gpt-latest',",
        ']',
        '',
      ].join('\n'),
    )
  })

  it("leaves a timestamp the workflow's own 'due' step can read back", async () => {
    const { fetchedAt } = await refreshOpenRouterModelSnapshot(out, fakeFetch(IDS))
    const line = readFileSync(workflowPath, 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('fetched=$(sed'))
    expect(line, 'workflow no longer has a `fetched=$(sed …)` line').toBeDefined()
    const read = execFileSync('sh', ['-c', `${line}\nprintf %s "$fetched"`], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(read).toBe(fetchedAt)
  })

  it('refuses to write when the existing file has no snapshot block to update', async () => {
    writeFileSync(out, 'export const unrelated = 1\n')
    await expect(refreshOpenRouterModelSnapshot(out, fakeFetch(IDS))).rejects.toThrow(/cannot find/)
    expect(readFileSync(out, 'utf8')).toBe('export const unrelated = 1\n')
  })

  it('refuses when the snapshot file does not exist', async () => {
    rmSync(out)
    await expect(refreshOpenRouterModelSnapshot(out, fakeFetch(IDS))).rejects.toThrow()
  })
})

describe('openrouter-snapshot-refresh.yml push step', () => {
  const yml = readFileSync(workflowPath, 'utf8')

  it('does not persist the read-only checkout credential (it would override the App token in the push URL)', () => {
    const checkout = yml.slice(yml.indexOf('actions/checkout@'), yml.indexOf('- name: Decide'))
    expect(checkout).toMatch(/persist-credentials:\s*false/)
  })

  it('formats the snapshot before committing as a belt-and-braces backstop', () => {
    expect(yml).toMatch(/prettier --write cli\/src\/lib\/openrouter-model-snapshot\.ts/)
  })
})
