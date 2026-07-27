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
import re
from dataclasses import dataclass, field

from aws_lambda_powertools import Logger
from fastapi import HTTPException, Request, status

from ..config import settings

logger = Logger()

# STS issues assumed-role ARNs shaped
# ``arn:aws:sts::<account>:assumed-role/<role-name>/<session>``.
_ASSUMED_ROLE_ARN = re.compile(r"^arn:aws:sts::\d{12}:assumed-role/(?P<role>[^/]+)/.+$")

# The compute-module role-naming convention (ADR-0009, guarded by #266 via
# cli/src/lib/plugin-allowlist-convention.ts):
#     <project>-<env>-plugin-<name>-role
# We anchor on the ``-plugin-`` segment and the ``-role`` suffix and take
# ``<name>`` from between them. The leading ``.+`` is greedy, so a project/env
# that itself contains the literal "plugin" binds to the *last* ``-plugin-``
# occurrence — matching how the name sits immediately before ``-role``.
_PLUGIN_ROLE_NAME = re.compile(r"^.+-plugin-(?P<name>.+)-role$")

# ADR-0021 §1a — the shared plugin host. It has ONE IAM role
# (``<project>-<env>-plugin-host-role`` -> ``system:host``) but serves many
# plugins, so it names the plugin it is acting for per request via a signed
# header. Core honours that assertion ONLY when the SigV4 caller is the host: the
# IAM signature authorizes "this is the host", the header says "acting as <name>".
# A plugin running in its own Lambda is identified by its role and this header is
# ignored, so it can never assert another plugin's identity.
_HOST_LOGICAL_NAME = "system:host"
_PLUGIN_IDENTITY_HEADER = "x-biffo-plugin"
# The asserted name becomes ``system:<name>``; constrain it to the same
# lowercase-kebab shape a plugin name (and thus a role-derived name) can take, so a
# crafted header can neither inject into the logical name nor spoof a non-plugin.
_VALID_PLUGIN_NAME = re.compile(r"^[a-z][a-z0-9-]*$")


def _logical_names_from_arn(principal_arn: str) -> frozenset[str]:
    """Derive the ADR-0014 §7 logical principal name(s) from an assumed-role ARN.

    Fails closed: an ARN that is not an assumed-role ARN, or whose role name
    does not match the ``<project>-<env>-plugin-<name>-role`` convention,
    resolves to the empty set — a non-plugin caller, a future differently-shaped
    principal or a malformed ARN can therefore read nothing. A name is never
    guessed from a non-conforming ARN.
    """
    arn_match = _ASSUMED_ROLE_ARN.match(principal_arn)
    if arn_match is None:
        return frozenset()
    role_match = _PLUGIN_ROLE_NAME.match(arn_match.group("role"))
    if role_match is None:
        return frozenset()
    return frozenset({f"system:{role_match.group('name')}"})


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
    #: ADR-0021 §1a — the plugin identity the shared host asserted for this request.
    #: Set only by ``require_service_principal`` when the caller IS the host; then
    #: ``logical_names`` is that plugin's identity, not the host's own role identity.
    asserted_plugin: str | None = None

    @property
    def logical_names(self) -> frozenset[str]:
        """The ADR-0014 §7 logical name(s) this principal reads Core data as.

        Normally derived from ``principal_arn`` per the compute-module role-naming
        convention (``…assumed-role/<project>-<env>-plugin-<name>-role/<session>``
        -> ``{"system:<name>"}``). A principal whose ARN does not conform resolves
        to an empty set and can satisfy no ``allowed_principals`` grant — the
        fail-closed security property the read-scope ceiling depends on.

        When the shared plugin host asserted a plugin identity (ADR-0021 §1a),
        that identity is used instead — ``require_service_principal`` sets
        ``asserted_plugin`` only after verifying the caller is the host.
        """
        if self.asserted_plugin is not None:
            return frozenset({f"system:{self.asserted_plugin}"})
        return _logical_names_from_arn(self.principal_arn)


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


async def optional_service_principal(request: Request) -> ServicePrincipal | None:
    """The verified service identity when the request carries one, else ``None``.

    Identical to :func:`require_service_principal` except that the *absence* of
    IAM context is not an error — it simply means the caller is not a service
    (a human's bearer-token request), so the unified principal resolution can
    accept both caller shapes without a second dependency (#621).

    A present-but-non-allowlisted principal still raises 403. That asymmetry is
    the point: "no service called" and "a service called and was rejected" must
    not collapse into the same answer, or a refused service caller would be
    silently downgraded to an ordinary user rather than blocked.
    """
    principal_arn = _iam_principal_from_request(request)
    if principal_arn is None:
        return None
    if not _is_allowlisted(principal_arn):
        logger.warning(
            "Rejected non-allowlisted service principal",
            extra={"principal_arn": principal_arn},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Service principal not authorized",
        )
    # ADR-0021 §1a: if the allowlisted caller is the shared plugin host and it
    # asserted a plugin identity, honour it — the host multiplexes many plugins
    # over its one role. Only the host may assert; any other caller's header is
    # ignored, so a plugin cannot claim another plugin's identity.
    asserted = _asserted_plugin_identity(request, principal_arn)
    return ServicePrincipal(principal_arn=principal_arn, asserted_plugin=asserted)


async def require_service_principal(request: Request) -> ServicePrincipal:
    """FastAPI dependency for ``/api/v1/internal/*`` routes (ADR-0009).

    Enforces that the request arrived with a SigV4-verified IAM principal that is
    on the configured allowlist, and returns the resulting service identity.

    Raises 401 if no IAM principal is present (the request did not come through
    an IAM-authorized route), 403 if the principal is not allowlisted.
    """
    principal = await optional_service_principal(request)
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Service authentication required",
        )
    return principal


def _asserted_plugin_identity(request: Request, principal_arn: str) -> str | None:
    """The plugin name the shared host asserted, or ``None``.

    Returns a name only when the SigV4 caller's own identity is the host
    (``system:host``) AND the ``X-Biffo-Plugin`` header is a well-formed plugin
    name. Any other caller, or a malformed/absent header, yields ``None`` so the
    caller keeps its role-derived identity (fail-closed).
    """
    if _logical_names_from_arn(principal_arn) != frozenset({_HOST_LOGICAL_NAME}):
        return None
    asserted = request.headers.get(_PLUGIN_IDENTITY_HEADER)
    if asserted and _VALID_PLUGIN_NAME.match(asserted):
        return asserted
    return None
