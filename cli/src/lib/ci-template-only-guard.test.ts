import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `.github/workflows/ci.yml` is template-owned and reaches every instance
 * verbatim, but some CI only works in biffo-template (no `cli/`, no `sdk-v*`
 * tags there). Each such step must be guarded on the absence of
 * `biffo.core.json` (instances carry it; the template does not).
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const source = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
const GUARD = "hashFiles('biffo.core.json') == ''"

interface Step {
  name: string
  text: string
}

function jobSteps(job: string): Step[] {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => l === `  ${job}:`)
  expect(start, `job ${job} exists`).toBeGreaterThan(-1)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!)) {
      end = i
      break
    }
  }
  const steps: Step[] = []
  let cur: string[] | undefined
  let inSteps = false
  for (const l of lines.slice(start, end)) {
    if (/^ {4}steps:\s*$/.test(l)) {
      inSteps = true
      continue
    }
    if (!inSteps || l.trimStart().startsWith('#')) continue
    if (/^ {6}- /.test(l)) {
      cur = [l]
      steps.push({ name: '', text: '' })
      const s = steps[steps.length - 1]!
      s.name = /name:\s*(.+)$/.exec(l)?.[1] ?? l.trim()
      ;(s as unknown as { lines: string[] }).lines = cur
    } else if (cur) cur.push(l)
    const s = steps[steps.length - 1]
    if (s) s.text = (s as unknown as { lines: string[] }).lines.join('\n')
  }
  return steps
}

describe('ci.yml template-only steps are guarded for instances', () => {
  it('Skeleton SDK lock freshness (needs sdk-v* tags) carries the guard', () => {
    const step = jobSteps('python').find((s) => s.name === 'Skeleton SDK lock freshness')
    expect(step).toBeDefined()
    expect(step!.text).toContain(GUARD)
  })

  it('every real-core-schema step after checkout (needs cli/) carries the guard', () => {
    const steps = jobSteps('real-core-schema')
    expect(steps.length).toBeGreaterThan(1)
    for (const step of steps.slice(1)) {
      expect(step.text, `step "${step.name}"`).toContain(GUARD)
    }
  })

  it('any step using working-directory: cli carries the guard', () => {
    const jobs = [...source.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]!)
    for (const job of jobs) {
      if (job === 'jobs') continue
      let steps: Step[]
      try {
        steps = jobSteps(job)
      } catch {
        continue
      }
      for (const step of steps.filter((s) => /working-directory:\s*cli\b/.test(s.text))) {
        expect(step.text, `${job}/"${step.name}"`).toContain(GUARD)
      }
    }
  })
})
