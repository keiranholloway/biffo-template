"""Behaviour of the shared Cognito verifier.

Signs tokens with throwaway RSA keys and publishes the matching JWK, exercising
the real RS256/JWKS/audience path — the same shape as Core's
`test_auth_jwt_verification.py`, plus the remote-fetch cache-bust-and-retry that
the baked-JWKS test in Core could not reach.
"""

from __future__ import annotations

import json

import biffo_cognito_auth.verifier as verifier_module
import jwt
import pytest
from biffo_cognito_auth import (
    MalformedTokenError,
    TokenVerificationError,
    UnknownSigningKeyError,
    verify_cognito_jwt,
)
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

_KID = "test-key-1"
_AUD = "test-client-id"
_POOL = "us-east-1_pool"
_REGION = "us-east-1"


def _keypair(kid: str = _KID):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = kid
    return key, jwk


def _jwks(*jwks) -> str:
    return json.dumps({"keys": list(jwks)})


def _token(key, *, kid: str = _KID, **claims) -> str:
    payload = {"sub": "user-1", "aud": _AUD, "cognito:groups": ["admin"], **claims}
    return jwt.encode(payload, key, algorithm="RS256", headers={"kid": kid})


def _verify(token: str, *, jwks_json: str | None) -> dict:
    return verify_cognito_jwt(
        token,
        user_pool_id=_POOL,
        region=_REGION,
        client_id=_AUD,
        jwks_json=jwks_json,
    )


@pytest.fixture(autouse=True)
def _clear_cache():
    verifier_module._fetch_jwks.cache_clear()
    yield
    verifier_module._fetch_jwks.cache_clear()


# ── Baked-JWKS path (jwks_json supplied) ─────────────────────────────────────


def test_verifies_a_valid_rs256_token_from_baked_jwks():
    key, jwk = _keypair()
    claims = _verify(_token(key), jwks_json=_jwks(jwk))
    assert claims["sub"] == "user-1"
    assert claims["aud"] == _AUD
    assert claims["cognito:groups"] == ["admin"]


def test_rejects_wrong_audience():
    key, jwk = _keypair()
    with pytest.raises(TokenVerificationError):
        _verify(_token(key, aud="a-different-client"), jwks_json=_jwks(jwk))


def test_rejects_an_expired_token():
    key, jwk = _keypair()
    with pytest.raises(TokenVerificationError):
        # `exp` in the past — PyJWT rejects it during decode.
        _verify(_token(key, exp=1), jwks_json=_jwks(jwk))


def test_rejects_a_tampered_signature():
    key, jwk = _keypair()
    header, payload, sig = _token(key).split(".")
    forged = f"{header}.{payload}.{sig[:-4]}AAAA"
    with pytest.raises(TokenVerificationError):
        _verify(forged, jwks_json=_jwks(jwk))


def test_rejects_a_token_signed_by_another_key():
    _key, jwk = _keypair()
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(TokenVerificationError):
        _verify(_token(other), jwks_json=_jwks(jwk))  # kid matches, signature won't


def test_rejects_an_unknown_kid_without_retry_on_the_baked_path():
    key, jwk = _keypair()
    with pytest.raises(UnknownSigningKeyError):
        _verify(_token(key, kid="not-in-jwks"), jwks_json=_jwks(jwk))


def test_rejects_a_malformed_token():
    key, jwk = _keypair()
    with pytest.raises(MalformedTokenError):
        _verify("not-a-jwt", jwks_json=_jwks(jwk))


# ── Remote path (no baked JWKS): fetch + kid-rotation cache-bust-and-retry ────


def test_fetches_jwks_remotely_and_caches_it(monkeypatch):
    key, jwk = _keypair()
    calls = {"n": 0}

    def fake_get(url, timeout):
        calls["n"] += 1
        return httpx_response(_jwks(jwk))

    monkeypatch.setattr(verifier_module.httpx, "get", fake_get)

    assert _verify(_token(key), jwks_json=None)["sub"] == "user-1"
    assert _verify(_token(key), jwks_json=None)["sub"] == "user-1"
    # Resolved once for the warm process, not on every call.
    assert calls["n"] == 1


def test_unknown_kid_busts_the_cache_and_retries_then_succeeds(monkeypatch):
    """The pool rotated: the first (cached) fetch lacks the new kid, the retry
    after cache-bust sees the rotated JWKS and verifies."""
    old_key, old_jwk = _keypair(kid="old-kid")
    new_key, new_jwk = _keypair(kid="new-kid")
    responses = [_jwks(old_jwk), _jwks(old_jwk, new_jwk)]
    calls = {"n": 0}

    def fake_get(url, timeout):
        body = responses[min(calls["n"], len(responses) - 1)]
        calls["n"] += 1
        return httpx_response(body)

    monkeypatch.setattr(verifier_module.httpx, "get", fake_get)

    claims = _verify(_token(new_key, kid="new-kid"), jwks_json=None)
    assert claims["sub"] == "user-1"
    # One initial fetch + one after the cache-bust.
    assert calls["n"] == 2


def test_unknown_kid_retries_once_then_fails(monkeypatch):
    old_key, old_jwk = _keypair(kid="old-kid")
    calls = {"n": 0}

    def fake_get(url, timeout):
        calls["n"] += 1
        return httpx_response(_jwks(old_jwk))

    monkeypatch.setattr(verifier_module.httpx, "get", fake_get)

    with pytest.raises(UnknownSigningKeyError):
        _verify(_token(old_key, kid="never-appears"), jwks_json=None)
    # Fetched, missed, busted, refetched, missed again — exactly one retry.
    assert calls["n"] == 2


# ── Error messages never leak the token ──────────────────────────────────────


def test_error_message_does_not_contain_the_token():
    key, jwk = _keypair()
    token = _token(key, aud="wrong")
    with pytest.raises(TokenVerificationError) as exc:
        _verify(token, jwks_json=_jwks(jwk))
    assert token not in str(exc.value)


class _Resp:
    def __init__(self, body: str) -> None:
        self._body = body

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return json.loads(self._body)


def httpx_response(body: str) -> _Resp:
    """A minimal stand-in for the httpx.Response the verifier reads (`.json()` +
    `.raise_for_status()`), so the remote path needs no real network."""
    return _Resp(body)
