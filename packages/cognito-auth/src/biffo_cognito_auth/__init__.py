"""Shared, pure Cognito JWT verification (ADR-0016 §7).

Both the Core API (`services/api/src/api/middleware/auth.py`) and the agent
runtime verify a caller's Cognito RS256 JWT. This package is the single
implementation both import: a foundation library depending on ``pyjwt`` and
``httpx`` only, and on nothing else in the monorepo. It carries **no** database
client and **no** web framework, so it is pure and safe to import outside
``services/api/`` (ADR-0002 / Ruff ``TID251``). Callers map its exceptions onto
their own transport (Core → an HTTP 401).
"""

from __future__ import annotations

from .verifier import (
    CognitoJWTError,
    MalformedTokenError,
    TokenVerificationError,
    UnknownSigningKeyError,
    verify_cognito_jwt,
)

__all__ = [
    "CognitoJWTError",
    "MalformedTokenError",
    "TokenVerificationError",
    "UnknownSigningKeyError",
    "verify_cognito_jwt",
]
