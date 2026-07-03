"""Invoke the isolated PR-signer (ADR-0008) to open a permission-change PR.

The Core API never holds the GitHub credential. It authorizes the admin (see
``dependencies.require_admin``), then invokes the signer Lambda synchronously
over IAM and relays the result. This module is that invocation seam — a
``Protocol`` so the route stays testable without boto3 or a live Lambda.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

from aws_lambda_powertools import Logger

logger = Logger()


class SignerInvoker(Protocol):
    """Invokes the signer with a request payload and returns its parsed result."""

    def invoke(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class SignerInvocationError(RuntimeError):
    """The signer Lambda could not be invoked or returned an unusable response."""


class LambdaSignerInvoker:
    """Default :class:`SignerInvoker` — invokes the signer Lambda over IAM.

    boto3 is imported lazily (provided by the Lambda runtime) and the client is
    reused across warm invocations. On an unhandled Lambda error the raw error
    payload is logged, never surfaced to the caller.
    """

    def __init__(self, function_name: str, client: Any = None) -> None:
        self._function_name = function_name
        self._client = client

    def invoke(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            import boto3

            self._client = boto3.client("lambda")
        response = self._client.invoke(
            FunctionName=self._function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        body = response["Payload"].read()
        if response.get("FunctionError"):
            logger.error(
                "PR-signer returned an unhandled error",
                extra={"function_error": response["FunctionError"]},
            )
            raise SignerInvocationError("the PR-signer failed to process the request")
        try:
            result = json.loads(body)
        except (ValueError, TypeError) as exc:
            raise SignerInvocationError(
                "the PR-signer returned an unreadable response"
            ) from exc
        if not isinstance(result, dict):
            raise SignerInvocationError("the PR-signer returned an unexpected response")
        return result


@dataclass(frozen=True)
class PermissionChangeResult:
    """Normalised outcome of a permission-change request.

    ``status`` is the signer's own status (200 success; 400 bad request; 409
    no-op/invalid edit; 502 upstream/GitHub error), so the route can relay a
    meaningful HTTP status rather than flattening everything to one code.
    """

    status: int
    pr_url: str | None = None
    branch: str | None = None
    error: str | None = None


def request_permission_change(
    invoker: SignerInvoker,
    *,
    plugin: str,
    table: str,
    operation: str,
    allowed: bool,
    required_role: list[str],
    requester: str,
) -> PermissionChangeResult:
    """Ask the signer to open a permission-change PR and normalise its result.

    The signer is the last-gate validator and the only holder of the GitHub
    credential; this forwards an already-authorized request and shapes the
    response into a :class:`PermissionChangeResult`.
    """
    payload = {
        "requester": requester,
        "plugin": plugin,
        "table": table,
        "operation": operation,
        "allowed": allowed,
        "required_role": list(required_role),
    }
    result = invoker.invoke(payload)
    status = result.get("statusCode", 502)
    if not isinstance(status, int):
        status = 502
    return PermissionChangeResult(
        status=status,
        pr_url=result.get("pr_url"),
        branch=result.get("branch"),
        error=result.get("error"),
    )
