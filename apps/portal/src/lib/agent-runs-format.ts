/** Presentation helpers for agent-run views. Kept out of the page module so
 *  they can be unit-tested — a Next.js page file may only export a default and
 *  the framework's reserved fields. */

export function formatWhen(iso: string | null): string {
  if (iso == null) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** Human-readable run duration from the two timings, e.g. "1.4s" or "—". */
export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (startedAt == null || completedAt == null) return '—'
  const start = new Date(startedAt).getTime()
  const end = new Date(completedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const ms = end - start
  if (ms < 1000) return `${String(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rem = Math.round(seconds % 60)
  return `${String(minutes)}m ${String(rem)}s`
}

export function formatCost(cost: number | null): string {
  if (cost == null) return '—'
  return `$${cost.toFixed(4)}`
}

/**
 * Calculate and format the mean cost per priced run.
 * Mean is computed ONLY over priced runs (runs with cost_usd != null),
 * not over all runs. This matters: if 10 runs cost $1 total but 5 are
 * unpriced, the mean is $0.20 per priced run, not $0.10 per run overall.
 * Using all runs would make cheaper models appear cheaper than they are.
 *
 * @param totalCost - total cost across all priced runs (may be null)
 * @param pricedRunCount - number of runs with a cost (not null); computed by caller as (total runs - unpriced_runs)
 * @returns formatted mean cost or '—' if no priced runs
 */
export function formatMeanCost(totalCost: number | null, pricedRunCount: number): string {
  if (totalCost == null || pricedRunCount === 0) return '—'
  const mean = totalCost / pricedRunCount
  return `$${mean.toFixed(4)}`
}

/**
 * Pull a one-line, human-readable cause out of a run's raw error text.
 *
 * The runtime stores errors like
 * `LLM call failed on turn 1: OpenRouter returned 402: {"error":{"message":"Insufficient credits. …"}}`.
 * The useful part is inside the JSON, which may also be truncated (the runtime
 * clips upstream bodies), so we try a real parse and fall back to a regex.
 */
export function summarizeRunError(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const text = raw.trim()
  if (text === '') return null

  const braceAt = text.indexOf('{')
  const prefix = (braceAt === -1 ? text : text.slice(0, braceAt)).trim().replace(/[:\s]+$/, '')
  const upstream = /(OpenRouter) returned (\d{3})/.exec(prefix)
  const label = upstream != null ? `${upstream[1] ?? ''} ${upstream[2] ?? ''}` : null

  let message: string | null = null
  if (braceAt !== -1) {
    const body = text.slice(braceAt)
    try {
      const parsed: unknown = JSON.parse(body)
      const err = (parsed as { error?: unknown } | null)?.error
      if (typeof err === 'string') message = err
      else if (err != null && typeof (err as { message?: unknown }).message === 'string') {
        message = (err as { message: string }).message
      } else if (typeof (parsed as { message?: unknown } | null)?.message === 'string') {
        message = (parsed as { message: string }).message
      }
    } catch {
      const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(body)
      if (m?.[1] != null) message = m[1].replace(/\\(.)/g, '$1')
    }
  }

  if (message != null && message.trim() !== '') {
    // First sentence only: the rest is usually remedy text with URLs.
    const first = /^.*?[.!?](?=\s|$)/.exec(message.trim())?.[0] ?? message.trim()
    return label != null ? `${label}: ${first}` : first
  }
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

/** Split text into plain and http(s) URL parts, so URLs can be rendered as links. */
export function splitUrls(text: string): { url: boolean; text: string }[] {
  const parts: { url: boolean; text: string }[] = []
  let last = 0
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    let url = m[0]
    const trimmed = url.replace(/[.,;:)\]}]+$/, '')
    const start = m.index
    if (start > last) parts.push({ url: false, text: text.slice(last, start) })
    parts.push({ url: true, text: trimmed })
    url = trimmed
    last = start + url.length
  }
  if (last < text.length) parts.push({ url: false, text: text.slice(last) })
  return parts
}
