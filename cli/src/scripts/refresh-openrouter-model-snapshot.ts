/**
 * Regenerate `cli/src/lib/openrouter-model-snapshot.ts` from OpenRouter's
 * live, unauthenticated `GET /api/v1/models` catalogue.
 *
 * This is the maintenance half of the model-id guard (issue #822): the guard
 * itself (`auditDeclaredModelIds` in `plugin-tool-supply-audit.ts`) never
 * calls the network — see that snapshot file's own module docstring for why a
 * live call was rejected as the CI-time check. This script is how the
 * committed snapshot it reads gets refreshed. It runs on a schedule via
 * `.github/workflows/openrouter-snapshot-refresh.yml` (weekly, refreshing once
 * the snapshot is over 21 days old, opening an auto-merge PR — #2115), and can
 * still be run by hand: `pnpm --filter @biffo/cli refresh:openrouter-models`,
 * then commit the result (the generator preserves the hand-written docstring and writes prettier-style output).
 *
 * `MODEL_SNAPSHOT_MAX_AGE_DAYS` in `plugin-tool-supply-audit.ts` fails the
 * guard IN THE TEMPLATE once the committed snapshot is older than that
 * threshold, so a failed scheduled refresh becomes a loud CI failure rather than a
 * silently-aging trust — run this script and commit the diff to clear it. In
 * an instance the same age only warns (#2115): the snapshot is the pinned
 * CLI's, not the instance's to refresh.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

interface OpenRouterModel {
  id?: unknown
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[]
}

/** Fetches the catalogue and returns every `data[].id`, deduplicated and
 * sorted — throws rather than returning an empty/partial list on any
 * network or shape failure, so a broken refresh cannot silently commit a
 * snapshot that validates nothing (the same fail-closed-on-zero posture the
 * guard itself takes on its committed output). */
export async function fetchOpenRouterModelIds(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL)
  if (!response.ok) {
    throw new Error(
      `OpenRouter /models returned ${response.status} ${response.statusText} — refusing to write a snapshot from this.`,
    )
  }
  const body = (await response.json()) as OpenRouterModelsResponse
  if (!Array.isArray(body.data)) {
    throw new Error('OpenRouter /models response had no "data" array — cannot build a snapshot.')
  }
  const ids = body.data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) {
    throw new Error(
      'OpenRouter /models returned zero usable ids — refusing to write an empty snapshot.',
    )
  }
  return [...new Set(ids)].sort()
}

/** Single-quoted string literal, the way the repo's prettier config
 * (`singleQuote: true`) writes it. Escapes only what a JS single-quoted string
 * must; ids are `provider/slug[:variant]` so in practice nothing is escaped. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function mustReplace(text: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(text)) {
    throw new Error(
      `cannot find ${what} in the existing snapshot module — refusing to write. ` +
        'The generator updates the committed file in place so its hand-written docstring survives; ' +
        'if the file was restructured, update this script to match.',
    )
  }
  return text.replace(pattern, () => replacement)
}

/** Updates the committed module IN PLACE: only the fetched-at constant, the id
 * count in the array's docstring, and the array body change. Everything else —
 * notably the hand-written "Why a snapshot, not a live call" docstring — is
 * kept byte-for-byte, and the output is written in the repo's prettier style
 * (single quotes, no semicolons, trailing commas), so it is a fixed point of
 * `pnpm run format:check` and the scheduled-refresh PR can go green unattended
 * (#2115). Throws, without writing, if the file no longer has the expected
 * shape — a fail-closed refusal rather than a silent regenerate-from-scratch. */
export function renderSnapshotModule(
  existing: string,
  ids: readonly string[],
  fetchedAt: string,
): string {
  let text = mustReplace(
    existing,
    /(export const OPENROUTER_MODEL_SNAPSHOT_FETCHED_AT = )(?:'[^'\n]*'|"[^"\n]*")/,
    `export const OPENROUTER_MODEL_SNAPSHOT_FETCHED_AT = ${quote(fetchedAt)}`,
    'the OPENROUTER_MODEL_SNAPSHOT_FETCHED_AT constant',
  )
  text = mustReplace(
    text,
    /\d+ ids, sorted, deduplicated/,
    `${ids.length} ids, sorted, deduplicated`,
    'the "<N> ids, sorted, deduplicated" docstring line',
  )
  const body = ids.map((id) => `  ${quote(id)},`).join('\n')
  return mustReplace(
    text,
    /(export const OPENROUTER_MODEL_IDS: readonly string\[\] = \[\n)[\s\S]*?\n\]\n?$/,
    `export const OPENROUTER_MODEL_IDS: readonly string[] = [\n${body}\n]\n`,
    'the OPENROUTER_MODEL_IDS array',
  )
}

export async function refreshOpenRouterModelSnapshot(
  outPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ count: number; fetchedAt: string }> {
  const ids = await fetchOpenRouterModelIds(fetchImpl)
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const existing = readFileSync(outPath, 'utf8')
  writeFileSync(outPath, renderSnapshotModule(existing, ids, fetchedAt), 'utf8')
  return { count: ids.length, fetchedAt }
}

async function main(): Promise<void> {
  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'lib',
    'openrouter-model-snapshot.ts',
  )
  const { count, fetchedAt } = await refreshOpenRouterModelSnapshot(outPath)
  console.log(`Wrote ${count} model id(s) to ${outPath} (fetched ${fetchedAt}).`)
  console.log('Review the diff and commit it — this script does not commit for you.')
}

// Only run when executed directly (`tsx refresh-openrouter-model-snapshot.ts`),
// not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
