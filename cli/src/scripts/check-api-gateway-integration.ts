/**
 * CI entrypoint for the api-gateway integration-qualifier guard
 * (biffo-template#1900): fail when an env-owned `aws_apigatewayv2_integration`
 * targets a Lambda's raw, unqualified `function_arn` when that same Lambda is
 * fronted by a `modules/cloud/aws/api-gateway` instance whose
 * `aws_lambda_permission` is scoped to the alias-qualified ARN (#1747).
 * `terraform validate`/`plan` pass on both sides of this seam in isolation —
 * see `api-gateway-integration-guard.ts`'s module doc comment for why nothing
 * else catches it, and for the tabsii-platform incident (11 public routes,
 * 500ing) this class produced in the wild.
 *
 * Scoped to the whole repo (from the git root): this repo's own
 * `infra/environments/*` is the reference config every `biffo init` scaffolds
 * from, so it is exactly the tree a fresh instance's env-owned integrations
 * are copied from — a violation here would propagate to every new instance.
 * An existing instance runs this same check from the published package
 * (`npx @biffo/cli check api-gateway-integration`) against its OWN tree,
 * which is where tabsii-platform's actual incident would have been caught.
 */
import { execa } from '../lib/exec.js'
import { auditApiGatewayIntegrations } from '../lib/api-gateway-integration-guard.js'

export async function runApiGatewayIntegrationCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  let report: ReturnType<typeof auditApiGatewayIntegrations>
  try {
    report = auditApiGatewayIntegrations(root)
  } catch (err) {
    // No .tf files at all under root — a hard failure, not "0 violations"
    // (see the module doc comment's blindness section).
    console.error('✗ API Gateway integration-qualifier guard: could not run\n')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // Denominator first, unconditionally — a green run that never says how much
  // it looked at is indistinguishable from one that looked at nothing.
  console.log(`scanned ${report.filesScanned} .tf file(s) under ${root}`)

  if (!report.ok) {
    console.error('✗ API Gateway integration-qualifier guard: mis-qualified integration(s) found\n')
    if (report.moduleBlind) {
      console.error(
        '  BLIND (module): raw source contains `module "..."` blocks but the block extractor ' +
          'found none — the extractor broke, this is not evidence there are no modules.',
      )
    }
    if (report.integrationBlind) {
      console.error(
        '  BLIND (aws_apigatewayv2_integration): raw source contains this resource type but ' +
          'the block extractor found none — the extractor broke, this is not evidence there ' +
          'are no integrations.',
      )
    }
    for (const b of report.unterminatedBlocks) {
      console.error(
        `  UNTERMINATED ${b.file}:${b.line}  ${b.type} "${b.name}" never closes — cannot ` +
          'verify what it targets or grants.',
      )
    }
    for (const v of report.violations) {
      console.error(`  MIS-QUALIFIED ${v.file}:${v.line}  ${v.reason}`)
    }
    console.error('\nSee biffo-template#1900.')
    process.exit(1)
  }

  console.log(`✓ API Gateway integration-qualifier guard: ${report.summary}`)
}
