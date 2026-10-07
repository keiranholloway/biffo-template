"""Chat threads must not repeat earlier turns: each run stores only what its turn
added, and history / the thread read agree on that one shape (old cumulative
threads still read back once)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from api import agent_chat_service
from api.agent_chat_service import run_chat_turn
from api.agent_runs import list_thread_runs
from api.chat_agents import ChatAgent, TurnContext
from api.chat_engine import ChatTurnResult, thread_conversation
from api.models.agent_run import AgentRun
from api.models.base import Base
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_AGENT = ChatAgent(
    agent_key="k",
    agent_name="k-agent",
    system_prompt="sys",
    model="m",
    required_group="g",
    max_history_messages=40,
    max_output_tokens=100,
    timeout_seconds=5,
)


class _Invoker:
    def __init__(self) -> None:
        self.seen: list[list[dict]] = []

    def invoke_chat_turn(self, *, model, messages, max_output_tokens, timeout_seconds):
        self.seen.append(list(messages))
        return ChatTurnResult(content=f"a{len(self.seen)}", model=model)


def _contents(msgs: list[dict]) -> list[str]:
    return [m["content"] for m in msgs if m["role"] in ("user", "assistant")]


def _strip(text: str) -> str:
    return text.replace("<untrusted-context>\n", "").replace("\n</untrusted-context>", "")


def test_three_real_turns_store_and_replay_each_message_once():
    async def go():
        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        invoker = _Invoker()
        thread = None
        stamped: dict[str, datetime] = {}
        async with factory() as db:
            for n in (1, 2, 3):
                resp = await run_chat_turn(
                    db,
                    agent=_AGENT,
                    tenant_id="default",
                    run_as_user_id="u",
                    message=f"u{n}",
                    thread_id=thread,
                    invoker=invoker,
                    context=TurnContext(),
                )
                thread = getattr(resp, "thread_id", None)
                assert thread is not None
                await db.commit()
                # SQLite timestamps can tie within one instant; give each run a
                # distinct created_at so ordering is deterministic.
                for run in await list_thread_runs(db, tenant_id="default", thread_id=thread):
                    if run.created_at is None or run.id not in stamped:
                        stamped[run.id] = datetime(2026, 1, 1, 0, 0, n, tzinfo=UTC)
                        run.created_at = stamped[run.id]
                await db.commit()
            runs = await list_thread_runs(db, tenant_id="default", thread_id=thread)
        await engine.dispose()
        return invoker, runs

    invoker, runs = asyncio.run(go())
    # history assembled for turn 3 (system + u1 a1 u2 a2 + new u3)
    turn3 = [_strip(c) for c in _contents(invoker.seen[2])]
    assert turn3 == ["u1", "a1", "u2", "a2", "u3"]
    # each run stores only its own turn
    assert [len(r.messages) for r in runs] == [2, 2, 2]
    # the thread read
    assert [_strip(c) for c in _contents(thread_conversation(runs))] == [
        "u1",
        "a1",
        "u2",
        "a2",
        "u3",
        "a3",
    ]
    assert agent_chat_service.turn_delta is not None


def _old_run(at: int, messages: list[dict]) -> AgentRun:
    return AgentRun(
        id=str(uuid.uuid4()),
        tenant_id="default",
        agent_name="k-agent",
        status="completed",
        thread_id="t",
        messages=messages,
        created_at=datetime(2026, 1, 1, 0, 0, at, tzinfo=UTC),
    )


def _m(role: str, content: str) -> dict:
    return {"role": role, "content": content}


def test_old_cumulative_shape_reads_back_without_repeats():
    s = _m("system", "sys")
    runs = [
        _old_run(1, [s, _m("user", "u1"), _m("assistant", "a1")]),
        _old_run(
            2, [s, _m("user", "u1"), _m("assistant", "a1"), _m("user", "u2"), _m("assistant", "a2")]
        ),
        _old_run(
            3,
            [
                s,
                *[_m("user", "u1"), _m("assistant", "a1")] * 2,
                _m("user", "u2"),
                _m("assistant", "a2"),
                _m("user", "u3"),
                _m("assistant", "a3"),
            ],
        ),
    ]
    assert _contents(thread_conversation(runs)) == ["u1", "a1", "u2", "a2", "u3", "a3"]
