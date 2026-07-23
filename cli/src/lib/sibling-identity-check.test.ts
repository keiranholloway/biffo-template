import { describe, expect, it } from 'vitest'
import { checkSiblingIdentity, type IdentityCheckEnvInput } from './sibling-identity-check.js'

const LIVE = 'eu-west-1_LIVEPOOL'

describe('checkSiblingIdentity', () => {
  it('is ok with no findings when the document and every sibling match the live pool', () => {
    const envs: IdentityCheckEnvInput[] = [
      {
        environment: 'dev',
        livePoolId: LIVE,
        publishedDoc: { userPoolId: LIVE },
        siblings: [
          { projectName: 'crm', coreCognitoUserPoolId: LIVE },
          { projectName: 'billing', coreCognitoUserPoolId: LIVE },
        ],
      },
    ]

    expect(checkSiblingIdentity(envs)).toEqual({ ok: true, findings: [] })
  })

  it('flags an unreachable published document', () => {
    const { ok, findings } = checkSiblingIdentity([
      { environment: 'dev', livePoolId: LIVE, publishedDoc: null, siblings: [] },
    ])

    expect(ok).toBe(false)
    expect(findings).toEqual([
      {
        environment: 'dev',
        subject: 'published-document',
        kind: 'published-doc-unreachable',
        expected: LIVE,
        actual: null,
      },
    ])
  })

  it('flags a stale published document (fetched but wrong pool)', () => {
    const { ok, findings } = checkSiblingIdentity([
      {
        environment: 'dev',
        livePoolId: LIVE,
        publishedDoc: { userPoolId: 'eu-west-1_OLDPOOL' },
        siblings: [],
      },
    ])

    expect(ok).toBe(false)
    expect(findings).toEqual([
      {
        environment: 'dev',
        subject: 'published-document',
        kind: 'published-doc-stale',
        expected: LIVE,
        actual: 'eu-west-1_OLDPOOL',
      },
    ])
  })

  it('treats a document missing userPoolId as stale with a null actual', () => {
    const { findings } = checkSiblingIdentity([
      { environment: 'dev', livePoolId: LIVE, publishedDoc: {}, siblings: [] },
    ])

    expect(findings).toEqual([
      {
        environment: 'dev',
        subject: 'published-document',
        kind: 'published-doc-stale',
        expected: LIVE,
        actual: null,
      },
    ])
  })

  it('flags a sibling whose CORE_COGNITO_USER_POOL_ID is unset (missing)', () => {
    const { ok, findings } = checkSiblingIdentity([
      {
        environment: 'dev',
        livePoolId: LIVE,
        publishedDoc: { userPoolId: LIVE },
        siblings: [{ projectName: 'crm', coreCognitoUserPoolId: null }],
      },
    ])

    expect(ok).toBe(false)
    expect(findings).toEqual([
      {
        environment: 'dev',
        subject: 'crm',
        kind: 'sibling-var-missing',
        expected: LIVE,
        actual: null,
      },
    ])
  })

  it('flags a sibling backend baked to a pool the core replaced (stale)', () => {
    const { ok, findings } = checkSiblingIdentity([
      {
        environment: 'dev',
        livePoolId: LIVE,
        publishedDoc: { userPoolId: LIVE },
        siblings: [{ projectName: 'crm', coreCognitoUserPoolId: 'eu-west-1_OLDPOOL' }],
      },
    ])

    expect(ok).toBe(false)
    expect(findings).toEqual([
      {
        environment: 'dev',
        subject: 'crm',
        kind: 'sibling-backend-stale',
        expected: LIVE,
        actual: 'eu-west-1_OLDPOOL',
      },
    ])
  })

  it('reports findings per environment against each environment’s own live pool', () => {
    const { ok, findings } = checkSiblingIdentity([
      {
        environment: 'dev',
        livePoolId: 'eu-west-1_DEV',
        publishedDoc: { userPoolId: 'eu-west-1_DEV' },
        siblings: [{ projectName: 'crm', coreCognitoUserPoolId: 'eu-west-1_DEV' }],
      },
      {
        environment: 'prod',
        livePoolId: 'eu-west-1_PROD',
        publishedDoc: { userPoolId: 'eu-west-1_OLDPROD' }, // stale in prod only
        siblings: [{ projectName: 'crm', coreCognitoUserPoolId: null }], // missing in prod only
      },
    ])

    expect(ok).toBe(false)
    expect(findings).toEqual([
      {
        environment: 'prod',
        subject: 'published-document',
        kind: 'published-doc-stale',
        expected: 'eu-west-1_PROD',
        actual: 'eu-west-1_OLDPROD',
      },
      {
        environment: 'prod',
        subject: 'crm',
        kind: 'sibling-var-missing',
        expected: 'eu-west-1_PROD',
        actual: null,
      },
    ])
  })

  it('reports the document finding before sibling findings for a given env', () => {
    const { findings } = checkSiblingIdentity([
      {
        environment: 'dev',
        livePoolId: LIVE,
        publishedDoc: null,
        siblings: [{ projectName: 'crm', coreCognitoUserPoolId: 'eu-west-1_OLDPOOL' }],
      },
    ])

    expect(findings.map((f) => f.subject)).toEqual(['published-document', 'crm'])
  })
})
