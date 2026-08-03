#!/usr/bin/env node
//
// Which Core API routes does nothing in the estate call? (#1110)
//
// ## Why this exists
//
// Plan 0013 (LMS v1) spans two repos by design: the core owns data and API, the
// sibling owns the UI. Two of its milestones were recorded complete when only
// the **core** half had merged:
//
//   M9   PUT /lms/my/lessons/{id}/progress shipped and was tested. The sibling
//        had no client, so the course player rendered a lesson's `completed`
//        flag with no way for any learner to set one.
//   M10  Both completion roll-ups shipped and were tested. No client. 233 lines
//        of reporting with no caller.
//
// **550 lines of tested, deployed, unreachable code, and both boards were green
// the whole time.** It was found by hand weeks later while writing an "as built"
// section — not by any check.
//
// The milestone was marked done because its PR merged. For a single-repo
// milestone that is a fair proxy; for a cross-repo one it is not, and nothing
// compared the two repos. The plan document even had a "Cross-repo boundary"
// table naming which milestones span both — the information existed, unused.
//
// ## Which of the issue's three options this is, and why
//
// #1110 weighed a route-coverage gate, milestone bookkeeping, and a dead-surface
// report, noting the last is "the most likely to find things nobody was looking
// for". That is this. It is deliberately NOT a gate:
//
//  - It is **advisory, exit 0 always**, like `shared-sync.sh --candidates` and
//    `--backfill`. A route with no caller is a question, not a defect: internal
//    routes are called by plugins over SigV4, admin routes by the portal, and
//    some are genuinely client-less on purpose.
//  - Failing on day-one residue is how a guard stops being read
//    (`protection-audit.sh` argues this at length). The right first move is
//    triage, not red.
//
// ## How it matches
//
// Exposed: `/api/v1` + each router's own `APIRouter(prefix=...)` + the path in
// its `@router.<verb>("...")` decorator, read from every instance under the
// estate (a repo with `services/api/src/api/routers/`).
//
// Called: every `/api/v1/...` string literal in any repo's frontend source.
//
// Both sides are normalised to a shape comparison — `/{run_id}` and
// `${encodeURIComponent(courseId)}` both become `{}` — because the two repos
// have no reason to agree on a parameter's name and matching on the literal
// text would report every parameterised route as dead.
//
// It reads `origin/<base>` refs, never a working tree: four primary checkouts
// in this estate are stale or dirty right now (#1196), and a detector that
// answers differently depending on whose laptop it runs on is worse than none.
//
// Usage:
//   node scripts/dead-surface.mjs --estate ~/code
//
// Always exits 0. This is a question for a human, never a build failure.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const estate = args.includes('--estate') ? args[args.indexOf('--estate') + 1] : null
/**
 * Ratchet, not a cliff. Without a baseline this is advisory-only and shows OK
 * every morning whatever it finds, which is how a detector stops being read —
 * the thing this whole issue is about. With one, the existing residue never
 * fails and a NEW uncalled route does.
 *
 * Lower it when the list shrinks: a ratchet that never tightens stops meaning
 * anything (the posture `mustBeUniform` and `biffo.orphan-baseline.json` share).
 */
const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : null
if (!estate) {
  process.stderr.write('--estate <dir> is required\n')
  process.exit(2)
}

/** Run a command, returning stdout or '' — a repo that cannot be read is skipped, loudly. */
function git(dir, argv) {
  try {
    return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/**
 * The branch to read. `dev` everywhere per AGENTS.md §2; falls back rather than
 * skipping, because a repo dropped for being unreadable is a repo that leaves
 * the denominator — the defect AGENTS.md §2 records against protection-audit.
 */
function baseRef(dir) {
  for (const ref of ['origin/dev', 'origin/main']) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', ref]).trim()) return ref
  }
  return ''
}

/**
 * Collapse a path to its SHAPE: every parameter segment becomes `{}`.
 *
 * `/lms/my/lessons/{lesson_id}/progress` and
 * `/lms/my/lessons/${encodeURIComponent(id)}/progress` are the same route, and
 * the two repos have no reason to agree on the parameter's name.
 */
function shape(path) {
  return (
    path
      .replace(/\$\{[^}]*\}/g, '{}')
      .replace(/\{[^}]*\}/g, '{}')
      // Drop anything from a query string onward, in either form.
      .replace(/[?#].*$/, '')
      // An interpolation GLUED to the end of a segment is not a path parameter
      // — it is a query string or suffix. `/admin/endpoints/detail${qs}` is a
      // call to `/admin/endpoints/detail`, and treating the `{}` as a segment
      // reported that route as having no caller when `endpoint-api.ts` calls it
      // on every load. An interpolation that forms its OWN segment (`/${id}/`)
      // is a real parameter and is kept.
      .replace(/([^/]){\}$/, '$1')
      .replace(/\/+$/, '')
  )
}

const repos = readdirSync(estate, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(estate, e.name, '.git')))
  .map((e) => join(estate, e.name))

/** shape -> {verb, path, repo} exposed by an instance's Core API. */
const exposed = new Map()
/** shape -> Set(repo) that calls it. */
const called = new Map()
const skipped = []

for (const dir of repos) {
  const name = dir.split('/').pop()
  const ref = baseRef(dir)
  if (!ref) {
    skipped.push(`${name} (no readable base ref)`)
    continue
  }

  // --- exposed side: this repo's routers, if it has any -------------------
  const routerFiles = git(dir, ['ls-tree', '-r', '--name-only', ref])
    .split('\n')
    .filter((f) => /^services\/api\/src\/api\/routers\/.*\.py$/.test(f))

  for (const file of routerFiles) {
    const src = git(dir, ['show', `${ref}:${file}`])
    if (!src) continue
    const prefix = /APIRouter\(\s*prefix="([^"]*)"/.exec(src)?.[1] ?? ''
    for (const m of src.matchAll(/@router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
      const verb = m[1].toUpperCase()
      const full = `/api/v1${prefix}${m[2]}`
      exposed.set(`${verb} ${shape(full)}`, { verb, path: shape(full), repo: name })
    }
  }

  // --- called side: any /api/v1/... literal in this repo's frontend -------
  const frontFiles = git(dir, ['ls-tree', '-r', '--name-only', ref])
    .split('\n')
    .filter((f) => /^apps\/.*\/src\/.*\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))

  for (const file of frontFiles) {
    const src = git(dir, ['show', `${ref}:${file}`])
    if (!src) continue
    // Module-level base constants FIRST. This codebase's dominant pattern is
    //
    //   const BASE = '/api/v1/admin/users'
    //   client.post(`${BASE}/${encodeURIComponent(username)}/suspend`, {})
    //
    // so matching only literals that START with `/api/v1/` misses nearly every
    // item route. The first cut of this script did exactly that and reported 51
    // routes as having no caller, of which the great majority were reachable —
    // a detector confidently reporting on an input it could not see, which is
    // the defect this estate keeps finding. Verified against
    // `apps/portal/src/lib/user-admin-api.ts` before fixing.
    const bases = new Map()
    for (const b of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](\/api\/v1[^'"`]*)['"`]/g)) {
      bases.set(b[1], b[2])
    }

    const record = (path) => {
      const sh = shape(path)
      if (!sh.startsWith('/api/v1')) return
      if (!called.has(sh)) called.set(sh, new Set())
      called.get(sh).add(name)
    }

    // Plain literals.
    for (const m of src.matchAll(/['"`](\/api\/v1\/?[^'"`\s]*)['"`]/g)) record(m[1])

    // Template literals opening with a known base constant.
    for (const m of src.matchAll(/`\$\{([A-Za-z_$][\w$]*)\}([^`]*)`/g)) {
      const base = bases.get(m[1])
      if (base) record(base + m[2])
    }

    // A bare `client.get(BASE)` — the collection route, no interpolation.
    for (const m of src.matchAll(/\.(?:get|post|put|patch|delete|del)\b[^(]*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
      const base = bases.get(m[1])
      if (base) record(base)
    }
  }
}

const dead = []
for (const [key, route] of exposed) {
  if (called.has(route.path)) continue
  dead.push(route)
}
dead.sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb))

/**
 * Routes nothing in a browser is ever expected to call. Not an allowlist of
 * things to ignore forever — a statement about WHO the caller is, so the
 * report is about the surface that genuinely has none.
 */
const EXPECTED_NO_FRONTEND_CALLER = [
  // SigV4 service-to-service, called by plugins, never by a browser (ADR-0009/0017).
  { match: (p) => p.startsWith('/api/v1/internal/'), why: 'internal: SigV4 plugin caller, not a browser' },
  // Liveness, called by infrastructure.
  { match: (p) => p.startsWith('/api/v1/health'), why: 'health: called by infrastructure' },
]

const unexplained = []
const explained = []
for (const r of dead) {
  const rule = EXPECTED_NO_FRONTEND_CALLER.find((e) => e.match(r.path))
  ;(rule ? explained : unexplained).push({ ...r, why: rule?.why })
}

console.log(`\ndead surface — Core API routes no frontend in the estate calls (advisory, #1110)\n`)
console.log(`${exposed.size} route(s) exposed, ${called.size} distinct path shape(s) called across ${repos.length} repos`)
if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`)

console.log(`\nno caller found (${unexplained.length}) — the ones worth triaging\n`)
for (const r of unexplained) {
  console.log(`  ${r.verb.padEnd(6)} ${r.path.padEnd(58)} ${r.repo}`)
}

console.log(`\nno FRONTEND caller, and not expected to have one (${explained.length})\n`)
for (const r of explained) {
  console.log(`  ${r.verb.padEnd(6)} ${r.path.padEnd(58)} ${r.why}`)
}

console.log(
  `\nA route with no caller is a QUESTION, not a defect — it may be called by a plugin,\n` +
    `by a job, or be genuinely unused. #1110's instance was 550 lines of tested, deployed,\n` +
    `unreachable code that two green boards reported as done.\n`,
)

if (max === null) process.exit(0)

if (unexplained.length > max) {
  console.log(`${unexplained.length} uncalled route(s), baseline ${max} — something new was exposed with no caller.\n`)
  process.exit(1)
}
if (unexplained.length < max) {
  console.log(`${unexplained.length} uncalled route(s), baseline ${max} — IMPROVED, lower the baseline to ${unexplained.length}.\n`)
  process.exit(1)
}
console.log(`${unexplained.length} uncalled route(s), at baseline ${max}.\n`)
process.exit(0)
