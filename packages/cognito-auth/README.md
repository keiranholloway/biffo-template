# biffo-cognito-auth

Shared, pure Cognito JWT verification for Biffo.

`verify_cognito_jwt(token, *, user_pool_id, region, client_id, jwks_json=None)`
verifies a Cognito **RS256** access/ID token and returns its claims. It carries
the full behaviour the Core API relied on when this logic lived inline in
`services/api/src/api/middleware/auth.py`:

- **Baked-JWKS path** — when `jwks_json` is provided (the no-NAT dev
  environment, where Terraform bakes the JWKS in at apply time), the keys are
  read from it and no outbound call is made.
- **JWKS-by-`kid`** — the signing key is matched from the pool's JWKS by the
  token header's `kid`.
- **Kid-rotation cache-bust-and-retry-once** — on a remote (non-baked) fetch, an
  unknown `kid` busts the JWKS cache and retries once, since the pool may have
  rotated its keys.
- **RS256, audience = `client_id`** — the signature and `aud` claim are verified;
  expiry and the other standard claims are enforced by PyJWT.

## Why a standalone package

Both the Core API and the agent runtime need to verify a caller's Cognito JWT
(ADR-0016 §7's Function URL ingress). This is a **foundation** library: it
depends on `pyjwt` and `httpx` only, and on nothing else in the monorepo, so
both consumers depend *on* it and it depends on neither. It is **not** part of
`biffo-plugin-sdk` — the SDK is the plugin→Core contract, and having Core import
from it would invert the dependency direction.

It imports **no database client and no web framework**: verification is pure
(JWKS-over-HTTP at most), so it is safe to import outside `services/api/`
(ADR-0002 / Ruff `TID251`). Callers translate its exceptions onto their own
transport — e.g. Core maps `CognitoJWTError` to an HTTP 401.

## Exceptions

All derive from `CognitoJWTError`, and `str(exc)` is always a safe, caller-facing
reason (a fixed string or provider output) — never the token or a key:

- `MalformedTokenError` — the token is not a well-formed JWT.
- `UnknownSigningKeyError` — no JWKS key matched the `kid`, even after retry.
- `TokenVerificationError` — signature, audience, expiry, or another claim check
  failed.
