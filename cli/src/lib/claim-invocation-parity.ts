import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every distributed `AGENTS.md` must document the SAME way to claim an issue.
 *
 * ## Why
 *
 * `--as <token>` shipped in #1279 and solves a real, measured failure: every
 * session on a workstation claims under the same GitHub actor, so an untokened
 * claim cannot be told from a stranger's. It reached the template's own
 * `AGENTS.md` and **neither skeleton**. Since the skeletons are what
 * `shared-files.json` distributes to satellites (`filesFromSkeleton`), the flag
 * appeared **zero** times in the `AGENTS.md` of `biffo-plugin-marketing`,
 * `biffo-plugin-idea-scout`, `tabsii-geo` and `tabsii-crm` — the repos where
 * delegated agents actually run and actually collide (#1562).
 *
 * That is `class:drift` in its usual shape: the improvement reached the module
 * and never the call sites. The distribution mechanism was never broken —
 * `AGENTS.md` has been a `sync` entry under `filesFromSkeleton` all along — so
 * nothing would have failed. The skeletons simply were not edited, and no
 * check existed that could notice.
 *
 * ## What it asserts
 *
 * 1. **The claim block is byte-identical** across every distributed
 *    `AGENTS.md`. That is the thing that drifted, so it is compared literally
 *    rather than approximately.
 * 2. **No copy documents an untokened form.** Any `claim` invocation anywhere
 *    in the file — fenced or inline — must carry `--as`, `--release` or
 *    `--guard`. A bare `claim <issue-number>` reintroduced in prose is the
 *    original defect wearing different clothes.
 * 3. **Every copy documents both forms**, `--as` and `--release`. A file that
 *    documents claiming but never releasing leaves the token unusable.
 *
 * ## Sweep, not spot-check
 *
 * The copies are DISCOVERED (repo root plus every `_skeletons/<name>/AGENTS.md`
 * that exists), never listed. A third skeleton added tomorrow is covered the day
 * it lands, which a hardcoded pair of paths would not be — and finding zero
 * copies is a failure, not a pass, because a guard whose input set is empty
 * passes against the exact bug it was written to catch (#695).
 */

export interface AgentsDoc {
  /** Repo-relative path, for the failure message. */
  path: string
  text: string
}

export interface ParityViolation {
  rule: 'no-copies' | 'block-drift' | 'untokened-form' | 'missing-form'
  path: string
  detail: string
}

/**
 * Every `AGENTS.md` this repo distributes: its own, plus one per skeleton.
 *
 * A skeleton without an `AGENTS.md` (`_skeletons/registry/` is plugin-registry
 * *content*, not a repo scaffold) contributes nothing rather than an error.
 */
export function distributedAgentsDocs(root: string): AgentsDoc[] {
  const docs: AgentsDoc[] = []
  const own = join(root, 'AGENTS.md')
  if (existsSync(own)) docs.push({ path: 'AGENTS.md', text: readFileSync(own, 'utf8') })

  const skeletons = join(root, '_skeletons')
  if (existsSync(skeletons)) {
    for (const name of readdirSync(skeletons).sort()) {
      const abs = join(skeletons, name, 'AGENTS.md')
      if (!existsSync(abs)) continue
      docs.push({ path: `_skeletons/${name}/AGENTS.md`, text: readFileSync(abs, 'utf8') })
    }
  }
  return docs
}

/** Does this line invoke `claim`, rather than merely mention the word? */
function isClaimInvocation(line: string): boolean {
  return /\b(?:biffo\.sh|claim\.sh)\s+claim\b|\bclaim\.sh\s+\d|\bclaim\s+<issue-number>/.test(line)
}

/**
 * The contiguous run of `claim` invocation lines inside fenced code blocks.
 *
 * Trailing `# …` comments are kept: they are part of what the reader copies,
 * and they are where "0 free · 1 taken · 2 cannot tell" lives. Trailing
 * whitespace is not, because it is invisible and would produce a failure nobody
 * can see.
 */
export function claimBlock(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let fenced = false
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (!fenced) continue
    if (isClaimInvocation(raw)) out.push(raw.trimEnd())
  }
  return out
}

/**
 * Every claim invocation in the file, fenced or inline, one per entry.
 *
 * Inline spans matter: prose is where a bare form comes back, and the whole
 * point of #1562 is that a documented untokened form is the defect.
 */
export function claimInvocations(text: string): string[] {
  const found: string[] = []
  let fenced = false
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      if (isClaimInvocation(raw)) found.push(raw.trimEnd())
      continue
    }
    for (const match of raw.matchAll(/`([^`]+)`/g)) {
      const span = match[1]
      if (span !== undefined && isClaimInvocation(span)) found.push(span.trim())
    }
  }
  return found
}

/** Does an invocation prove ownership, one way or another? */
function isTokened(invocation: string): boolean {
  return /--as\b|--release\b|--guard\b/.test(invocation)
}

export function auditClaimInvocationParity(docs: AgentsDoc[]): ParityViolation[] {
  const violations: ParityViolation[] = []

  if (docs.length === 0) {
    return [
      {
        rule: 'no-copies',
        path: '(none)',
        detail:
          'no distributed AGENTS.md found — a guard with an empty input set passes against anything',
      },
    ]
  }

  const [canonical, ...rest] = docs as [AgentsDoc, ...AgentsDoc[]]
  const canonicalBlock = claimBlock(canonical.text)

  if (canonicalBlock.length === 0) {
    violations.push({
      rule: 'missing-form',
      path: canonical.path,
      detail: 'documents no claim invocation at all',
    })
  }

  for (const doc of rest) {
    const block = claimBlock(doc.text)
    if (block.join('\n') !== canonicalBlock.join('\n')) {
      violations.push({
        rule: 'block-drift',
        path: doc.path,
        detail: `claim block differs from ${canonical.path}\n    ${canonical.path}:\n${canonicalBlock
          .map((l) => `      ${l}`)
          .join('\n')}\n    ${doc.path}:\n${block.map((l) => `      ${l}`).join('\n')}`,
      })
    }
  }

  for (const doc of docs) {
    const invocations = claimInvocations(doc.text)
    for (const invocation of invocations) {
      if (!isTokened(invocation)) {
        violations.push({
          rule: 'untokened-form',
          path: doc.path,
          detail: `documents a claim with no --as token: ${invocation.trim()}`,
        })
      }
    }
    if (!invocations.some((i) => /--as\b/.test(i))) {
      violations.push({
        rule: 'missing-form',
        path: doc.path,
        detail: 'never documents `claim <issue-number> --as <token>`',
      })
    }
    if (!invocations.some((i) => /--release\b/.test(i))) {
      violations.push({
        rule: 'missing-form',
        path: doc.path,
        detail: 'never documents `claim <issue-number> --release <token>`',
      })
    }
  }

  return violations
}

export function formatParityViolations(violations: ParityViolation[]): string {
  return violations.map((v) => `  [${v.rule}] ${v.path}: ${v.detail}`).join('\n')
}
