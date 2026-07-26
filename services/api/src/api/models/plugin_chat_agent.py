"""Admin-managed, live-editable plugin chat agents (ADR-0017 seam #1 extension).

A PluginChatAgent is a chat agent config an admin can create/edit at runtime,
without a redeploy — the live counterpart to a plugin manifest's static
``chat_agents`` declaration. A plugin opts in via its manifest's
``chat_agents_dynamic: true`` flag (see routing/chat_agent_registration.py);
for an opted-in plugin, internal_agent_chat.py falls back to this table when
an agent_key isn't found in the static registry, so an admin can add brand-new
agent keys the registry never saw at cold-start — something the static
_BUILDERS dict (populated once, by known key, at import time) structurally
cannot support.

Mutable in place, like PromptComponent (ADR-0015 §3) — editing a row changes
behavior on the next chat turn, which is the entire point.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import TenantScopedModel


class PluginChatAgent(TenantScopedModel):
    """A live-editable chat agent for one plugin (ADR-0017 seam #1 extension)."""

    __tablename__ = "plugin_chat_agents"
    __table_args__ = (
        UniqueConstraint("tenant_id", "plugin_name", "agent_key", name="uq_plugin_chat_agent_key"),
    )

    plugin_name: Mapped[str] = mapped_column(String(100), nullable=False)
    agent_key: Mapped[str] = mapped_column(String(100), nullable=False)
    agent_name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    required_group: Mapped[str] = mapped_column(String(100), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_history_messages: Mapped[int] = mapped_column(Integer, nullable=False, default=40)
    max_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=1024)
    timeout_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=20.0)
