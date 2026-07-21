"""Tests for the PR-signer invocation seam (ADR-0008, Core API side)."""

import io
import json
from typing import Any

import pytest
from api.endpoint_control import (
    LambdaSignerInvoker,
    SignerInvocationError,
    request_permission_change,
)


class FakeInvoker:
    def __init__(self, result):
        self.result = result
        self.payload = None

    def invoke(self, payload):
        self.payload = payload
        return self.result


def test_request_forwards_payload_and_relays_success():
    invoker = FakeInvoker(
        {
            "statusCode": 200,
            "pr_url": "https://github.com/o/r/pull/3",
            "branch": "biffo/endpoint-x",
        }
    )

    result = request_permission_change(
        invoker,
        plugin="notes",
        table="note",
        operation="create",
        allowed=True,
        required_role=["admin"],
        requester="admin@example.com",
    )

    assert result.status == 200
    assert result.pr_url == "https://github.com/o/r/pull/3"
    assert result.branch == "biffo/endpoint-x"
    # The signer contract: a flat payload with requester + change.
    assert invoker.payload == {
        "requester": "admin@example.com",
        "plugin": "notes",
        "table": "note",
        "operation": "create",
        "allowed": True,
        "required_role": ["admin"],
    }


def test_request_relays_signer_error_status():
    invoker = FakeInvoker({"statusCode": 409, "error": "already set"})
    result = request_permission_change(
        invoker,
        plugin="notes",
        table="note",
        operation="read",
        allowed=True,
        required_role=[],
        requester="a@b.com",
    )
    assert result.status == 409
    assert result.error == "already set"
    assert result.pr_url is None


def test_request_defaults_missing_status_to_502():
    result = request_permission_change(
        FakeInvoker({"weird": "response"}),
        plugin="p",
        table="t",
        operation="list",
        allowed=True,
        required_role=[],
        requester="a@b.com",
    )
    assert result.status == 502


class FakeLambdaClient:
    """Mimics the boto3 lambda client's invoke() for LambdaSignerInvoker."""

    def __init__(self, *, payload_bytes: bytes, function_error: str | None = None):
        self._payload_bytes = payload_bytes
        self._function_error = function_error
        self.last_kwargs = None

    def invoke(self, **kwargs):
        self.last_kwargs = kwargs
        response: dict[str, Any] = {"Payload": io.BytesIO(self._payload_bytes)}
        if self._function_error:
            response["FunctionError"] = self._function_error
        return response


def test_lambda_invoker_parses_success_payload():
    client = FakeLambdaClient(payload_bytes=json.dumps({"statusCode": 200, "pr_url": "u"}).encode())
    invoker = LambdaSignerInvoker("signer-fn", client=client)

    out = invoker.invoke({"plugin": "p"})

    assert out == {"statusCode": 200, "pr_url": "u"}
    assert client.last_kwargs is not None
    assert client.last_kwargs["FunctionName"] == "signer-fn"
    assert client.last_kwargs["InvocationType"] == "RequestResponse"
    # Payload is JSON-encoded bytes.
    assert json.loads(client.last_kwargs["Payload"]) == {"plugin": "p"}


def test_lambda_invoker_raises_on_function_error():
    client = FakeLambdaClient(payload_bytes=b'{"errorMessage": "boom"}', function_error="Unhandled")
    invoker = LambdaSignerInvoker("signer-fn", client=client)

    with pytest.raises(SignerInvocationError):
        invoker.invoke({"plugin": "p"})


def test_lambda_invoker_raises_on_unreadable_payload():
    client = FakeLambdaClient(payload_bytes=b"not-json")
    invoker = LambdaSignerInvoker("signer-fn", client=client)

    with pytest.raises(SignerInvocationError):
        invoker.invoke({"plugin": "p"})
