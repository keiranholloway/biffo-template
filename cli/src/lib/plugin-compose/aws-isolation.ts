/**
 * Fail-closed AWS isolation for every process the composition spawns
 * (biffo-template#1522, trap 1). The spike's first run reached REAL AWS: Core's
 * fail-soft EventBridge publish picked up the operator's ambient credentials and
 * a real bus, and the request still returned 201. A mis-wired seam therefore does
 * not fail loudly — so the safe state has to be the default:
 *
 * - every ambient `AWS_*` and `BIFFO_*` variable is DROPPED from the parent env
 *   (a stray `AWS_PROFILE`, `AWS_SESSION_TOKEN`, `AWS_ENDPOINT_URL_EVENTS` — which
 *   botocore ignores under that spelling, the spike found — or a `BIFFO_*` that
 *   would silently re-point Core), then
 * - dummy credentials and the GENERIC `AWS_ENDPOINT_URL` are set, so EVERY boto3
 *   client (events, ssm, s3, lambda, cognito-idp …) lands on the local sink and a
 *   service nobody listed cannot escape.
 */
const DROPPED_PREFIXES = ['AWS_', 'BIFFO_']
const DROPPED_EXACT = new Set(['PYTHONPATH', 'VIRTUAL_ENV', 'PYTHONHOME'])

export function isolatedBaseEnv(
  parentEnv: NodeJS.ProcessEnv,
  sinkUrl: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    if (DROPPED_EXACT.has(key)) continue
    if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) continue
    env[key] = value
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: 'biffodevaccesskey',
    AWS_SECRET_ACCESS_KEY: 'biffodevsecret',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_ENDPOINT_URL: sinkUrl,
  }
}
