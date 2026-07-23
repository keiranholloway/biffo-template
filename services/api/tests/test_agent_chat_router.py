"""Integration tests for the generic chat endpoint
(/api/v1/agent-chat/{agent_key}, ADR-0017 §3).

Proves the generic ingress runs a turn for any registered agent, gated by the
*agent's own* required_group (not a fixed role): the prompt assistant needs admin
and keeps its library-awareness through this route, while a founder-gated agent
needs founder. Unknown agents 404; the Core->runtime invoke is faked.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.agent_assistant import ASSISTANT_SYSTEM_PROMPT, LIBRARY_OPEN, UNTRUSTED_OPEN
from api.chat_agents import ChatAgent, register_chat_agent
from api.chat_engine import ChatTurnResult
from api.database import get_db
from api.middleware.auth import AuthenticatedUser, require_auth
from api.models.agent_run import AgentRun  # noqa: F401 — registers the table on Base.metadata
from api.models.base import Base
from api.models.orchestration import WorkflowDefinition  # noqa: F401 — registers the table
from api.models.prompt_component import PromptComponent  # noqa: F401 — registers the table
from api.routers import agent_chat as agent_chat_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

# A founder-gated agent with no context assembler — proves the gate is the agent's
# own group and that an agent without special context runs a plain turn.
_FOUNDER_AGENT_KEY = "test-founder-agent"
_FOUNDER_PROMPT = "You are a founder-facing test agent."


def _register_founder_agent() -> None:
    register_chat_agent(
        _FOUNDER_AGENT_KEY,
        lambda: ChatAgent(
            agent_key=_FOUNDER_AGENT_KEY,
            agent_name=_FOUNDER_AGENT_KEY,
            system_prompt=_FOUNDER_PROMPT,
            model="test/model",
            required_group="founder",
            max_history_messages=40,
            max_output_tokens=256,
            timeout_seconds=10.0,
        ),
    )


_register_founder_agent()


def _caller(*, roles: list[str], tenant_id: str = "default") -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="caller-sub",
        email="c@example.com",
        username="caller",
        tenant_id=tenant_id,
        roles=roles,
        user_id="user-123",
    )


class FakeInvoker:
    def __init__(self, *, result: ChatTurnResult | None = None):
        self.calls: list[dict] = []
        self.result = result or ChatTurnResult(
            content="a buffered reply", model="test/model", finish_reason="stop", output_tokens=7
        )

    def invoke_chat_turn(self, *, model, messages, max_output_tokens, timeout_seconds):
        self.calls.append({"model": model, "messages": messages})
        return self.result


def _build_app(
    *, caller: AuthenticatedUser, invoker: FakeInvoker | None = None
) -> tuple[FastAPI, async_sessionmaker, AsyncEngine, FakeInvoker]:
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
    invoker = invoker or FakeInvoker()

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    fastapi = FastAPI()
    fastapi.include_router(agent_chat_router.router, prefix="/api/v1")
    fastapi.dependency_overrides[get_db] = override_get_db
    fastapi.dependency_overrides[require_auth] = lambda: caller
    fastapi.dependency_overrides[agent_chat_router._get_runtime_invoker] = lambda: invoker
    return fastapi, session_factory, engine, invoker


@pytest.fixture
def admin_app() -> Generator[tuple[TestClient, async_sessionmaker, FakeInvoker]]:
    fastapi, sf, engine, invoker = _build_app(caller=_caller(roles=["admin"]))
    yield TestClient(fastapi), sf, invoker
    asyncio.run(engine.dispose())


async def _load_run(session_factory: async_sessionmaker, run_id: str) -> AgentRun:
    async with session_factory() as session:
        run = await session.get(AgentRun, run_id)
        assert run is not None
        return run


# ── the prompt assistant, served by the generic route ───────────────────────────


def test_prompt_assistant_runs_through_the_generic_route_for_an_admin(admin_app):
    client, session_factory, _ = admin_app

    resp = client.post("/api/v1/agent-chat/prompt-assistant", json={"message": "help me draft"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reply"] == "a buffered reply"
    run = asyncio.run(_load_run(session_factory, body["run_id"]))
    assert run.run_as_kind == "user"
    assert run.run_as_user_id == "user-123"
    assert run.agent_name == "prompt-assistant"


def test_the_generic_route_still_applies_the_prompt_assistants_library_context(admin_app):
    client, session_factory, invoker = admin_app

    # Seed a component; the context assembler must fire on the generic route too.
    async def _seed() -> None:
        async with session_factory() as session:
            session.add(PromptComponent(tenant_id="default", name="house-tone", body="B"))
            await session.commit()

    asyncio.run(_seed())
    client.post("/api/v1/agent-chat/prompt-assistant", json={"message": "what can I reuse?"})

    messages = invoker.calls[-1]["messages"]
    assert messages[0]["content"] == ASSISTANT_SYSTEM_PROMPT  # its own system prompt
    assert any(m["content"].lstrip().startswith(LIBRARY_OPEN) for m in messages)  # library block


def test_a_non_admin_is_forbidden_from_the_admin_agent():
    fastapi, _, engine, invoker = _build_app(caller=_caller(roles=["founder"]))
    client = TestClient(fastapi)

    resp = client.post("/api/v1/agent-chat/prompt-assistant", json={"message": "hi"})

    assert resp.status_code == 403  # prompt-assistant requires the admin group
    assert invoker.calls == []
    asyncio.run(engine.dispose())


# ── a founder-gated agent: the gate is the agent's own group ─────────────────────


def test_a_founder_can_use_a_founder_gated_agent_with_a_plain_turn():
    fastapi, session_factory, engine, invoker = _build_app(caller=_caller(roles=["founder"]))
    client = TestClient(fastapi)

    resp = client.post(f"/api/v1/agent-chat/{_FOUNDER_AGENT_KEY}", json={"message": "my idea"})

    assert resp.status_code == 200, resp.text
    messages = invoker.calls[-1]["messages"]
    # the agent's OWN system prompt, then just the fenced user turn (no library block)
    assert [m["role"] for m in messages] == ["system", "user"]
    assert messages[0]["content"] == _FOUNDER_PROMPT
    assert messages[-1]["content"].startswith(UNTRUSTED_OPEN)
    assert "my idea" in messages[-1]["content"]
    asyncio.run(engine.dispose())


def test_a_non_founder_is_forbidden_from_the_founder_agent():
    fastapi, _, engine, invoker = _build_app(caller=_caller(roles=["admin"]))
    client = TestClient(fastapi)

    # admin is not founder — the gate is the agent's required_group, not "any elevated role".
    resp = client.post(f"/api/v1/agent-chat/{_FOUNDER_AGENT_KEY}", json={"message": "hi"})

    assert resp.status_code == 403
    assert invoker.calls == []
    asyncio.run(engine.dispose())


# ── unknown agent ───────────────────────────────────────────────────────────────


def test_an_unknown_agent_key_is_404():
    fastapi, _, engine, invoker = _build_app(caller=_caller(roles=["admin"]))
    client = TestClient(fastapi)

    resp = client.post("/api/v1/agent-chat/no-such-agent", json={"message": "hi"})

    assert resp.status_code == 404
    assert invoker.calls == []
    asyncio.run(engine.dispose())
