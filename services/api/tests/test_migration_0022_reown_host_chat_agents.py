"""Migration 0022 re-owns 'host' plugin_chat_agents rows (host row wins)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

_PATH = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "versions"
    / "0022_reown_host_chat_agents.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("mig0022", _PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _engine() -> sa.Engine:
    eng = sa.create_engine("sqlite://")
    with eng.begin() as c:
        c.execute(
            sa.text(
                "CREATE TABLE plugin_chat_agents (id TEXT PRIMARY KEY, "
                "tenant_id TEXT, plugin_name TEXT, agent_key TEXT, agent_name TEXT, "
                "role TEXT, system_prompt TEXT, model TEXT, required_group TEXT, "
                "active BOOLEAN, max_history_messages INT, max_output_tokens INT, "
                "timeout_seconds FLOAT)"
            )
        )
        c.execute(
            sa.text(
                "CREATE TABLE plugin_chat_agent_history (id TEXT PRIMARY KEY, "
                "plugin_chat_agent_id TEXT, plugin_name TEXT, version INT)"
            )
        )
        c.execute(
            sa.text(
                "CREATE TABLE agent_runs (id TEXT PRIMARY KEY, "
                "prompt_version_id TEXT, prompt_version INT)"
            )
        )
    return eng


def _agent(c, sid, plugin, key, prompt, tenant="default"):
    c.execute(
        sa.text(
            "INSERT INTO plugin_chat_agents VALUES "
            "(:id, :t, :p, :k, 'n', 'r', :prompt, 'm', 'g', 1, 40, 4096, 20.0)"
        ),
        {"id": sid, "t": tenant, "p": plugin, "k": key, "prompt": prompt},
    )


def _run(eng, mod):
    with eng.begin() as c:
        ctx = MigrationContext.configure(c)
        with Operations.context(ctx):
            mod.upgrade()


def test_reowns_dedups_and_leaves_no_host_rows() -> None:
    eng = _engine()
    with eng.begin() as c:
        _agent(c, "h1", "host", "ideation-brainstorm-qualifier", "new")
        _agent(c, "h2", "host", "ideation-analyst", "host-prompt")
        _agent(c, "p2", "ideation", "ideation-analyst", "old")
        _agent(c, "h3", "host", "idea-scout-a", "scout")
        for hid, aid, pn, v in (
            ("x1", "h2", "host", 1),
            ("x2", "p2", "ideation", 1),
            ("x3", "h1", "host", 1),
        ):
            c.execute(
                sa.text("INSERT INTO plugin_chat_agent_history VALUES (:i, :a, :pn, :v)"),
                {"i": hid, "a": aid, "pn": pn, "v": v},
            )
        c.execute(sa.text("INSERT INTO agent_runs VALUES ('r1', 'h2', 1)"))
    _run(eng, _load())
    with eng.connect() as c:
        rows = {
            r.agent_key: (r.plugin_name, r.system_prompt)
            for r in c.execute(sa.text("SELECT * FROM plugin_chat_agents"))
        }
        assert rows == {
            "ideation-brainstorm-qualifier": ("ideation", "new"),
            "ideation-analyst": ("ideation", "host-prompt"),
            "idea-scout-a": ("idea-scout", "scout"),
        }
        hist = c.execute(
            sa.text(
                "SELECT plugin_chat_agent_id, version FROM plugin_chat_agent_history "
                "WHERE id = 'x1'"
            )
        ).one()
        assert tuple(hist) == ("p2", 2)
        run = c.execute(sa.text("SELECT prompt_version_id, prompt_version FROM agent_runs")).one()
        assert tuple(run) == ("p2", 2)
        assert (
            c.execute(
                sa.text("SELECT COUNT(*) FROM plugin_chat_agent_history WHERE plugin_name = 'host'")
            ).scalar()
            == 0
        )


def test_unmapped_host_row_fails_loudly() -> None:
    eng = _engine()
    with eng.begin() as c:
        _agent(c, "h1", "host", "mystery-agent", "x")
    with pytest.raises(RuntimeError, match="mystery-agent"):
        _run(eng, _load())
