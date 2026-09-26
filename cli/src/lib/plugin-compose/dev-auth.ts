import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'

/**
 * The dev-mode identity provider for the local composition (biffo-template#1522's
 * spike, #1525): an RSA keypair generated per run, its public half published as a
 * baked JWKS (`BIFFO_COGNITO_JWKS_JSON`) that BOTH Core and the plugin host's
 * authorizer already accept — the no-NAT-dev path — so neither needed a change.
 * Tokens are signed RS256 with `kid`, `aud=<client id>` and `cognito:groups`,
 * exactly the claims `verify_cognito_jwt` reads. Nothing here is trusted by any
 * real deployment: the key exists only for the life of one composition.
 */
export const DEV_POOL_ID = 'us-east-1_BIFFODEV1'
export const DEV_CLIENT_ID = 'biffodevclientid'
export const DEV_REGION = 'us-east-1'
const KID = 'biffo-dev-key'

export interface DevKeypair {
  privateKeyPem: string
  jwksJson: string
}

export function generateDevKeypair(): DevKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    jwksJson: JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }),
  }
}

export interface MintOptions {
  groups?: string[]
  sub?: string
  /** Seconds; negative mints an already-expired token (a control input). */
  ttlSeconds?: number
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url')

export function mintDevToken(privateKeyPem: string, opts: MintOptions = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const sub = opts.sub ?? '00000000-0000-4000-8000-000000000001'
  const claims: Record<string, unknown> = {
    sub,
    aud: DEV_CLIENT_ID,
    iss: `https://cognito-idp.${DEV_REGION}.amazonaws.com/${DEV_POOL_ID}`,
    token_use: 'id',
    'cognito:username': sub,
    email: `${sub}@example.invalid`,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 3600),
  }
  if (opts.groups && opts.groups.length > 0) claims['cognito:groups'] = opts.groups
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.${b64url(JSON.stringify(claims))}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), createPrivateKey(privateKeyPem))
  return `${signingInput}.${b64url(signature)}`
}

/** The env both Core and the plugin host read to trust the minted tokens. */
export function cognitoEnv(jwksJson: string): Record<string, string> {
  return {
    BIFFO_COGNITO_JWKS_JSON: jwksJson,
    BIFFO_COGNITO_USER_POOL_ID: DEV_POOL_ID,
    BIFFO_COGNITO_CLIENT_ID: DEV_CLIENT_ID,
    BIFFO_COGNITO_REGION: DEV_REGION,
  }
}
