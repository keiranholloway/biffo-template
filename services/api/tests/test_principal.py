"""The unified principal resolution (#621, step 2).

`require_principal` is the single answer to "who is calling", replacing the
need for a route to know which of Core's two transports its caller used. These
exercise the dependency directly with a hand-built Request scope standing in for
what API Gateway + Mangum deliver, mirroring `test_service_auth.py`.

The assertions that matter most are the ones about *not* collapsing cases:
a rejected service caller must not degrade into an ordinary user, and the
deactivation gate must apply on both transports.
"""

import api.middleware.auth as auth_module
import pytest
from api.config import settings
from api.middleware.principal import Principal, require_principal
from api.middleware.service_auth import ServicePrincipal
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from starlette.requests import Request

HOST_ARN = "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-host-role/host-session"
IDEATION_ARN = (
    "arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-ideation-role/ideation-session"
)
STRANGER_ARN = "arn:aws:sts::123456789012:assumed-role/some-other-role/session"
ALLOWLIST = ["arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-*/*"]


def _request(user_arn: str | None = None, headers: list[tuple[bytes, bytes]] | None = None):
    request_context: dict = {"http": {"method": "GET"}}
    if user_arn is not None:
        request_context["authorizer"] = {"iam": {"userArn": user_arn}}
    return Request(
        {
            "type": "http",
            "headers": headers or [],
            "aws.event": {"requestContext": request_context},
        }
    )


def _bearer(token: str = "a.b.c") -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


@pytest.fixture
def allowlist(monkeypatch):
    monkeypatch.setattr(settings, "service_principal_arn_allowlist", list(ALLOWLIST))


@pytest.fixture(autouse=True)
def _stub_identity(monkeypatch):
    """Verification and the provider lookup are covered elsewhere; here they are
    stubbed so the focus is which token gets used and what shape comes back."""
    seen: dict[str, object] = {}

    def _claims_from_token(credentials):
        seen["token"] = credentials.credentials
        return {"sub": "sub-1", "email": "a@example.com"}

    async def _authenticated_identity(claims, db):
        return auth_module.AuthenticatedUser(
            sub=claims["sub"],
            email=claims.get("email", ""),
            username="u",
            tenant_id="default",
            roles=["founder"],
        )

    import api.middleware.principal as principal_module

    monkeypatch.setattr(principal_module, "claims_from_token", _claims_from_token)
    monkeypatch.setattr(principal_module, "authenticated_identity", _authenticated_identity)
    return seen


async def test_a_bearer_caller_is_a_user_with_no_service(_stub_identity):
    principal = await require_principal(
        _request(),
        credentials=_bearer("human-token"),
        forwarded_token=None,
        db=None,  # type: ignore[arg-type]
    )

    assert isinstance(principal, Principal)
    assert principal.user.sub == "sub-1"
    assert principal.service is None
    assert principal.is_service_call is False
    assert _stub_identity["token"] == "human-token"


async def test_a_signed_caller_carries_both_the_service_and_the_forwarded_user(
    allowlist, _stub_identity
):
    principal = await require_principal(
        _request(IDEATION_ARN),
        credentials=None,  # SigV4 owns Authorization, so no bearer is parsed
        forwarded_token="founder-token",
        db=None,  # type: ignore[arg-type]
    )

    assert principal.user.sub == "sub-1"
    assert isinstance(principal.service, ServicePrincipal)
    assert principal.service.logical_names == frozenset({"system:ideation"})
    assert principal.is_service_call is True
    assert _stub_identity["token"] == "founder-token"


async def test_the_forwarded_token_wins_when_both_headers_are_present(allowlist, _stub_identity):
    """A SigV4 request's `Authorization` holds a signature, not a usable JWT, so
    the forwarded header is the user's token whenever it is present."""
    await require_principal(
        _request(IDEATION_ARN),
        credentials=_bearer("not-the-user-token"),
        forwarded_token="founder-token",
        db=None,  # type: ignore[arg-type]
    )

    assert _stub_identity["token"] == "founder-token"


async def test_no_token_at_all_is_401(_stub_identity):
    with pytest.raises(HTTPException) as exc:
        await require_principal(_request(), credentials=None, forwarded_token=None, db=None)  # type: ignore[arg-type]
    assert exc.value.status_code == 401


async def test_a_rejected_service_principal_is_403_not_a_downgrade_to_user(
    allowlist, _stub_identity
):
    """The case this design most needs to get right.

    A caller presenting a non-allowlisted IAM principal must be refused — not
    quietly treated as an ordinary bearer user, which would turn a failed
    service authentication into a successful human one.
    """
    with pytest.raises(HTTPException) as exc:
        await require_principal(
            _request(STRANGER_ARN),
            credentials=_bearer("human-token"),
            forwarded_token=None,
            db=None,  # type: ignore[arg-type]
        )

    assert exc.value.status_code == 403


async def test_the_deactivation_gate_applies_on_both_transports(allowlist, monkeypatch):
    """#621's original defect, asserted against the unified path: whichever
    header carried the token, `authenticated_identity` runs and can refuse."""
    import api.middleware.principal as principal_module

    monkeypatch.setattr(principal_module, "claims_from_token", lambda credentials: {"sub": "sub-1"})

    async def _deactivated(claims, db):
        raise HTTPException(status_code=401, detail="Account is deactivated")

    monkeypatch.setattr(principal_module, "authenticated_identity", _deactivated)

    for creds, forwarded, arn in (
        (_bearer("t"), None, None),  # human, bearer
        (None, "t", IDEATION_ARN),  # plugin, forwarded
    ):
        with pytest.raises(HTTPException) as exc:
            await require_principal(
                _request(arn),
                credentials=creds,
                forwarded_token=forwarded,
                db=None,  # type: ignore[arg-type]
            )
        assert exc.value.status_code == 401
        assert "deactivated" in str(exc.value.detail)


async def test_the_host_may_still_assert_the_plugin_it_acts_for(allowlist, _stub_identity):
    """ADR-0021 §1a must survive the refactor: the shared host has one role but
    names the plugin it is acting for, and Core honours that only from the host."""
    principal = await require_principal(
        _request(HOST_ARN, headers=[(b"x-biffo-plugin", b"ideation")]),
        credentials=None,
        forwarded_token="founder-token",
        db=None,  # type: ignore[arg-type]
    )

    assert principal.service is not None
    assert principal.service.logical_names == frozenset({"system:ideation"})


async def test_a_non_host_service_cannot_assert_another_plugins_identity(allowlist, _stub_identity):
    """The fail-closed half of ADR-0021 §1a — a plugin's own role ignores the
    header, so it keeps its role-derived identity and cannot impersonate."""
    principal = await require_principal(
        _request(IDEATION_ARN, headers=[(b"x-biffo-plugin", b"orchestrator")]),
        credentials=None,
        forwarded_token="founder-token",
        db=None,  # type: ignore[arg-type]
    )

    assert principal.service is not None
    assert principal.service.logical_names == frozenset({"system:ideation"})
