import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Properties a scaffolding skeleton must not silently lose.
 *
 * ## Why this exists
 *
 * This repo repeatedly fixes something for itself and not for the trees it
 * generates. Five instances surfaced in one day:
 *
 * - the dependency-audit hardening of #591/#592/#636 landed in the root
 *   `ci.yml` and never reached either skeleton (#743)
 * - `_resolve_static_dir` was fixed in one plugin and never propagated to the
 *   next (biffo-plugin-idea-scout#22)
 * - the `biffo-add-service` skill described manual steps the CLI had automated
 *   three and a half weeks earlier
 * - #649/#650/#651 — skeleton defects that shipped into every generated repo
 * - #714/#715 — governance applied at creation, never backfilled
 *
 * Nothing detected any of them. A skeleton is only exercised when someone
 * scaffolds from it, so drift is invisible for as long as nobody does — and by
 * then it has shipped into every repo created in the meantime.
 *
 * ## What this deliberately does NOT assert
 *
 * **Not configuration equality.** It is tempting to assert the skeletons' ruff
 * `select` matches the root's, and it would be wrong. The sibling skeleton
 * carries `ANN` where the root does not, and that is a legitimate choice: a
 * sibling is a standalone repo that never lands in the instance's tree, so it
 * may be stricter. The plugin skeleton dropped `ANN` for the opposite reason —
 * it *is* vendored, so it must match the tree it lands in (#650). Same field,
 * two correct-but-different values.
 *
 * The same trap caught a second time while writing this: the sibling skeleton
 * uses `x: T = Depends(...)` without the root's `extend-immutable-calls`
 * carve-out, which looks like the #650 defect exactly. Ruff special-cases
 * FastAPI route handlers, so `B008` never fires and `ruff check` passes. An
 * equality assertion would have reported a defect that does not exist.
 *
 * So every rule here is a property whose violation has been **observed to
 * break something**, and each names the issue that proves it.
 */

/** One thing a skeleton must be true of, and the evidence it matters. */
export interface SkeletonRule {
  id: string
  /** Why violating it breaks a generated repo. */
  rationale: string
  /** Files this applies to, relative to the skeleton root. */
  appliesTo: (relPath: string) => boolean
  /** Returns a violation message, or null when the file is fine. */
  check: (relPath: string, contents: string) => string | null
}

export interface SkeletonViolation {
  skeleton: string
  file: string
  rule: string
  detail: string
}

const isWorkflow = (rel: string): boolean =>
  rel.startsWith('.github/workflows/') && (rel.endsWith('.yml') || rel.endsWith('.yaml'))

export const SKELETON_RULES: SkeletonRule[] = [
  {
    id: 'runner-label',
    rationale:
      'A hardcoded `ubuntu-latest` bills GitHub-hosted minutes and fails immediately on an ' +
      'account over its spending limit, which is the state this project is in — so a generated ' +
      'repo cannot reach the self-hosted fleet at all (#651).',
    appliesTo: isWorkflow,
    check: (_rel, contents) => {
      const hardcoded = [...contents.matchAll(/^\s*runs-on:\s*(.+)$/gm)]
        .map((m) => m[1]!.trim())
        .filter((v) => !v.includes('RUNNER_LABEL'))
      return hardcoded.length > 0
        ? `${hardcoded.length} job(s) pin a runner directly instead of \`\${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}\`: ${[...new Set(hardcoded)].join(', ')}`
        : null
    },
  },
  {
    id: 'no-gitleaks-action',
    rationale:
      'gitleaks/gitleaks-action@v2 cannot pass here for two independent reasons: its SARIF ' +
      'upload assumes a GitHub-hosted $HOME layout and dies on self-hosted runners, and it ' +
      'requires a paid licence for organization-owned repos. Every generated repo was born ' +
      'with a permanently red Secret Scan (#649).',
    appliesTo: isWorkflow,
    check: (_rel, contents) =>
      /^\s*(-\s*)?uses:\s*gitleaks\/gitleaks-action/m.test(contents)
        ? 'uses gitleaks/gitleaks-action; install the free CLI directly, as the root ci.yml does'
        : null,
  },
]

/** Every file in a tree, as `/`-separated paths relative to its root. */
function walk(dir: string, base: string = dir): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    // .venv/node_modules are build artefacts, not part of what gets copied.
    if (entry === '.venv' || entry === 'node_modules' || entry === '.git') continue
    const abs = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...walk(abs, base))
    else
      out.push(
        abs
          .slice(base.length + 1)
          .split('\\')
          .join('/'),
      )
  }
  return out
}

/**
 * Audit one skeleton against every rule.
 *
 * @param skeletonRoot absolute path to `_skeletons/<name>`
 * @param name the skeleton's directory name, for reporting
 */
export function auditSkeleton(
  skeletonRoot: string,
  name: string,
  rules: SkeletonRule[] = SKELETON_RULES,
): SkeletonViolation[] {
  const violations: SkeletonViolation[] = []
  for (const rel of walk(skeletonRoot)) {
    for (const rule of rules) {
      if (!rule.appliesTo(rel)) continue
      let contents: string
      try {
        contents = readFileSync(join(skeletonRoot, rel), 'utf8')
      } catch {
        continue
      }
      const detail = rule.check(rel, contents)
      if (detail !== null) {
        violations.push({ skeleton: name, file: rel, rule: rule.id, detail })
      }
    }
  }
  return violations
}

/** Human-readable report, carrying each rule's rationale so the fix is obvious. */
export function formatViolations(violations: SkeletonViolation[]): string {
  const byRule = new Map<string, SkeletonViolation[]>()
  for (const v of violations) {
    byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v])
  }
  const lines: string[] = []
  for (const [ruleId, group] of byRule) {
    const rule = SKELETON_RULES.find((r) => r.id === ruleId)
    lines.push(`  ${ruleId}:`)
    for (const v of group) lines.push(`    ${v.skeleton}/${v.file} — ${v.detail}`)
    if (rule) lines.push(`    why: ${rule.rationale}`)
  }
  return lines.join('\n')
}
