"""The SDK's self-contained Cognito verifier (_cognito), a mirror of
biffo_cognito_auth. The RS256 happy path is covered by that package's own tests
(identical logic); here we pin the non-crypto branches that guard the SDK copy."""

from __future__ import annotations

import json

import pytest
from biffo_plugin_sdk._cognito import (
    MalformedTokenError,
    UnknownSigningKeyError,
    verify_cognito_jwt,
)


def test_a_non_jwt_is_malformed():
    with pytest.raises(MalformedTokenError):
        verify_cognito_jwt("not-a-jwt", user_pool_id="pool", region="eu-west-1", client_id="client")


def test_a_baked_jwks_with_no_matching_kid_is_unknown_key():
    # A well-formed (unsigned-header) token whose kid is absent from the baked
    # JWKS: verification stops at key lookup, before any network or crypto, and a
    # baked JWKS is never re-fetched.
    import jwt

    token = jwt.encode({"sub": "x"}, "secret", algorithm="HS256", headers={"kid": "missing"})
    baked = json.dumps({"keys": [{"kid": "other", "kty": "RSA"}]})
    with pytest.raises(UnknownSigningKeyError):
        verify_cognito_jwt(
            token,
            user_pool_id="pool",
            region="eu-west-1",
            client_id="client",
            jwks_json=baked,
        )
