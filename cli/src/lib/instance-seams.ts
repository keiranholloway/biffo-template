import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Detects a `biffo core upgrade` introducing a new ADR-0028 `@/instance-*` seam
 * the instance has not declared (#1188).
 *
 * ## The shape of the bug this closes
 *
 * An ADR-0028 seam has three template-owned parts — a contract module, a
 * generic default, and a `tsconfig.json` `paths` entry pointing `@/instance-<name>`
 * at that default — plus an optional instance-owned declaration,
 * `src/instance-<name>.ts`, that the portal's bundler prefers when present (see
 * `apps/portal/next.config.ts`'s `instanceSeams` array). Introducing a new seam
 * is a **silent behaviour change for every existing instance**: `core upgrade`
 * carries the contract and default in, the instance has no declaration (and
 * cannot pre-land one — the contract does not exist yet, so the file would not
 * compile), and the instance's behaviour silently becomes whatever the generic
 * default does. Nothing fails: the template's tests pass because the default is
 * right *for the template*, and the instance's tests pass because they were
 * written against the behaviour the upgrade just changed.
 *
 * ## Why this reads `tsconfig.json`'s `paths`, not a hardcoded seam list
 *
 * `tsconfig.json` is the one place every seam is *already* registered — it is
 * what `apps/portal/src/lib/instance-seam-resolvers.test.ts` treats as the
 * source of truth for the OTHER two resolvers (`next.config.ts`,
 * `vitest.config.ts`) to agree with. A hardcoded list here (`'login-destinations'`,
 * `'nav'`, ...) would itself drift the next time a seam is added — the exact
 * failure mode #1188 exists to close, one level further out. Deriving from the
 * `paths` object the upgrade is already carrying means the seam list is always
 * exactly what this upgrade introduces, with nothing to keep in sync by hand.
 *
 * ## Why "new" is relative to `base`, not merely "undeclared"
 *
 * An instance that has never declared `@/instance-nav` because it never needed
 * one is not a regression — that seam existed at the instance's current version
 * too, so nothing about this upgrade changed the instance's exposure to it.
 * Only a specifier absent from `base`'s `tsconfig.json` and present in
 * `theirs`'s is something THIS upgrade is introducing, which is the only case
 * where "the instance's behaviour silently changes" is actually true of this
 * run. This also makes a same-version diff (no seam changes at all) a true
 * no-op: identical `base`/`theirs` seam sets always yield nothing to report,
 * however many old, long-undeclared seams the instance carries.
 */
export interface InstanceSeam {
  /** The `@/instance-*` specifier this upgrade introduces, e.g. `@/instance-login-destinations`. */
  specifier: string
  /** Repo-relative (posix) path of the file the instance must add to declare
   * this seam, e.g. `apps/portal/src/instance-login-destinations.ts`. Derived
   * from the specifier itself — `@/instance-<name>` names `src/instance-<name>.ts`
   * — the same convention `next.config.ts`'s `instanceSeams` array and
   * `instance-seam-resolvers.test.ts` already assume. */
  instanceFile: string
  /** Repo-relative (posix) path of the template-owned default this seam
   * resolves to until the instance file exists — `tsconfig.json`'s own fallback
   * target for the specifier. */
  defaultFile: string
}

interface TsconfigPathsShape {
  compilerOptions?: { paths?: Record<string, string[]> }
}

const INSTANCE_SEAM_PREFIX = '@/instance-'

/**
 * Read the `@/instance-*` seams a template tree's portal `tsconfig.json`
 * registers, keyed by specifier. Never throws: a tree with no portal, no
 * tsconfig, or an unparseable one (a template version that predates ADR-0028,
 * or an explicit tree override that is not a full checkout) simply registers
 * no seams — the same fail-open posture `listTemplateOwnedFiles` takes for a
 * tree git cannot answer a tracked-files question about.
 */
function readSeams(templateDir: string, portalRelDir: string): Map<string, InstanceSeam> {
  const seams = new Map<string, InstanceSeam>()
  const tsconfigPath = join(templateDir, portalRelDir, 'tsconfig.json')
  if (!existsSync(tsconfigPath)) return seams

  let parsed: TsconfigPathsShape
  try {
    parsed = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as TsconfigPathsShape
  } catch {
    return seams
  }

  for (const [specifier, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
    if (!specifier.startsWith(INSTANCE_SEAM_PREFIX)) continue
    const target = targets[0]
    if (target === undefined) continue
    const name = specifier.slice('@/'.length)
    seams.set(specifier, {
      specifier,
      instanceFile: `${portalRelDir}/src/${name}.ts`,
      defaultFile: `${portalRelDir}/${target.replace(/^\.\//, '')}`,
    })
  }
  return seams
}

/**
 * Seams `theirs` introduces that `base` did not have, and that the instance has
 * not declared. See the module docstring for why "new relative to base" and
 * "read from tsconfig.json" are both load-bearing.
 *
 * `oursDir` is checked with a plain `existsSync`, not a tracked-files filter
 * (unlike the #1026 orphan report): a declaration the instance is about to add
 * on the very upgrade branch this check runs against need not be committed yet
 * for the check to see it, and an instance that already has the file — however
 * it got there — has already done the thing this check exists to demand.
 */
export function findNewUndeclaredSeams(
  baseDir: string,
  theirsDir: string,
  oursDir: string,
  portalRelDir = 'apps/portal',
): InstanceSeam[] {
  const baseSeams = readSeams(baseDir, portalRelDir)
  const theirsSeams = readSeams(theirsDir, portalRelDir)

  const undeclared: InstanceSeam[] = []
  for (const [specifier, seam] of theirsSeams) {
    if (baseSeams.has(specifier)) continue // not new — existed at the instance's current version too
    if (existsSync(join(oursDir, seam.instanceFile))) continue // already declared
    undeclared.push(seam)
  }
  return undeclared.sort((a, b) => a.specifier.localeCompare(b.specifier))
}
