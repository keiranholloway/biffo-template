"""re-own plugin_chat_agents rows stored under plugin_name 'host'

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-03

Startup handlers under the shared plugin host called Core without the
``X-Biffo-Plugin`` header, so self-seeded rows landed under
``plugin_name = 'host'`` (#2200 fixed the seeding; this migrates what it left).

* Each ``host`` row is re-owned by ``agent_key`` prefix (``ideation-*`` ->
  ``ideation``, ``idea-scout-*`` -> ``idea-scout``).
* Where the plugin already owns the same ``(tenant, agent_key)``, the ``host``
  row wins: its content is copied onto the plugin-owned row, its history is
  appended to that row's history and its agent_runs references repointed, and
  the ``host`` row is deleted.
* An unmapped ``host`` row fails the migration loudly.

The downgrade is a no-op: the original ownership is not recoverable.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HOST = "host"
# Longest/most specific prefixes first.
_PREFIX_TO_PLUGIN: tuple[tuple[str, str], ...] = (
    ("idea-scout-", "idea-scout"),
    ("ideation-", "ideation"),
)


def _owner(agent_key: str) -> str | None:
    for prefix, plugin in _PREFIX_TO_PLUGIN:
        if agent_key.startswith(prefix):
            return plugin
    return None


def upgrade() -> None:
    conn = op.get_bind()
    host_rows = conn.execute(
        sa.text(
            "SELECT id, tenant_id, agent_key, agent_name, role, system_prompt, "
            "model, required_group, active, max_history_messages, "
            "max_output_tokens, timeout_seconds "
            "FROM plugin_chat_agents WHERE plugin_name = :host"
        ),
        {"host": _HOST},
    ).mappings().all()

    unmapped = [r["agent_key"] for r in host_rows if _owner(r["agent_key"]) is None]
    if unmapped:
        raise RuntimeError(
            "plugin_chat_agents rows under plugin_name 'host' have no owning-plugin "
            f"prefix mapping: {sorted(unmapped)}. Extend _PREFIX_TO_PLUGIN or re-own "
            "them by hand before migrating."
        )

    for row in host_rows:
        plugin = _owner(row["agent_key"])
        target_id = conn.execute(
            sa.text(
                "SELECT id FROM plugin_chat_agents "
                "WHERE tenant_id = :tenant_id AND plugin_name = :plugin "
                "AND agent_key = :agent_key"
            ),
            {"tenant_id": row["tenant_id"], "plugin": plugin, "agent_key": row["agent_key"]},
        ).scalar()

        if target_id is None:
            conn.execute(
                sa.text("UPDATE plugin_chat_agents SET plugin_name = :plugin WHERE id = :sid"),
                {"plugin": plugin, "sid": row["id"]},
            )
            conn.execute(
                sa.text(
                    "UPDATE plugin_chat_agent_history SET plugin_name = :plugin "
                    "WHERE plugin_chat_agent_id = :sid"
                ),
                {"plugin": plugin, "sid": row["id"]},
            )
            continue

        # Duplicate: host content wins, copied onto the plugin-owned row.
        conn.execute(
            sa.text(
                "UPDATE plugin_chat_agents SET agent_name = :agent_name, role = :role, "
                "system_prompt = :system_prompt, model = :model, "
                "required_group = :required_group, active = :active, "
                "max_history_messages = :max_history_messages, "
                "max_output_tokens = :max_output_tokens, "
                "timeout_seconds = :timeout_seconds WHERE id = :sid"
            ),
            {
                "agent_name": row["agent_name"],
                "role": row["role"],
                "system_prompt": row["system_prompt"],
                "model": row["model"],
                "required_group": row["required_group"],
                "active": row["active"],
                "max_history_messages": row["max_history_messages"],
                "max_output_tokens": row["max_output_tokens"],
                "timeout_seconds": row["timeout_seconds"],
                "sid": target_id,
            },
        )
        # Append the host row's history after the target's, keeping versions unique.
        offset = (
            conn.execute(
                sa.text(
                    "SELECT MAX(version) FROM plugin_chat_agent_history "
                    "WHERE plugin_chat_agent_id = :tid"
                ),
                {"tid": target_id},
            ).scalar()
            or 0
        )
        hist_ids = conn.execute(
            sa.text(
                "SELECT id, version FROM plugin_chat_agent_history "
                "WHERE plugin_chat_agent_id = :sid ORDER BY version"
            ),
            {"sid": row["id"]},
        ).all()
        for hid, hver in hist_ids:
            conn.execute(
                sa.text(
                    "UPDATE plugin_chat_agent_history SET plugin_chat_agent_id = :tid, "
                    "plugin_name = :plugin, version = :version WHERE id = :hid"
                ),
                {"tid": target_id, "plugin": plugin, "version": hver + offset, "hid": hid},
            )
        # Runs that recorded the host row's generation now point at the survivor.
        conn.execute(
            sa.text(
                "UPDATE agent_runs SET prompt_version_id = :tid, "
                "prompt_version = prompt_version + :offset "
                "WHERE prompt_version_id = :sid AND prompt_version IS NOT NULL"
            ),
            {"tid": target_id, "offset": offset, "sid": row["id"]},
        )
        conn.execute(
            sa.text("UPDATE agent_runs SET prompt_version_id = :tid WHERE prompt_version_id = :sid"),
            {"tid": target_id, "sid": row["id"]},
        )
        conn.execute(
            sa.text("DELETE FROM plugin_chat_agents WHERE id = :sid"),
            {"sid": row["id"]},
        )


def downgrade() -> None:
    """Irreversible: which rows were originally under 'host' is not recorded."""
