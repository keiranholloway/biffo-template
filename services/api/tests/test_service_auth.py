"""Tests for inbound service-to-service authentication (ADR-0009).

`require_service_principal` reads the SigV4-verified IAM principal from the API
Gateway v2 event that Mangum stores at `request.scope["aws.event"]`, and enforces
the configured allowlist. These unit-test the dependency directly with a
hand-built Request scope standing in for what API Gateway + Mangum deliver.
"""

import pytest
from api.config import settings
from api.middleware.service_auth import (
    ServicePrincipal,
    require_service_principal,
)
from fastapi import HTTPException
from starlette.requests import Request

ORCHESTRATOR_ARN = (
    "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-orchestrator-role/orchestrator-session"
)
ALLOWLIST = ["arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-*/*"]


def _request_with_iam(user_arn: str | None) -> Request:
    """Build a minimal Request whose aws.event mirrors an IAM-authorized route.

    When user_arn is None the requestContext carries no iam block, as it would
    for a request that never traversed an AWS_IAM route.
    """
    request_context: dict = {"http": {"method": "POST"}}
    if user_arn is not None:
        request_context["authorizer"] = {"iam": {"userArn": user_arn}}
    scope = {
        "type": "http",
        "aws.event": {"requestContext": request_context},
    }
    return Request(scope)


@pytest.fixture
def allowlist(monkeypatch):
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", list(ALLOWLIST))


async def test_allowlisted_principal_is_accepted(allowlist):
    principal = await require_service_principal(_request_with_iam(ORCHESTRATOR_ARN))

    assert isinstance(principal, ServicePrincipal)
    assert principal.principal_arn == ORCHESTRATOR_ARN
    assert principal.tenant_id == "default"
    assert principal.roles == []


async def test_non_allowlisted_principal_is_forbidden(allowlist):
    other = "arn:aws:sts::123456789012:assumed-role/some-other-role/sess"

    with pytest.raises(HTTPException) as exc:
        await require_service_principal(_request_with_iam(other))

    assert exc.value.status_code == 403


async def test_missing_iam_context_is_unauthorized(allowlist):
    """A request that didn't come through an IAM-authorized route has no iam
    block — treated as unauthenticated (401), not merely un-allowlisted."""
    with pytest.raises(HTTPException) as exc:
        await require_service_principal(_request_with_iam(None))

    assert exc.value.status_code == 401


async def test_empty_allowlist_fails_closed(monkeypatch):
    """With no allowlist configured, even a well-formed IAM principal is rejected."""
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", [])

    with pytest.raises(HTTPException) as exc:
        await require_service_principal(_request_with_iam(ORCHESTRATOR_ARN))

    assert exc.value.status_code == 403


async def test_no_aws_event_fails_closed(allowlist):
    """Local dev / non-Mangum requests have no aws.event at all -> 401."""
    request = Request({"type": "http"})

    with pytest.raises(HTTPException) as exc:
        await require_service_principal(request)

    assert exc.value.status_code == 401


class TestLogicalNames:
    """ADR-0014 §7: a ServicePrincipal derives its logical name(s) from the
    assumed-role ARN, so the read-scope guard can check membership without
    re-parsing. Fail-closed on anything that isn't a conforming plugin ARN."""

    def test_conforming_plugin_arn_yields_system_name(self):
        principal = ServicePrincipal(
            principal_arn=(
                "arn:aws:sts::123456789012:assumed-role/"
                "tabsii-platform-dev-plugin-agent-runtime-role/abc"
            )
        )
        assert principal.logical_names == frozenset({"system:agent-runtime"})

    def test_derivation_matches_the_compute_module_convention(self):
        # Pins the derivation against the real role-naming convention the
        # compute module builds (#266): "<project>-<env>-plugin-<name>-role".
        # project and env deliberately contain hyphens to prove the greedy
        # anchor still extracts the plugin name (not a project/env fragment).
        project, environment, name = "acme-corp", "dev", "agent-runtime"
        role_name = f"{project}-{environment}-plugin-{name}-role"
        arn = f"arn:aws:sts::123456789012:assumed-role/{role_name}/session-id"

        principal = ServicePrincipal(principal_arn=arn)

        assert principal.logical_names == frozenset({f"system:{name}"})

    def test_non_plugin_role_resolves_to_empty(self):
        # A conforming assumed-role ARN whose role is not a plugin role (no
        # "-plugin-<name>-role" shape) grants nothing. Fail closed.
        principal = ServicePrincipal(
            principal_arn=(
                "arn:aws:sts::123456789012:assumed-role/acme-dev-core-api-role/session"
            )
        )
        assert principal.logical_names == frozenset()

    def test_non_assumed_role_arn_resolves_to_empty(self):
        # An IAM user ARN (not an STS assumed-role ARN) grants nothing.
        principal = ServicePrincipal(
            principal_arn="arn:aws:iam::123456789012:user/some-user"
        )
        assert principal.logical_names == frozenset()

    def test_malformed_arn_resolves_to_empty(self):
        principal = ServicePrincipal(principal_arn="not-an-arn-at-all")
        assert principal.logical_names == frozenset()

    def test_role_without_role_suffix_resolves_to_empty(self):
        principal = ServicePrincipal(
            principal_arn=(
                "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-agent-runtime/session"
            )
        )
        assert principal.logical_names == frozenset()

    def test_empty_plugin_name_resolves_to_empty(self):
        # "...-plugin--role" has no name between the markers -> nothing.
        principal = ServicePrincipal(
            principal_arn="arn:aws:sts::123456789012:assumed-role/acme-dev-plugin--role/session"
        )
        assert principal.logical_names == frozenset()
