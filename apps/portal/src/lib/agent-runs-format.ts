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
