"""Background jobs for product domains (domain_jobs.py, ADR-0030)."""

import json
from typing import Any, cast

import api.database as database
import api.domain_jobs as jobs
import pytest
from sqlalchemy.ext.asyncio import AsyncSession


class _FakeSession:
    def __init__(self, fail: bool = False) -> None:
        self.info: dict[str, Any] = {}
        self.fail = fail

    async def commit(self) -> None:
        if self.fail:
            raise RuntimeError("commit failed")

    async def rollback(self) -> None:
        pass


class _Ctx:
    function_name = "proj-dev-core-api"
    memory_limit_in_mb = 128
    invoked_function_arn = "arn:aws:lambda:eu-west-2:1:function:proj-dev-core-api"
    aws_request_id = "req-1"


_CTX = cast(Any, _Ctx())


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(jobs, "_REGISTRY", {})
    monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME", raising=False)


@pytest.fixture
def fake_session(monkeypatch):
    holder: dict[str, _FakeSession] = {}

    class _Ctx:
        async def __aenter__(self):
            return holder["s"]

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(database, "AsyncSessionLocal", lambda: _Ctx())
    return holder


async def _drive_get_db(session: _FakeSession, holder, body):
    holder["s"] = session
    gen = database.get_db()
    s = await gen.__anext__()
    body(cast(AsyncSession, s))
    try:
        await gen.__anext__()
    except StopAsyncIteration:
        pass


async def test_inline_job_runs_with_payload_after_commit(fake_session):
    seen: list[dict] = []
    jobs.register_job("demo", seen.append)
    sess = _FakeSession()

    def body(db):
        jobs.enqueue_job(db, "demo", {"a": 1})
        assert seen == []  # not before commit

    await _drive_get_db(sess, fake_session, body)
    assert seen == [{"a": 1}]


async def test_nothing_enqueued_on_rollback(fake_session):
    seen: list[dict] = []
    jobs.register_job("demo", seen.append)
    sess = _FakeSession(fail=True)
    with pytest.raises(RuntimeError):
        await _drive_get_db(sess, fake_session, lambda db: jobs.enqueue_job(db, "demo", {"a": 1}))
    assert seen == []


def test_unknown_job_fails_loudly_on_enqueue():
    with pytest.raises(jobs.UnknownJobError):
        jobs.enqueue_job(cast(AsyncSession, _FakeSession()), "nope", {})


async def test_lambda_dispatch_invokes_self_async(monkeypatch):
    jobs.register_job("demo", lambda p: None)
    calls: list[dict] = []

    class _L:
        def invoke(self, **kw):
            calls.append(kw)

    monkeypatch.setattr(jobs, "_lambda", lambda: _L())
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "proj-dev-core-api")
    db = _FakeSession()
    jobs.enqueue_job(cast(AsyncSession, db), "demo", {"x": 2})
    assert await jobs.dispatch_pending_jobs(cast(AsyncSession, db)) == 1
    assert calls[0]["FunctionName"] == "proj-dev-core-api"
    assert calls[0]["InvocationType"] == "Event"
    assert json.loads(calls[0]["Payload"]) == {
        "source": "biffo:domain-job",
        "job": "demo",
        "payload": {"x": 2},
    }


def test_lambda_handler_routes_job_event():
    import api.main as main

    seen: list[dict] = []
    jobs.register_job("demo", seen.append)
    out = main.lambda_handler(
        {"source": "biffo:domain-job", "job": "demo", "payload": {"k": "v"}}, _CTX
    )
    assert out == {"job": "demo", "status": "completed"}
    assert seen == [{"k": "v"}]


def test_lambda_handler_unknown_job_raises_not_http():
    import api.main as main

    with pytest.raises(jobs.UnknownJobError):
        main.lambda_handler({"source": "biffo:domain-job", "job": "ghost", "payload": {}}, _CTX)
