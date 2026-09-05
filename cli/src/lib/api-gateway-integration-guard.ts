/**
 * Guard: an env-owned `aws_apigatewayv2_integration` targeting a Lambda that
 * `modules/cloud/aws/api-gateway` also fronts must use the alias-qualified
 * ARN that module's own `aws_lambda_permission` requires — not the raw,
 * unqualified `function_arn` a caller's compute-module instance exposes
 * (biffo-template#1900).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `#1747` narrowed `modules/cloud/aws/api-gateway`'s own
 * `aws_lambda_permission.api_gateway` to `qualifier = local.lambda_alias_name`
 * ("live") and moved the module's own integration to the matching
 * alias-qualified ARN. That is correct for routes the module defines itself.
 *
 * But `core-manifest.json` excludes `infra/environments/<env>/*.tf` from
 * template sync, so instances add THEIR OWN `aws_apigatewayv2_integration`
 * resources on the same API — see `infra/environments/dev/plugin-host.core.tf`
 * for the established, self-consistent pattern of doing this for a Lambda the
 * api-gateway module does NOT front. When an env-owned integration instead
 * targets a Lambda the api-gateway module DOES front (the module instance fed
 * as that module's own `lambda_function_arn` input) via the raw
 * `module.<x>.function_arn`, it inherits zero invoke permission the moment the
 * module's permission is alias-scoped: the module's `aws_lambda_permission`
 * only grants invocations made via the qualified alias ARN, and an unqualified
 * reference is invisible to it. The result is a generic API Gateway 500,
 * indistinguishable at `terraform plan`/`apply` time on EITHER side of the
 * seam — confirmed live in tabsii-platform, where it took down 11
 * unauthenticated public routes until a human noticed.
 *
 * ── Why nothing else catches this ──────────────────────────────────────────
 *
 * `terraform validate`/`plan` on the module passes: its own tftest
 * (`modules/cloud/aws/api-gateway/tests/live_alias_integration.tftest.hcl`)
 * only asserts the MODULE's own integration is correctly qualified.
 * `terraform validate`/`plan` on the env config passes too: an unqualified
 * ARN is a perfectly valid `integration_uri` in isolation. Nothing compares
 * the two, which is exactly the "guard vs authority disagreement" shape
 * (#1362) — the permission's qualifier is authoritative in one file tree, the
 * integration's ARN in another, and neither reads the other.
 *
 * ── What this checks ────────────────────────────────────────────────────────
 *
 * 1. Find every `module "<name>" { source = ".../api-gateway" ... }` block
 *    and read its `lambda_function_arn = module.<x>.function_arn` argument —
 *    that names `<x>` as a Lambda this api-gateway module instance fronts
 *    with an alias-qualified permission ("protected").
 * 2. Find every `aws_apigatewayv2_integration` block's `integration_uri`.
 * 3. Flag any that references a PROTECTED `<x>`'s raw `module.<x>.function_arn`
 *    directly — the exact shape that broke tabsii-platform. An integration
 *    using the module's own `lambda_integration_uri` output, or `<x>`'s own
 *    `live_alias_arn` output (the shape tabsii-platform#1354's actual fix
 *    repointed 8 files to), is correctly qualified and not flagged.
 * 4. Any integration referencing a Lambda `<x>` that is NOT protected (e.g.
 *    `plugin-host.core.tf`'s `module.plugin_host.function_arn`, which carries
 *    its own unqualified `aws_lambda_permission` with no alias involved) is
 *    silently out of scope — this guard is not a blanket "never use
 *    function_arn" rule, only a check that the two sides of THIS seam agree.
 *
 * ── Known scope limits, stated rather than silently accepted ──────────────
 *
 * This is a source-level, regex-over-blocks check, not a full HCL evaluator
 * (same posture as `eventbridge-log-permission-guard.ts`): it resolves
 * `lambda_function_arn = module.<x>.function_arn` and `integration_uri =
 * module.<x>.function_arn` as literal text, so a level of local-variable or
 * ternary indirection between the module block and the reference would not
 * be resolved. That is the same trade-off `eventbridge-log-permission-guard`
 * made and documented for the equivalent gap: a full evaluator would need to
 * be able to run `terraform plan` against arbitrary env configs, which this
 * check exists specifically to catch failures BEFORE either side needs a
 * real AWS account.
 *
 * ── Unresolvable input FAILS, it never silently passes (#1363, #1374) ─────
 *
 * A "0 violations" that comes from scanning nothing is indistinguishable from
 * a real pass unless empty input is a hard failure. Mirroring
 * `eventbridge-log-permission-guard.ts`:
 *
 * 1. **No `.tf` files under `root` at all** throws outright.
 * 2. **Raw-text vs parsed-block blindness**: the raw text is scanned for
 *    literal `resource "aws_apigatewayv2_integration"` / `module "..."`
 *    occurrences independently of the block extractor; if the raw count is
 *    positive but the extractor parsed zero, that is the extractor breaking.
 * 3. **Unterminated blocks are recorded as unresolved, never dropped.**
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.worktrees', 'dist'])

const MODULE_TYPE = 'module'
const INTEGRATION_TYPE = 'aws_apigatewayv2_integration'

export interface ResourceBlock {
  file: string
  line: number
  /** Resource type for a `resource` block, or the literal `"module"` for a
   * `module` block — `name` is the label in either case (the resource name,
   * or the module's own local name). */
  type: string
  name: string
  body: string | null
}

export interface ProtectedLambda {
  /** The compute-module-instance local name whose `function_arn` this
   * api-gateway module instance was given (e.g. `core_api`). */
  functionModuleName: string
  /** The api-gateway module instance's own local name (e.g. `api_gateway`) —
   * `module.<gatewayModuleName>.lambda_integration_uri` is the blessed,
   * correctly-qualified reference other integrations should use instead. */
  gatewayModuleName: string
  file: string
  line: number
}

export interface IntegrationRef {
  file: string
  line: number
  name: string
  integrationUri: string | null
}

export interface ApiGatewayIntegrationViolation {
  file: string
  line: number
  integrationName: string
  targetModuleName: string
  reason: string
}

export interface ApiGatewayIntegrationReport {
  filesScanned: number
  moduleBlocksFound: number
  integrationBlocksFound: number
  protectedLambdas: ProtectedLambda[]
  integrations: IntegrationRef[]
  unterminatedBlocks: ResourceBlock[]
  violations: ApiGatewayIntegrationViolation[]
  moduleBlind: boolean
  integrationBlind: boolean
  ok: boolean
  summary: string
}

function lineNumber(text: string, index: number): number {
  let count = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') count += 1
  }
  return count
}

/** Index of the `}` balancing the `{` at `openIndex`, or `null` if the block
 * never closes before EOF. Plain brace counting — this repo's `.tf` files
 * keep heredocs out of `module` and `aws_apigatewayv2_integration` blocks
 * (verified against `origin/dev`), so a full HCL parser buys nothing a
 * heredoc-aware scanner would not also need to justify. */
function balancedBraceSpan(text: string, openIndex: number): number | null {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

/** Every `resource "<resourceType>" "<name>" { ... }` block in `text`.
 * Unterminated blocks (no matching `}`) are still returned, with `body: null`
 * — callers must not treat that as "no block found". */
export function findResourceBlocks(
  text: string,
  file: string,
  resourceType: string,
): ResourceBlock[] {
  const blocks: ResourceBlock[] = []
  const pattern = new RegExp(`resource\\s+"${resourceType}"\\s+"([\\w-]+)"\\s*\\{`, 'g')
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    const name = m[1] as string
    const line = lineNumber(text, m.index)
    const openIndex = m.index + m[0].length - 1
    const closeIndex = balancedBraceSpan(text, openIndex)
    if (closeIndex === null) {
      blocks.push({ file, line, type: resourceType, name, body: null })
      continue
    }
    blocks.push({
      file,
      line,
      type: resourceType,
      name,
      body: text.slice(openIndex + 1, closeIndex),
    })
  }
  return blocks
}

/** Every `module "<name>" { ... }` block in `text` — same shape as
 * `findResourceBlocks` but for the `module` block syntax, which carries only
 * one label instead of two. */
export function findModuleBlocks(text: string, file: string): ResourceBlock[] {
  const blocks: ResourceBlock[] = []
  const pattern = /module\s+"([\w-]+)"\s*\{/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    const name = m[1] as string
    const line = lineNumber(text, m.index)
    const openIndex = m.index + m[0].length - 1
    const closeIndex = balancedBraceSpan(text, openIndex)
    if (closeIndex === null) {
      blocks.push({ file, line, type: MODULE_TYPE, name, body: null })
      continue
    }
    blocks.push({
      file,
      line,
      type: MODULE_TYPE,
      name,
      body: text.slice(openIndex + 1, closeIndex),
    })
  }
  return blocks
}

/** Raw, unstripped count of `resource "<resourceType>"` (or, for `module`,
 * bare `module "`) occurrences — the blindness backstop's other half,
 * unaffected by any bug in the block scanner above. */
export function countRawResourceDeclarations(text: string, resourceType: string): number {
  const needle = resourceType === MODULE_TYPE ? 'module "' : `resource "${resourceType}"`
  return text.split(needle).length - 1
}

function walkTerraformFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        walk(p)
        continue
      }
      if (entry.endsWith('.tf')) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** Is this module block's `source` the api-gateway module (any relative
 * depth)? Matched on the trailing path segment so both this repo's own
 * `../../../modules/cloud/aws/api-gateway` and a differently-nested instance
 * checkout resolve the same way. */
function isApiGatewaySource(body: string): boolean {
  const m = /source\s*=\s*"([^"]+)"/.exec(body)
  if (!m) return false
  return /(^|\/)modules\/cloud\/aws\/api-gateway\/?$/.test((m[1] as string).trim())
}

/** The compute-module-instance name fed as this api-gateway module's own
 * `lambda_function_arn` input — `module.<name>.function_arn`, the only shape
 * `variables.tf` documents as valid (an already-qualified ARN there would
 * double-qualify). `null` when the argument is missing or shaped some other
 * way (e.g. a local, which this guard cannot resolve — see the module
 * docstring's scope-limit note). */
function protectedFunctionModuleName(body: string): string | null {
  const m = /lambda_function_arn\s*=\s*module\.([\w-]+)\.function_arn\b/.exec(body)
  return m ? (m[1] as string) : null
}

/** The `integration_uri = ...` value of an `aws_apigatewayv2_integration`
 * block body, trimmed of quoting/interpolation wrapper (`"${...}"` or plain
 * `"..."`) — or `null` if the block has no such argument. */
function integrationUriOf(body: string): string | null {
  const m = /integration_uri\s*=\s*(.+)/.exec(body)
  if (!m) return null
  return (m[1] as string)
    .trim()
    .replace(/^"\$\{(.+)\}"$/, '$1')
    .replace(/^"(.+)"$/, '$1')
    .trim()
}

/**
 * Read every `.tf` file under `root`, resolve which compute-module instances
 * an api-gateway module instance fronts with an alias-qualified permission,
 * and report every `aws_apigatewayv2_integration` that targets one of those
 * Lambdas via the raw, unqualified `function_arn` instead of the qualified
 * ARN the permission actually requires. Throws if `root` contains no `.tf`
 * files at all (see module docstring).
 */
export function auditApiGatewayIntegrations(root: string): ApiGatewayIntegrationReport {
  const files = walkTerraformFiles(root)
  if (files.length === 0) {
    throw new Error(
      `auditApiGatewayIntegrations: no .tf files found under ${root} — the guard cannot verify ` +
        'anything against input it cannot see. This is a hard failure, not "0 violations": fix ' +
        'the path, do not treat an empty scan as a clean pass.',
    )
  }

  const moduleBlocks: ResourceBlock[] = []
  const integrationBlocks: ResourceBlock[] = []
  let rawModuleCount = 0
  let rawIntegrationCount = 0

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    rawModuleCount += countRawResourceDeclarations(text, MODULE_TYPE)
    rawIntegrationCount += countRawResourceDeclarations(text, INTEGRATION_TYPE)
    moduleBlocks.push(...findModuleBlocks(text, file))
    integrationBlocks.push(...findResourceBlocks(text, file, INTEGRATION_TYPE))
  }

  const unterminatedBlocks = [...moduleBlocks, ...integrationBlocks].filter((b) => b.body === null)

  const moduleBlind = rawModuleCount > 0 && moduleBlocks.length === 0
  const integrationBlind = rawIntegrationCount > 0 && integrationBlocks.length === 0

  const protectedLambdas: ProtectedLambda[] = []
  for (const block of moduleBlocks) {
    if (block.body === null) continue
    if (!isApiGatewaySource(block.body)) continue
    // _skeletons/sibling-template's own api-gateway module is a DIFFERENT,
    // non-aliased lineage from modules/cloud/aws/api-gateway (confirmed by
    // reading both live at origin/dev for #1900: neither its compute module
    // nor its api-gateway module provisions an alias or a qualified
    // permission — it is self-consistent today and would need its own,
    // separate fix if it ever adopts #1747's alias model). Treating an
    // instantiation of THAT copy as protected would false-positive on any
    // integration referencing it directly, so it is excluded here rather
    // than by accident.
    if (block.file.split('/').includes('_skeletons')) continue
    const functionModuleName = protectedFunctionModuleName(block.body)
    if (functionModuleName === null) continue
    protectedLambdas.push({
      functionModuleName,
      gatewayModuleName: block.name,
      file: block.file,
      line: block.line,
    })
  }
  const protectedNames = new Set(protectedLambdas.map((p) => p.functionModuleName))

  const integrations: IntegrationRef[] = []
  for (const block of integrationBlocks) {
    if (block.body === null) continue
    integrations.push({
      file: block.file,
      line: block.line,
      name: block.name,
      integrationUri: integrationUriOf(block.body),
    })
  }

  const violations: ApiGatewayIntegrationViolation[] = []
  for (const integration of integrations) {
    if (integration.integrationUri === null) continue
    const m = /^module\.([\w-]+)\.function_arn$/.exec(integration.integrationUri)
    if (!m) continue // not a raw function_arn reference — out of scope either way
    const targetModuleName = m[1] as string
    if (!protectedNames.has(targetModuleName)) continue // fronts no alias-qualified permission

    const owner = protectedLambdas.find((p) => p.functionModuleName === targetModuleName)
    violations.push({
      file: integration.file,
      line: integration.line,
      integrationName: integration.name,
      targetModuleName,
      reason:
        `aws_apigatewayv2_integration.${integration.name} targets module.${targetModuleName}` +
        `.function_arn (unqualified), but module.${owner?.gatewayModuleName ?? '<gateway>'} ` +
        `already grants that Lambda's "live" alias — not the unqualified function — invoke ` +
        `access (#1747). This integration will fail closed with a generic API Gateway 500 at ` +
        `runtime, invisible to terraform plan/apply on either side. Use ` +
        `module.${owner?.gatewayModuleName ?? '<gateway>'}.lambda_integration_uri instead ` +
        '(biffo-template#1900).',
    })
  }

  const ok =
    !moduleBlind && !integrationBlind && unterminatedBlocks.length === 0 && violations.length === 0

  const summary =
    `scanned ${files.length} .tf file(s) under ${root}; ${moduleBlocks.length} module block(s) ` +
    `found (${protectedLambdas.length} api-gateway instance(s) fronting an alias-qualified ` +
    `Lambda), ${integrationBlocks.length} ${INTEGRATION_TYPE} block(s) found; ` +
    `${violations.length} mis-qualified, ${unterminatedBlocks.length} unterminated.`

  return {
    filesScanned: files.length,
    moduleBlocksFound: moduleBlocks.length,
    integrationBlocksFound: integrationBlocks.length,
    protectedLambdas,
    integrations,
    unterminatedBlocks,
    violations,
    moduleBlind,
    integrationBlind,
    ok,
    summary,
  }
}

/** `auditApiGatewayIntegrations`, but throwing with full detail on failure —
 * the shape a CI entrypoint or a test's `expect(() => ...).not.toThrow()`
 * wants. */
export function assertApiGatewayIntegrations(root: string): ApiGatewayIntegrationReport {
  const report = auditApiGatewayIntegrations(root)
  if (!report.ok) {
    const lines = [report.summary]
    if (report.moduleBlind) {
      lines.push(
        '  BLIND (module): raw source contains `module "..."` blocks but the block extractor ' +
          'found none — the extractor broke, this is not evidence there are no modules.',
      )
    }
    if (report.integrationBlind) {
      lines.push(
        `  BLIND (${INTEGRATION_TYPE}): raw source contains this resource type but the block ` +
          'extractor found none — the extractor broke, this is not evidence there are no ' +
          'integrations.',
      )
    }
    for (const b of report.unterminatedBlocks) {
      lines.push(
        `  UNTERMINATED ${b.file}:${b.line}  ${b.type} "${b.name}" never closes — cannot ` +
          'verify what it targets or grants.',
      )
    }
    for (const v of report.violations) {
      lines.push(`  MIS-QUALIFIED ${v.file}:${v.line}  ${v.reason}`)
    }
    throw new Error(lines.join('\n'))
  }
  return report
}
