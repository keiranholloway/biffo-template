"""Edit history for live-editable plugin chat agents (ADR-0017 seam #1 extension).

Stores the **previous** values of a PluginChatAgent whenever one is updated, keyed
by (tenant_id, plugin_chat_agent_id, version). Together with the current row,
this table reconstructs the full timeline of changes: who made each edit, when,
and what values came before.

Deliberately denormalised: stores plugin_name and agent_key alongside the agent
row id so history can be queried and understood even after the agent is deleted,
and so a history query does not require joining back to the (possibly deleted) row.

The version number is a monotonic counter per agent, starting at 1, so an admin
has a stable label for each change ("roll back to version 3"). The timestamp
comes from created_at (inherited from TenantScopedModel), which records the
moment the change happened.

Reads via the history endpoint (GET /admin/plugins/.../chat-agents/.../history)
are tenant-scoped and admin-gated, exactly like the agent-edit routes.
"""

from sqlalchemy import Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel


class PluginChatAgentHistory(TenantScopedModel):
    """The previous values of a PluginChatAgent at the moment of edit."""

    __tablename__ = "plugin_chat_agent_history"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "plugin_chat_agent_id",
            "version",
            name="uq_plugin_chat_agent_history_agent_version",
        ),
    )

    # The row this history entry is history for (not a hard FK — history survives
    # row deletion). Indexed for fast lookup of an agent's full history.
    plugin_chat_agent_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    # Denormalised so history can be queried without joining the (possibly deleted) row.
    plugin_name: Mapped[str] = mapped_column(String(100), nullable=False)
    agent_key: Mapped[str] = mapped_column(String(100), nullable=False)

    # Monotonic counter per agent, starting at 1 for the first edit.
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    # The **previous** values — what the row held before this change.
    agent_name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    required_group: Mapped[str] = mapped_column(String(100), nullable=False)
    active: Mapped[bool] = mapped_column(nullable=False)
    max_history_messages: Mapped[int] = mapped_column(nullable=False)
    max_output_tokens: Mapped[int] = mapped_column(nullable=False)
    timeout_seconds: Mapped[float] = mapped_column(nullable=False)

    # The identity of the admin who made the change (email preferred, falling back to sub).
    changed_by: Mapped[str] = mapped_column(String(255), nullable=False)
