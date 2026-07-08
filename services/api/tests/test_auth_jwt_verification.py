"""Real RS256 verification path (middleware.auth._verify_token).

The other auth tests monkeypatch `_verify_token` away, so this is the one place
the actual signature/JWKS/audience checking is exercised — it signs a token with
a throwaway RSA key, publishes the matching JWK, and verifies the round-trip.
This is the safety net for the python-jose → PyJWT migration (PYSEC-2026-1325 /
dropping the vulnerable ecdsa dependency): the library only *verifies* RS256
Cognito JWTs, never signs.
"""

import json

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jwt.algorithms import RSAAlgorithm

import api.middleware.auth as auth_module
from api.middleware.auth import _verify_token

_KID = "test-key-1"
_AUD = "test-client-id"


@pytest.fixture
def signing_key(monkeypatch):
    """A throwaway RSA key whose public JWK is published as the pool's JWKS."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = _KID
    monkeypatch.setattr(
        auth_module.settings, "cognito_jwks_json", json.dumps({"keys": [jwk]})
    )
    monkeypatch.setattr(auth_module.settings, "cognito_client_id", _AUD)
    auth_module._get_jwks.cache_clear()
    yield key
    auth_module._get_jwks.cache_clear()


def _token(key, *, kid: str = _KID, **claims) -> str:
    payload = {"sub": "user-1", "aud": _AUD, "cognito:groups": ["admin"], **claims}
    return jwt.encode(payload, key, algorithm="RS256", headers={"kid": kid})


def test_verifies_a_valid_rs256_token(signing_key):
    claims = _verify_token(_token(signing_key))
    assert claims["sub"] == "user-1"
    assert claims["aud"] == _AUD
    assert claims["cognito:groups"] == ["admin"]


def test_rejects_wrong_audience(signing_key):
    token = _token(signing_key, aud="a-different-client")
    with pytest.raises(HTTPException) as exc:
        _verify_token(token)
    assert exc.value.status_code == 401


def test_rejects_a_tampered_signature(signing_key):
    token = _token(signing_key)
    header, payload, sig = token.split(".")
    forged = f"{header}.{payload}.{sig[:-4]}AAAA"
    with pytest.raises(HTTPException) as exc:
        _verify_token(forged)
    assert exc.value.status_code == 401


def test_rejects_a_token_signed_by_another_key(signing_key):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(HTTPException) as exc:
        _verify_token(_token(other))  # kid matches, signature won't
    assert exc.value.status_code == 401


def test_rejects_an_unknown_kid(signing_key):
    with pytest.raises(HTTPException) as exc:
        _verify_token(_token(signing_key, kid="not-in-jwks"))
    assert exc.value.status_code == 401
    assert exc.value.detail == "Unknown signing key"


def test_rejects_a_malformed_token(signing_key):
    with pytest.raises(HTTPException) as exc:
        _verify_token("not-a-jwt")
    assert exc.value.status_code == 401
    assert exc.value.detail == "Malformed token"
