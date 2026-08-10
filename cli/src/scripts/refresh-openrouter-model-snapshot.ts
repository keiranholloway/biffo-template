/**
 * Regenerate `cli/src/lib/openrouter-model-snapshot.ts` from OpenRouter's
 * live, unauthenticated `GET /api/v1/models` catalogue.
 *
 * This is the maintenance half of the model-id guard (issue #822): the guard
 * itself (`auditDeclaredModelIds` in `plugin-tool-supply-audit.ts`) never
 * calls the network — see that snapshot file's own module docstring for why a
 * live call was rejected as the CI-time check. This script is how the
 * committed snapshot it reads gets refreshed, and it is deliberately NOT
 * wired into any CI workflow: run it by hand (`pnpm --filter @biffo/cli
 * refresh:openrouter-models`) and commit the result, or wire a scheduled
 * workflow to do the same later. That wiring is follow-up work — this change
 * was scoped to `cli/src/lib/**` and `cli/src/scripts/**`, and
 * `.github/workflows/` was explicitly out of its territory.
 *
 * `MODEL_SNAPSHOT_MAX_AGE_DAYS` in `plugin-tool-supply-audit.ts` fails the
 * guard once the committed snapshot is older than that threshold, so a
 * forgotten refresh becomes a loud CI failure rather than a silently-aging
 * trust — run this script and commit the diff to clear it.
 */
import { writeFileSync } from 'node:fs'
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

function renderSnapshotModule(ids: readonly string[], fetchedAt: string): string {
  const header = `/**
 * A committed, periodically-refreshed snapshot of OpenRouter's model
 * catalogue — the id half of #822's "validate model ids against the
 * provider's live model list".
 *
 * See this file's own git history / the module docstring this generator
 * writes below for the reasoning; edit the DOCSTRING by hand if it needs to
 * change, but never hand-edit the id array — regenerate it with
 * \`refresh-openrouter-model-snapshot.ts\` so the committed list stays an
 * honest copy of what the provider actually reported.
 *
 * Fetched from the live, unauthenticated OpenRouter \`/models\` endpoint —
 * \`curl ${OPENROUTER_MODELS_URL}\`, \`data[].id\`, deduplicated and sorted.
 */

/** ISO-8601 UTC timestamp of the live fetch this snapshot was built from. */
export const OPENROUTER_MODEL_SNAPSHOT_FETCHED_AT = ${JSON.stringify(fetchedAt)}

/** Every \`data[].id\` OpenRouter's \`/models\` endpoint reported at fetch time —
 * ${ids.length} ids, sorted, deduplicated. A handful of entries are
 * \`~\`-prefixed floating aliases (\`~openai/gpt-latest\`); those are real,
 * resolvable ids in OpenRouter's own catalogue, not a parsing artifact, and
 * are kept verbatim. */
export const OPENROUTER_MODEL_IDS: readonly string[] = [
`
  const body = ids.map((id) => `  ${JSON.stringify(id)},`).join('\n')
  return `${header}${body}\n]\n`
}

export async function refreshOpenRouterModelSnapshot(
  outPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ count: number; fetchedAt: string }> {
  const ids = await fetchOpenRouterModelIds(fetchImpl)
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(outPath, renderSnapshotModule(ids, fetchedAt), 'utf8')
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
