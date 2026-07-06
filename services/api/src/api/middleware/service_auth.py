"""Inbound service-to-service authentication (ADR-0009).

Background actors — ADR-0003 plugins such as the orchestration engine — call the
Core API over HTTP but have no Cognito user identity: they react to EventBridge
events, not to a logged-in user's request, so there is no ID token to present.
They authenticate with **AWS SigV4 (IAM)** against dedicated ``/api/v1/internal/*``
routes that API Gateway protects with ``authorization_type = AWS_IAM``.

By the time such a request reaches the Lambda, API Gateway has already verified
the caller's SigV4 signature and the caller's ``execute-api:Invoke`` permission,
and resolved its IAM principal into ``requestContext.authorizer.iam``. Mangum
exposes that raw Lambda event to FastAPI at ``request.scope["aws.event"]``.

This module turns that verified IAM principal into a :class:`ServicePrincipal`
and enforces an **allowlist** of permitted caller ARNs, so authorization is
defense in depth: API Gateway IAM is the edge gate, and the app re-checks which
principal got through (ADR-0009). It fails closed — no IAM context, or an empty
allowlist, means no service caller is accepted.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field

from aws_lambda_powertools import Logger
from fastapi import HTTPException, Request, status

from ..config import settings

logger = Logger()


@dataclass(frozen=True)
class ServicePrincipal:
    """Verified identity of a machine caller on an internal route (ADR-0009).

    Tenant-scoped to ``"default"`` like every other identity in a single-tenant
    deployment (ADR-0001). Carries no Cognito groups: internal routes authorize
    by *being* an allowlisted service, not by role membership.
    """

    principal_arn: str
    tenant_id: str = "default"
    roles: list[str] = field(default_factory=list)


def _iam_principal_from_request(request: Request) -> str | None:
    """Return the caller's SigV4-verified IAM principal ARN, or ``None``.

    Reads ``requestContext.authorizer.iam.userArn`` from the API Gateway v2 event
    that Mangum stores at ``request.scope["aws.event"]``. Absent when the request
    did not traverse an IAM-authorized route — local dev, tests, or a
    misconfiguration — in which case the caller is treated as unauthenticated.
    """
    event = request.scope.get("aws.event")
    if not isinstance(event, dict):
        return None
    iam = event.get("requestContext", {}).get("authorizer", {}).get("iam", {})
    if not isinstance(iam, dict):
        return None
    # userArn is the caller's own principal; callerArn is a compatible fallback.
    principal = iam.get("userArn") or iam.get("callerArn")
    return principal if isinstance(principal, str) and principal else None


def _is_allowlisted(principal_arn: str) -> bool:
    """Whether ``principal_arn`` matches any configured allowlist glob.

    Fails closed: an empty allowlist authorizes no one. Patterns are
    ``fnmatch`` globs so an instance can allow a whole role via its assumed-role
    session ARN, e.g. ``arn:aws:sts::*:assumed-role/acme-dev-plugin-*/*``.
    """
    patterns = settings.service_principal_arn_allowlist
    return any(fnmatch.fnmatch(principal_arn, pattern) for pattern in patterns)


async def require_service_principal(request: Request) -> ServicePrincipal:
    """FastAPI dependency for ``/api/v1/internal/*`` routes (ADR-0009).

    Enforces that the request arrived with a SigV4-verified IAM principal that is
    on the configured allowlist, and returns the resulting service identity.

    Raises 401 if no IAM principal is present (the request did not come through
    an IAM-authorized route), 403 if the principal is not allowlisted.
    """
    principal_arn = _iam_principal_from_request(request)
    if principal_arn is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Service authentication required",
        )
    if not _is_allowlisted(principal_arn):
        logger.warning(
            "Rejected non-allowlisted service principal",
            extra={"principal_arn": principal_arn},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Service principal not authorized",
        )
    return ServicePrincipal(principal_arn=principal_arn)
