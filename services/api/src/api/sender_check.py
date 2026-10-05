"""Save-time check that SES can send as an email action's ``from`` address.

An unverified sender is otherwise accepted at save and only found at send time,
as a bare ``MessageRejected``. ``require_sendable_sender`` asks SES (never a
hard-coded list) whether the exact address, or failing that its domain, is an
identity with ``VerifiedForSendingStatus`` true. Importable by instance code
that compiles workflows without going through the router.
"""

from __future__ import annotations

import asyncio
import logging
from email.utils import parseaddr
from typing import Any

from fastapi import HTTPException, status

logger = logging.getLogger(__name__)

_client: Any = None


def _get_client() -> Any:
    """The shared SESv2 client (boto3 imported lazily; tests monkeypatch this)."""
    global _client  # noqa: PLW0603
    if _client is None:
        import boto3

        _client = boto3.client("sesv2")
    return _client


def bare_address(address: str) -> str:
    """The ``addr`` of ``Name <addr>`` (or ``addr`` itself), as SES receives it."""
    return parseaddr(address)[1].strip()


def _is_not_found(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error = response.get("Error")
        if isinstance(error, dict):
            return error.get("Code") == "NotFoundException"
    return type(exc).__name__ == "NotFoundException"


def _verified(client: Any, identity: str) -> bool:
    """True/False for a known/unknown identity; any other failure propagates."""
    try:
        result = client.get_email_identity(EmailIdentity=identity)
    except Exception as exc:
        if _is_not_found(exc):
            return False
        raise
    return bool(result.get("VerifiedForSendingStatus"))


async def require_sendable_sender(address: str) -> None:
    """422 unless SES can send as ``address``; 503 if SES can't be asked."""
    addr = bare_address(address)
    domain = addr.rpartition("@")[2]
    try:
        client = _get_client()
        ok = await asyncio.to_thread(_verified, client, addr)
        if not ok and domain and domain != addr:
            ok = await asyncio.to_thread(_verified, client, domain)
    except Exception as exc:
        logger.warning("SES sender lookup failed", extra={"error": str(exc)})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f'The sender "{addr}" could not be checked right now. Try again shortly.',
        ) from exc
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"\"{addr}\" can't be used as a sender yet: it isn't a verified sending "
                "address for this platform. Use an address at a verified domain or ask "
                "an administrator to verify it."
            ),
        )
