"""Integration tests for the internal service chat endpoint
(/api/v1/internal/agent-chat/{agent_key}, ADR-0017 §3 seam #3).

The dual-auth path a plugin's Lambda uses: a SigV4 service principal AND a
forwarded, re-verified founder token — since #621 resolved as one `Principal` by
`require_signed_principal`. Both the SigV4 gate and the token verification are
exercised elsewhere (ADR-0009; packages/cognito-auth; test_principal.py), so here
they are faked/overridden and the focus is this endpoint's own logic: the run is
run_as the *forwarded founder*, the gate is the agent's required_group, a missing
forwarded token is 401, and an unknown agent is 404.

Additionally tests the live, DB-backed resolution fallback for opted-in dynamic
plugins (ADR-0017 seam #1 extension).
"""

import asyncio
from collections.abc import AsyncGenerator

from api.chat_agents import ChatAgent, register_chat_agent
from api.chat_engine import ChatTurnResult
from api.database import get_db
from api.identity import identity_session
from api.middleware.auth import AuthenticatedUser
from api.middleware.forwarded_user import FORWARDED_USER_HEADER
from api.middleware.principal import Principal, require_principal
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table on Base.metadata
from api.models.base import Base
from api.models.plugin_chat_agent import PluginChatAgent  # noqa: F401 — registers the table
from api.routers import internal_agent_chat
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_AGENT_KEY = "test-internal-agent"
_PROMPT = "You are a founder-facing agent driven via the service seam."
_BASE = f"/api/v1/internal/agent-chat/{_AGENT_KEY}"


def _register_agent() -> None:
    register_chat_agent(
        _AGENT_KEY,
        lambda: ChatAgent(
            agent_key=_AGENT_KEY,
            agent_name=_AGENT_KEY,
            system_prompt=_PROMPT,
            model="test/model",
            required_group="founder",
            max_history_messages=40,
            max_output_tokens=256,
            timeout_seconds=10.0,
        ),
    )


_register_agent()


def _founder(*, roles: list[str]) -> AuthenticatedUser:
    # A forwarded user has no DB-backed user_id — run_as falls back to the sub.
    return AuthenticatedUser(
        sub="founder-sub-abc",
        email="f@example.com",
        username="founder",
        tenant_id="default",
        roles=roles,
        user_id=None,
    )


class FakeInvoker:
    def __init__(self):
        self.calls: list[dict] = []

    def invoke_chat_turn(self, *, model, messages, max_output_tokens, timeout_seconds):
        self.calls.append({"messages": messages})
        return ChatTurnResult(content="reply via service seam", model=model, output_tokens=5)


def _build_app(*, founder: AuthenticatedUser, invoker: FakeInvoker):
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(internal_agent_chat.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/proj-dev-plugin-ideation-role/s"
    )
    app.dependency_overrides[require_principal] = lambda: Principal(user=founder)
    app.dependency_overrides[internal_agent_chat._get_runtime_invoker] = lambda: invoker
    return app, session_factory, engine


async def _load_run(session_factory, run_id: str) -> AgentRun:
    async with session_factory() as session:
        run = await session.get(AgentRun, run_id)
        assert run is not None
        return run


# ── the happy path: run_as the forwarded founder ────────────────────────────────


def test_a_service_turn_runs_as_the_forwarded_founder():
    invoker = FakeInvoker()
    app, session_factory, engine = _build_app(founder=_founder(roles=["founder"]), invoker=invoker)
    client = TestClient(app)

    resp = client.post(_BASE, json={"message": "my startup idea"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reply"] == "reply via service seam"
    run = asyncio.run(_load_run(session_factory, body["run_id"]))
    assert run.run_as_kind == "user"
    assert run.run_as_user_id == "founder-sub-abc"  # the verified forwarded subject
    assert run.agent_name == _AGENT_KEY
    # the agent's own prompt, and the founder's message fenced
    messages = invoker.calls[0]["messages"]
    assert messages[0]["content"] == _PROMPT
    assert "my startup idea" in messages[-1]["content"]
    asyncio.run(engine.dispose())


def test_a_forwarded_user_not_in_the_group_is_forbidden():
    invoker = FakeInvoker()
    app, _, engine = _build_app(founder=_founder(roles=["admin"]), invoker=invoker)
    client = TestClient(app)

    # admin is not founder — gated by the agent's required_group.
    resp = client.post(_BASE, json={"message": "hi"})

    assert resp.status_code == 403
    assert invoker.calls == []
    asyncio.run(engine.dispose())


def test_an_unknown_agent_is_404():
    invoker = FakeInvoker()
    app, _, engine = _build_app(founder=_founder(roles=["founder"]), invoker=invoker)
    client = TestClient(app)

    resp = client.post("/api/v1/internal/agent-chat/no-such-agent", json={"message": "hi"})

    assert resp.status_code == 404
    assert invoker.calls == []
    asyncio.run(engine.dispose())


# ── the auth gates, exercised through the route (#621) ──────────────────────────
#
# These used to call the retired `require_forwarded_user` directly. The
# dependency's own semantics now live in test_principal.py; what is worth
# asserting *here* is that this route is still wired to both gates, which only a
# request through the route can show.


def _client_without_user_override(*, iam: bool = True) -> TestClient:
    """A client with the SigV4 gate satisfied (or not) but the user gate real."""
    app, _, engine = _build_app(founder=_founder(roles=["founder"]), invoker=FakeInvoker())
    del app.dependency_overrides[require_principal]
    if not iam:
        del app.dependency_overrides[require_service_principal]
    app.dependency_overrides[identity_session] = lambda: None
    client = TestClient(app)
    client._engine = engine  # type: ignore[attr-defined]  — disposed by the caller
    return client


def test_a_missing_forwarded_token_is_401():
    """The user gate: a signed call with no forwarded token cannot act for anyone."""
    client = _client_without_user_override()

    resp = client.post(_BASE, json={"message": "hi"})

    assert resp.status_code == 401
    asyncio.run(client._engine.dispose())  # type: ignore[attr-defined]


def test_a_forwarded_token_that_fails_verification_is_401(monkeypatch):
    """Core, not the plugin, is the authority on who the user is: a token that
    does not verify here buys nothing, however well the request was signed."""
    import api.middleware.principal as principal_module

    def _reject(credentials):
        raise HTTPException(status_code=401, detail="Invalid token")

    monkeypatch.setattr(principal_module, "claims_from_token", _reject)
    client = _client_without_user_override()

    resp = client.post(_BASE, json={"message": "hi"}, headers={FORWARDED_USER_HEADER: "a.b.c"})

    assert resp.status_code == 401
    asyncio.run(client._engine.dispose())  # type: ignore[attr-defined]


def test_an_unsigned_caller_is_401_even_with_a_valid_user_token(monkeypatch):
    """The service gate: this route is not reachable by a browser holding a
    perfectly good Cognito token. Only a verified service may drive it."""
    import api.middleware.principal as principal_module

    monkeypatch.setattr(
        principal_module, "claims_from_token", lambda credentials: {"sub": "founder-sub-abc"}
    )

    async def _identity(claims, db):
        return _founder(roles=["founder"])

    monkeypatch.setattr(principal_module, "authenticated_identity", _identity)
    client = _client_without_user_override(iam=False)

    resp = client.post(_BASE, json={"message": "hi"}, headers={FORWARDED_USER_HEADER: "a.b.c"})

    assert resp.status_code == 401
    asyncio.run(client._engine.dispose())  # type: ignore[attr-defined]


def test_a_deactivated_account_is_401_on_the_forwarded_path_too(monkeypatch):
    """The #150 deactivation gate must apply however the token arrived (#621).

    This path used to verify the token and stop, so a suspended user's unexpired
    access token kept working through every plugin-forwarded route. Asserted
    through the route, because the defect was never in the checks themselves —
    it was in which dependency this route reached for.
    """
    import api.middleware.principal as principal_module

    monkeypatch.setattr(
        principal_module, "claims_from_token", lambda credentials: {"sub": "founder-sub-abc"}
    )

    async def _deactivated(claims, db):
        raise HTTPException(status_code=401, detail="Account is deactivated")

    monkeypatch.setattr(principal_module, "authenticated_identity", _deactivated)
    client = _client_without_user_override()

    resp = client.post(_BASE, json={"message": "hi"}, headers={FORWARDED_USER_HEADER: "a.b.c"})

    assert resp.status_code == 401
    assert "deactivated" in resp.json()["detail"]
    asyncio.run(client._engine.dispose())  # type: ignore[attr-defined]


# ── Dynamic chat agents: live, DB-backed resolution (ADR-0017 seam #1 extension) ──


def test_a_dynamic_chat_agent_from_db_runs_the_turn():
    """An agent_key NOT in the static registry, but present as an active row in
    PluginChatAgent, is resolved from the DB and runs successfully."""
    invoker = FakeInvoker()
    app, session_factory, engine = _build_app(founder=_founder(roles=["founder"]), invoker=invoker)
    client = TestClient(app)

    # Insert a dynamic agent directly into the DB.
    async def _insert_dynamic():
        async with session_factory() as session:
            agent = PluginChatAgent(
                tenant_id="default",
                plugin_name="dynamic-plugin",
                agent_key="dynamic-agent",
                agent_name="Dynamic Agent",
                role="founder",
                system_prompt="I am a dynamic agent from the DB.",
                model="test/dynamic-model",
                required_group="founder",
                active=True,
                max_history_messages=40,
                max_output_tokens=256,
                timeout_seconds=10.0,
            )
            session.add(agent)
            await session.commit()

    asyncio.run(_insert_dynamic())

    # The request should succeed and use the DB agent's config.
    resp = client.post(
        "/api/v1/internal/agent-chat/dynamic-agent",
        json={"message": "hello from dynamic"},
    )

    assert resp.status_code == 200
    # The DB agent's system prompt should be in the messages sent to the invoker.
    messages = invoker.calls[0]["messages"]
    assert "I am a dynamic agent from the DB." in messages[0]["content"]
    asyncio.run(engine.dispose())


def test_an_inactive_dynamic_agent_is_not_resolved():
    """An inactive row in PluginChatAgent is not returned by the fallback, so
    an unknown key with an inactive row still 404s."""
    invoker = FakeInvoker()
    app, session_factory, engine = _build_app(founder=_founder(roles=["founder"]), invoker=invoker)
    client = TestClient(app)

    # Insert an inactive dynamic agent.
    async def _insert_inactive():
        async with session_factory() as session:
            agent = PluginChatAgent(
                tenant_id="default",
                plugin_name="dynamic-plugin",
                agent_key="inactive-agent",
                agent_name="Inactive Agent",
                role="founder",
                system_prompt="This is inactive.",
                model="test/model",
                required_group="founder",
                active=False,
                max_history_messages=40,
                max_output_tokens=256,
                timeout_seconds=10.0,
            )
            session.add(agent)
            await session.commit()

    asyncio.run(_insert_inactive())

    # The request should 404 (not resolve the inactive agent).
    resp = client.post(
        "/api/v1/internal/agent-chat/inactive-agent",
        json={"message": "hello"},
    )

    assert resp.status_code == 404
    assert invoker.calls == []
    asyncio.run(engine.dispose())


def test_a_totally_unknown_agent_is_still_404():
    """Regression: an agent that exists neither in the static registry nor the
    DB should still be a 404."""
    invoker = FakeInvoker()
    app, _, engine = _build_app(founder=_founder(roles=["founder"]), invoker=invoker)
    client = TestClient(app)

    resp = client.post(
        "/api/v1/internal/agent-chat/totally-unknown-agent",
        json={"message": "hello"},
    )

    assert resp.status_code == 404
    assert invoker.calls == []
    asyncio.run(engine.dispose())
