import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs so the guard runs on bare node in the Plan job,
// which sets up Terraform and AWS and nothing else. Imported here so the logic
// has one home rather than a TypeScript copy that can drift from it — same
// arrangement as packaged-root-assets.mjs.
import {
  DESTROY_TRAILER,
  STATEFUL_RESOURCE_TYPES,
  checkDestructivePlan,
  parseDestroyTrailer,
} from '../../../scripts/destructive-plan.mjs'

/** A `terraform show -json` resource_changes entry. */
const change = (address: string, type: string, actions: string[]) => ({
  address,
  type,
  change: { actions },
})

const plan = (...changes: unknown[]) => ({ resource_changes: changes })

describe('checkDestructivePlan', () => {
  it('passes a plan that creates and updates only', () => {
    const result = checkDestructivePlan(
      plan(
        change('aws_lambda_function.api', 'aws_lambda_function', ['update']),
        change('aws_db_instance.main', 'aws_db_instance', ['create']),
      ),
    )
    expect(result.destructive).toEqual([])
    expect(result.blocked).toBe(false)
  })

  it('blocks a plain delete of a database', () => {
    const result = checkDestructivePlan(
      plan(change('aws_db_instance.main', 'aws_db_instance', ['delete'])),
    )
    expect(result.blocked).toBe(true)
    expect(result.destructive[0].address).toBe('aws_db_instance.main')
    expect(result.destructive[0].replacement).toBe(false)
  })

  /**
   * The case that actually happens. Nobody runs `terraform destroy` by
   * accident; they change an attribute that forces replacement, far from the
   * resource — `project_name` feeds `identifier`, `db_name` and `username` on
   * aws_db_instance, all three of which force one.
   */
  it('blocks a REPLACEMENT, which destroys the original just as surely', () => {
    const result = checkDestructivePlan(
      plan(change('aws_db_instance.main', 'aws_db_instance', ['delete', 'create'])),
    )
    expect(result.blocked).toBe(true)
    expect(result.destructive[0].replacement).toBe(true)
  })

  it('blocks create_before_destroy, where the actions arrive reversed', () => {
    const result = checkDestructivePlan(
      plan(change('aws_cognito_user_pool.main', 'aws_cognito_user_pool', ['create', 'delete'])),
    )
    expect(result.blocked).toBe(true)
    expect(result.destructive[0].replacement).toBe(true)
  })

  /**
   * The 0.50.0 upgrade, reconstructed: moving alias_attributes ->
   * username_attributes replaces the pool and deletes every user in it. It
   * landed unattended because apply is --auto-approve and nobody read the plan.
   */
  it('blocks the Cognito pool replacement that landed unattended', () => {
    const result = checkDestructivePlan(
      plan(
        change('module.auth.aws_cognito_user_pool.main', 'aws_cognito_user_pool', [
          'delete',
          'create',
        ]),
        change('module.auth.aws_cognito_user_pool_client.web', 'aws_cognito_user_pool_client', [
          'delete',
          'create',
        ]),
      ),
    )
    // The pool is stateful; its client is configuration Terraform rebuilds.
    expect(result.destructive.map((c: { type: string }) => c.type)).toEqual([
      'aws_cognito_user_pool',
    ])
    expect(result.blocked).toBe(true)
  })

  /**
   * The guard must stay narrow. If replacing a Lambda or a security group
   * tripped it, the trailer would be added by reflex on every deploy and the
   * guard would protect nothing.
   */
  it('ignores stateless resources being replaced, however many', () => {
    const result = checkDestructivePlan(
      plan(
        change('aws_lambda_function.api', 'aws_lambda_function', ['delete', 'create']),
        change('aws_security_group.db', 'aws_security_group', ['delete', 'create']),
        change('aws_iam_role.lambda', 'aws_iam_role', ['delete']),
        change('aws_cloudwatch_event_rule.reap', 'aws_cloudwatch_event_rule', ['delete']),
      ),
    )
    expect(result.destructive).toEqual([])
    expect(result.blocked).toBe(false)
  })

  /**
   * #1129. A hosted zone's NS delegation is assigned by AWS at creation and
   * registered at the registrar — it is not in this repo, so a replacement
   * issues new nameservers and recovery is a registrar change plus
   * propagation, not a re-apply. The zone's records are Terraform-managed and
   * would come back on their own; the delegation would not.
   */
  it('blocks a REPLACEMENT of a Route 53 hosted zone', () => {
    const result = checkDestructivePlan(
      plan(change('aws_route53_zone.main[0]', 'aws_route53_zone', ['delete', 'create'])),
    )
    expect(result.blocked).toBe(true)
    expect(result.destructive[0].address).toBe('aws_route53_zone.main[0]')
    expect(result.destructive[0].replacement).toBe(true)
  })

  it('reports every destructive change, not just the first', () => {
    const result = checkDestructivePlan(
      plan(
        change('aws_db_instance.main', 'aws_db_instance', ['delete', 'create']),
        change('aws_s3_bucket.media', 'aws_s3_bucket', ['delete']),
      ),
    )
    expect(result.destructive).toHaveLength(2)
  })

  it('is allowed by an Infra-Destroy trailer, and reports the reason', () => {
    const result = checkDestructivePlan(
      plan(change('aws_db_instance.main', 'aws_db_instance', ['delete', 'create'])),
      'infra: rename the project\n\nInfra-Destroy: dev only, snapshot taken 2026-07-22\n',
    )
    expect(result.blocked).toBe(false)
    expect(result.acknowledgedReason).toBe('dev only, snapshot taken 2026-07-22')
    // Still reported — the trailer excuses the block, not the destruction.
    expect(result.destructive).toHaveLength(1)
  })

  it('handles an empty plan', () => {
    expect(checkDestructivePlan({}).blocked).toBe(false)
    expect(checkDestructivePlan({ resource_changes: [] }).blocked).toBe(false)
  })

  it('covers the resources whose loss is unrecoverable', () => {
    for (const type of [
      'aws_db_instance',
      'aws_cognito_user_pool',
      'aws_s3_bucket',
      'aws_route53_zone',
    ]) {
      expect(STATEFUL_RESOURCE_TYPES).toContain(type)
    }
    // ...and not the ones an apply rebuilds, or the guard becomes noise.
    // aws_acm_certificate is deliberately here: a replacement re-issues and
    // DNS-validates automatically while the zone underneath it stands (#1129).
    for (const type of [
      'aws_lambda_function',
      'aws_iam_role',
      'aws_security_group',
      'aws_acm_certificate',
    ]) {
      expect(STATEFUL_RESOURCE_TYPES).not.toContain(type)
    }
  })
})

describe('parseDestroyTrailer', () => {
  it('requires the trailer on its own line, not mentioned in prose', () => {
    expect(parseDestroyTrailer('chore: discuss Infra-Destroy: maybe later')).toBeNull()
  })

  it('requires a reason', () => {
    expect(parseDestroyTrailer(`x\n\n${DESTROY_TRAILER}:\n`)).toBeNull()
    expect(parseDestroyTrailer(`x\n\n${DESTROY_TRAILER}:   \n`)).toBeNull()
  })

  it('ignores a trailer inside a comment line', () => {
    expect(parseDestroyTrailer(`x\n\n# ${DESTROY_TRAILER}: example from a template\n`)).toBeNull()
  })

  it('trims the reason', () => {
    expect(parseDestroyTrailer(`x\n\n${DESTROY_TRAILER}:   because   \n`)).toBe('because')
  })

  it('finds it among several commits in one push', () => {
    const messages = [
      'fix: unrelated\n',
      `infra: rebuild the pool\n\n${DESTROY_TRAILER}: replacing the user pool, users re-invited\n`,
      'docs: note it\n',
    ].join('\n')
    expect(parseDestroyTrailer(messages)).toBe('replacing the user pool, users re-invited')
  })
})
